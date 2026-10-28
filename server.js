#!/usr/bin/env node
/**
 * pi-bridge — минимальный WebSocket-мост к pi coding agent в RPC-режиме.
 *
 * Что делает:
 *   - держит НЕСКОЛЬКО параллельных сессий: каждая — отдельный процесс
 *     `pi --mode rpc` (перезапуск с backoff при падении);
 *   - события pi (JSONL из stdout) бродкастит только клиентам, привязанным
 *     к этой сессии; команды клиентов пересылает в stdin соответствующего pi;
 *   - сессии: создание (новый процесс), переключение, переименование
 *     (set_session_name, персистентно в pi), удаление (kill + unlink файла
 *     сессии); первая пользовательская фраза автоматически становится именем;
 *   - plain-text от клиента оборачивается в {"type":"prompt","message":...};
 *   - отдаёт index.html, md.js на GET / и /md.js, health-check на /healthz.
 *
 * Управляющие команды клиентов (type начинается с "bridge_"):
 *   bridge_create_session            — новая сессия (новый процесс pi)
 *   bridge_attach {session}          — привязать этот WS к сессии
 *   bridge_rename_session {session,name}
 *   bridge_delete_session {session}  — убить процесс и удалить файл сессии
 *   bridge_list_disk_sessions {force}  — скан каталога сессий pi на диске
 *   bridge_open_session {file}       — открыть файл сессии (spawn pi с --session)
 *
 * Авторизации НЕТ — закрывать nginx'ом (basic auth + TLS). Слушает 0.0.0.0:PORT.
 *
 * Переменные окружения:
 *   PORT              порт HTTP/WS (по умолчанию 8765)
 *   HOST              интерфейс (по умолчанию 0.0.0.0)
 *   PI_BRIDGE_CWD     рабочий каталог pi-сессий (по умолчанию — cwd процесса)
 *   PI_BRIDGE_CMD     команда (по умолчанию "pi"; можно "node" для фейка в тестах)
 *   PI_BRIDGE_ARGS    аргументы через пробел (по умолчанию "--mode rpc")
 *   PI_BRIDGE_SESSION_DIR  если задан — добавит "--session-dir <dir>"
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '8765', 10);
const HOST = process.env.HOST || '0.0.0.0';
const CWD = process.env.PI_BRIDGE_CWD || process.cwd();
const CMD = process.env.PI_BRIDGE_CMD || 'pi';
const ARGS = (process.env.PI_BRIDGE_ARGS || '--mode rpc').split(' ').filter(Boolean);
if (process.env.PI_BRIDGE_SESSION_DIR) {
  ARGS.push('--session-dir', process.env.PI_BRIDGE_SESSION_DIR);
}
// где pi хранит файлы сессий (~/.pi/agent/sessions/--<cwd>--/<ts>_<id>.jsonl);
// при заданном PI_BRIDGE_SESSION_DIR совпадает с ним, иначе — дефолт pi
const SESSIONS_ROOT = process.env.PI_BRIDGE_SESSION_DIR
  ? path.resolve(process.env.PI_BRIDGE_SESSION_DIR)
  : path.join(os.homedir(), '.pi', 'agent', 'sessions');

const sessions = new Map();   // id -> session
const allClients = new Set(); // все ws (для bridge_sessions)
let seq = 0;

function log(...a) { console.log(new Date().toISOString(), ...a); }
function sendTo(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
function broadcastTo(s, obj) {
  let str;
  try { str = JSON.stringify(obj); } catch { return; }
  for (const ws of s.clients) if (ws.readyState === ws.OPEN) ws.send(str);
}

function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter(b => b && (b.type === 'text' || typeof b === 'string'))
      .map(b => typeof b === 'string' ? b : (b.text || '')).join('');
  }
  return c && c.text ? c.text : '';
}

/* base64-данные картинок не нужны клиентам: в get_messages/событиях они
 * превращаются в мегабайты трафика при каждом переподключении, а превью на
 * телефоне всё равно нет (вложение клиент уже видел при отправке).
 * Вырезаем data, метаданные (mimeType, флаг) оставляем. */
function stripImageData(v, depth) {
  if (depth > 12 || v == null) return v;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = stripImageData(v[i], depth + 1);
    return v;
  }
  if (typeof v === 'object') {
    if (v.type === 'image' && typeof v.data === 'string' && v.data) {
      v.data = '';
      v.dataStripped = true;
      return v;
    }
    for (const k in v) stripImageData(v[k], depth + 1);
  }
  return v;
}

function sessionList() {
  return [...sessions.values()].map(s => ({
    id: s.id, name: s.name, alive: !!s.proc,
    streaming: !!s.state.isStreaming,
    file: s.argsTarget || s.state.sessionFile || null,
  }));
}
function broadcastSessions() {
  const msg = JSON.stringify({ type: 'bridge_sessions', sessions: sessionList() });
  for (const ws of allClients) if (ws.readyState === ws.OPEN) ws.send(msg);
}

/* ---------- сессии на диске: скан каталога pi ---------- */

/* RPC-команды «список сессий» у pi нет — сканируем файлы сами.
 * Формат: ~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl; первая строка —
 * заголовок {type:"session", id, cwd, ...}, имя — в записях session_info. */
let diskCache = { at: 0, list: [] };
const DISK_TTL = 30000;

function openSessionFiles() {
  const set = new Set();
  for (const s of sessions.values()) {
    const f = s.argsTarget || s.state.sessionFile;
    if (f) set.add(f);
  }
  return set;
}

async function listDiskSessions(force) {
  if (!force && Date.now() - diskCache.at < DISK_TTL) return diskCache.list;
  let files = [];
  try {
    const root = await fs.promises.readdir(SESSIONS_ROOT, { withFileTypes: true });
    for (const e of root) {
      const p = path.join(SESSIONS_ROOT, e.name);
      if (e.isDirectory()) {
        try {
          const inner = await fs.promises.readdir(p, { withFileTypes: true });
          for (const ie of inner) if (ie.isFile() && ie.name.endsWith('.jsonl')) files.push(path.join(p, ie.name));
        } catch {}
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        files.push(p);
      }
    }
  } catch {
    diskCache = { at: Date.now(), list: [] };
    return [];
  }
  const stats = await Promise.all(files.map(async f => {
    try { const st = await fs.promises.stat(f); return { f, mtime: st.mtimeMs, size: st.size }; } catch { return null; }
  }));
  const sorted = stats.filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, 200);
  const openSet = openSessionFiles();
  const list = [];
  for (const { f, mtime, size } of sorted) {
    const meta = { id: null, cwd: null, name: '', firstText: '', firstDone: false };
    try {
      const content = await fs.promises.readFile(f, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.startsWith('{"type":"')) continue;
        if (!meta.id && line.startsWith('{"type":"session"')) {
          try { const h = JSON.parse(line); meta.id = h.id; meta.cwd = h.cwd; } catch {}
        } else if (line.startsWith('{"type":"session_info"')) {
          try { const si = JSON.parse(line); if (si.name) meta.name = String(si.name); } catch {}
        } else if (!meta.firstDone && line.length < 300000 && line.startsWith('{"type":"message"')) {
          try {
            const en = JSON.parse(line);
            if (en.message && en.message.role === 'user') {
              const t = contentText(en.message.content).trim().replace(/\s+/g, ' ');
              if (t) { meta.firstText = t; meta.firstDone = true; }
            }
          } catch {}
        }
      }
    } catch {}
    const shortName = meta.name || (meta.firstText ? meta.firstText.slice(0, 48) + (meta.firstText.length > 48 ? '…' : '') : '');
    list.push({
      file: f, id: meta.id, cwd: meta.cwd, mtime, size,
      name: shortName || path.basename(f),
      open: openSet.has(f),
    });
  }
  diskCache = { at: Date.now(), list };
  return list;
}

/* ---------- сессия = отдельный процесс pi ---------- */

function createSession(name, extraArgs) {
  const id = 's' + (++seq);
  const s = {
    id, seq,
    name: (name || 'Сессия ' + seq).slice(0, 80),
    proc: null, buf: '', clients: new Set(),
    args: ARGS.concat(extraArgs || []),   // per-session аргументы спавна (напр. --session <file>)
    argsTarget: null,                    // файл сессии, с которым заспавнен pi (для --session)
    named: false,                    // автоимя по первому сообщению уже выставлено
    restarting: false, delayMs: 2000, restartTimer: null, dead: false,
    lastPrompt: null,                // последний user-промпт (для авто-повтора после санации)
    recovering: false, recoverPhase: '', recoverAbortTimer: null, recovTimes: [],
    state: { isStreaming: false, sessionFile: null, sessionId: null, thinkingLevel: null },
  };
  sessions.set(id, s);
  spawnPi(s);
  return s;
}

function spawnPi(s) {
  log(`[pi:${s.id}] spawn: ${CMD} ${s.args.join(' ')} (cwd=${CWD})`);
  let child;
  try {
    child = spawn(CMD, s.args, { cwd: CWD, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    log(`[pi:${s.id}] spawn error:`, e.message);
    broadcastTo(s, { type: 'bridge_status', status: 'pi_error', error: e.message });
    scheduleRestart(s);
    return;
  }
  s.proc = child;
  broadcastTo(s, { type: 'bridge_status', status: 'pi_up', pid: child.pid });
  broadcastSessions();

  // финализация авто-восстановления: pi перезапустился на санированном файле —
  // синхронизируем клиентов и повторяем последний user-промпт
  if (s.recovering && s.recoverPhase === 'restarting') {
    setTimeout(() => {
      if (s.dead || !s.proc) return;
      s.recoverPhase = 'done';
      s.recovering = false;
      broadcastTo(s, { type: 'bridge_status', status: 'recovered' });
      piSend(s, { id: 'sync-' + Date.now(), type: 'get_state' });
      piSend(s, { id: 'sync-' + Date.now(), type: 'get_messages' });
      if (s.lastPrompt) {
        log(`[pi:${s.id}] повтор последнего промпта после санации`);
        piSend(s, { id: 're-' + Date.now(), type: 'prompt', message: s.lastPrompt });
        s.lastPrompt = null;
      }
    }, 2500);
  }

  // backoff сбрасываем только после 30с устойчивой работы — иначе быстрый краш-луп
  setTimeout(() => { if (s.proc === child) s.delayMs = 2000; }, 30000);

  child.stdout.on('data', (chunk) => {
    s.buf += chunk.toString('utf8');
    let idx;
    while ((idx = s.buf.indexOf('\n')) >= 0) {
      const line = s.buf.slice(0, idx).replace(/\r$/, '');
      s.buf = s.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch {
        broadcastTo(s, { type: 'bridge_raw', line }); // не-JSON строка — покажем как есть
        continue;
      }
      trackState(s, obj);
      if (!s.recovering && !s.dead && looksBrokenToolEvent(obj)) startRecovery(s, 'маркер в RPC-стриме');
      stripImageData(obj, 0);
      broadcastTo(s, obj);
    }
    if (s.buf.length > 1 << 20) s.buf = '';
  });

  child.stderr.on('data', (c) => {
    const text = c.toString('utf8').trim();
    if (!text) return;
    process.stderr.write(`[pi:${s.id}:stderr] ` + text + '\n');
    broadcastTo(s, { type: 'bridge_stderr', line: text });
  });

  child.on('error', (e) => {
    // например ENOENT — бинарника нет; exit при этом может НЕ прийти
    log(`[pi:${s.id}] error:`, e.message);
    broadcastTo(s, { type: 'bridge_status', status: 'pi_error', error: e.message });
    scheduleRestart(s);
  });

  child.on('exit', (code, signal) => {
    log(`[pi:${s.id}] exited code=${code} signal=${signal}`);
    if (s.dead) return;
    scheduleRestart(s, { code, signal });
  });
}

function scheduleRestart(s, extra) {
  if (s.restarting || s.dead) return; // error и exit могут прийти оба — рестартим один раз
  s.restarting = true;
  s.proc = null;
  broadcastTo(s, Object.assign({ type: 'bridge_status', status: 'pi_down' }, extra || {}));
  s.restartTimer = setTimeout(() => {
    s.restarting = false;
    if (!s.dead) spawnPi(s);
  }, s.delayMs);
  s.delayMs = Math.min(s.delayMs * 2, 15000);
  broadcastSessions();
}

function piSend(s, obj) {
  if (!s.proc || !s.proc.stdin.writable) return false;
  try {
    s.proc.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  } catch (e) {
    log(`[pi:${s.id}] stdin write failed:`, e.message);
    return false;
  }
}

function stopSessionProc(s) {
  if (!s.proc) return;
  try { s.proc.stdin.end(); } catch {} // orderly shutdown: закрыть stdin
  const child = s.proc;
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
}

function deleteSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  s.dead = true;
  if (s.restartTimer) clearTimeout(s.restartTimer);
  const file = s.state.sessionFile;
  diskCache.at = 0; // список на диске изменился (файл будет удалён)
  stopSessionProc(s);
  sessions.delete(id);
  if (file) fs.unlink(file, () => {}); // удалить файл сессии с диска (best effort)
  log(`[session] deleted ${s.id} (${s.name})${file ? ', file: ' + file : ''}`);
  // выжившие клиенты — перепривязываем к оставшейся сессии
  const remaining = [...sessions.values()];
  for (const ws of s.clients) {
    if (remaining.length) attach(ws, remaining[0]);
    else attach(ws, createSession());
  }
  broadcastSessions();
  return true;
}

/* ---------- страховка «Tool not found»: детект → abort → санация → рестарт ----------
 *
 * Симптом: модель иногда отдаёт tool_call с пустыми id и name; pi пишет битую запись,
 * результат инструмента становится текстом "Tool  not found" (именно ДВА пробела —
 * маркер), а сессия после resume уже не продолжается. Лечим: abort, вырезание битой
 * пары из файла сессии, рестарт pi с --session на санированном файле, повтор промпта. */
const TOOL_NOT_FOUND = 'Tool  not found';

function isBrokenToolCall(b) {
  return !!b && typeof b === 'object' && (b.type === 'toolCall' || b.type === 'toolcall') && !b.id && !b.name;
}

function looksBrokenToolEvent(obj) {
  if (obj.type === 'tool_execution_start' && !obj.toolCallId) return true;
  if (obj.type === 'tool_execution_end') {
    if (!obj.toolCallId) return true;
    const r = obj.result || {};
    const text = Array.isArray(r.content)
      ? r.content.filter(b => b && b.type === 'text').map(b => b.text).join('\n')
      : '';
    if (text.indexOf(TOOL_NOT_FOUND) >= 0) return true;
  }
  if (obj.type === 'message_update' && obj.assistantMessageEvent && obj.assistantMessageEvent.type === 'toolcall_end') {
    const tc = obj.assistantMessageEvent.toolCall || {};
    if (!tc.id && !tc.name) return true;
  }
  return false;
}

function startRecovery(s, reason) {
  if (s.recovering || s.dead) return;
  const now = Date.now();
  s.recovTimes = s.recovTimes.filter(t => now - t < 30 * 60000);
  s.recovTimes.push(now);
  if (s.recovTimes.length > 3) {
    // защита от петли: чиним максимум 3 раза за полчаса, дальше — ручной ремонт
    log(`[pi:${s.id}] recovery skipped: ${s.recovTimes.length}-й раз за 30 мин`);
    broadcastTo(s, { type: 'bridge_status', status: 'recovery_skipped' });
    return;
  }
  s.recovering = true;
  s.recoverPhase = 'aborting';
  log(`[pi:${s.id}] битый tool-call (${reason}): abort → санация → рестарт --session → повтор промпта`);
  broadcastTo(s, { type: 'bridge_status', status: 'recovering', reason });
  piSend(s, { type: 'abort' });
  s.recoverAbortTimer = setTimeout(() => finishAbortPhase(s), 12000); // не дождались settled
}

function finishAbortPhase(s) {
  if (!s.recovering || s.recoverPhase !== 'aborting') return;
  s.recoverPhase = 'restarting';
  if (s.recoverAbortTimer) { clearTimeout(s.recoverAbortTimer); s.recoverAbortTimer = null; }
  const file = s.argsTarget || s.state.sessionFile;
  if (file && fs.existsSync(file)) {
    try {
      const res = sanitizeSessionFile(file);
      log(`[pi:${s.id}] санация ${file}: вырезано записей: ${res.removed}, исправлено сообщений: ${res.repaired}${res.backup ? ', бэкап: ' + res.backup : ''}`);
    } catch (e) {
      log(`[pi:${s.id}] санация не удалась: ${e.message}`);
    }
  } else {
    log(`[pi:${s.id}] файла сессии нет — рестарт без санации`);
  }
  if (file && !s.argsTarget) {
    s.args = ARGS.concat(['--session', file]);
    s.argsTarget = file;
  }
  stopSessionProc(s); // exit → scheduleRestart → spawnPi уже с --session
  // страховка: если процесс не завершился сам — поторопим рестарт
  setTimeout(() => {
    if (!s.dead && !s.proc && !s.restarting && s.recoverPhase === 'restarting') scheduleRestart(s);
  }, 3000);
}

/* Вырезает из файла сессии битую пару (assistant-запись с toolCall с пустыми id и name
 * + следующие за ней toolResult с пустым toolCallId) и dangling toolCall без результата
 * (блок вырезается из сообщения). parentId детей удалённых записей перепривязывается
 * к живому предку, чтобы дерево сессии не сломалось. Оригинал сохраняется в *.bak-toolnotfound. */
function sanitizeSessionFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  const entries = lines.map(l => {
    if (!l.startsWith('{"')) return null;
    try { return JSON.parse(l); } catch { return null; }
  });
  const removed = new Set();
  let repaired = 0;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || e.type !== 'message' || !e.message) continue;
    if (e.message.role !== 'assistant' || !Array.isArray(e.message.content)) continue;
    if (!e.message.content.some(isBrokenToolCall)) continue;
    // ищем битые toolResult до следующего user/assistant сообщения
    const pairIdx = [];
    for (let j = i + 1; j < entries.length; j++) {
      const ej = entries[j];
      if (!ej || ej.type !== 'message' || !ej.message) continue;
      const r = ej.message.role;
      if (r === 'user' || r === 'assistant') break;
      if (r === 'toolResult' && !ej.message.toolCallId) pairIdx.push(j);
    }
    if (pairIdx.length) {
      removed.add(i);
      for (const j of pairIdx) removed.add(j);
    } else {
      // dangling: вырезаем только битый блок из сообщения, запись оставляем
      e.message.content = e.message.content.filter(b => !isBrokenToolCall(b));
      if (!e.message.content.length) e.message.content = [{ type: 'text', text: '[pi-bridge] битый tool-call вырезан при санации' }];
      repaired++;
    }
  }
  // осиротевшие toolResult без toolCallId (на случай, если пара не срослась)
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || e.type !== 'message' || !e.message) continue;
    if (e.message.role === 'toolResult' && !e.message.toolCallId) removed.add(i);
  }

  if (!removed.size && !repaired) return { removed: 0, repaired: 0, backup: null };

  // перепривязка parentId детей удалённых записей к ближайшему живому предку
  const keptIds = new Set();
  entries.forEach((e, i) => { if (e && e.id && !removed.has(i)) keptIds.add(e.id); });
  const liveAncestor = new Map(); // удалённый id -> живой предок (или null)
  const byId = new Map();
  entries.forEach(e => { if (e && e.id) byId.set(e.id, e); });
  const resolveLive = (id) => {
    if (liveAncestor.has(id)) return liveAncestor.get(id);
    let p = id, guard = 0, result = null;
    while (p && guard++ < 10000) {
      const pe = byId.get(p);
      if (!pe) break;
      if (keptIds.has(p) && p !== id) { result = p; break; }
      p = pe.parentId;
    }
    liveAncestor.set(id, result);
    return result;
  };
  const out = [];
  entries.forEach((e, i) => {
    if (!e) { out.push(lines[i]); return; }             // не-JSON строка — как была
    if (removed.has(i)) return;
    if (e.parentId && !keptIds.has(e.parentId) && byId.has(e.parentId)) {
      e.parentId = resolveLive(e.parentId);
    }
    out.push(JSON.stringify(e));
  });

  const backup = file + '.bak-toolnotfound';
  try { fs.copyFileSync(file, backup); } catch {}
  const tmp = file + '.tmp-sanitize';
  fs.writeFileSync(tmp, out.join('\n'));
  fs.renameSync(tmp, file);
  return { removed: removed.size, repaired, backup };
}

/* обновление server-side состояния сессии + автоимя по первому сообщению */
function trackState(s, obj) {
  if (obj.type === 'response' && obj.command === 'get_state' && obj.success && obj.data) {
    s.state.isStreaming = !!obj.data.isStreaming;
    if (obj.data.sessionFile) s.state.sessionFile = obj.data.sessionFile;
    s.state.sessionId = obj.data.sessionId;
    s.state.thinkingLevel = obj.data.thinkingLevel;
    if (obj.data.sessionName && !s.named) { s.named = true; s.name = String(obj.data.sessionName).slice(0, 80); broadcastSessions(); }
    return;
  }
  if (obj.type === 'agent_start') { s.state.isStreaming = true; broadcastSessions(); return; }
  if (obj.type === 'agent_settled') {
    s.state.isStreaming = false;
    broadcastSessions();
    if (s.recovering) finishAbortPhase(s); // abort подтверждён — пора санировать и рестартить
    return;
  }
  if (obj.type === 'message_start' && obj.message && obj.message.role === 'user' && !s.named) {
    const t = contentText(obj.message.content).trim().replace(/\s+/g, ' ');
    if (t) {
      s.named = true;
      s.name = t.slice(0, 48) + (t.length > 48 ? '…' : '');
      piSend(s, { type: 'set_session_name', name: s.name }); // персистентно в файле сессии pi
      broadcastSessions();
    }
  }
}

/* ---------- клиенты ---------- */

function attach(ws, s) {
  // отвязать от текущей сессии
  if (ws.session && ws.session.clients.has(ws)) ws.session.clients.delete(ws);
  ws.session = s;
  s.clients.add(ws);
  sendTo(ws, {
    type: 'bridge_hello', active: s.id, sessions: sessionList(),
    cwd: CWD, cmd: CMD, piRunning: !!s.proc,
  });
  // подтянуть состояние и историю сессии для этого клиента
  piSend(s, { id: 'state-' + Date.now(), type: 'get_state' });
  piSend(s, { id: 'msgs-' + Date.now(), type: 'get_messages' });
}

function handleBridgeCommand(ws, obj) {
  switch (obj.type) {
    case 'bridge_create_session': {
      const s = createSession();
      attach(ws, s);
      broadcastSessions();
      break;
    }
    case 'bridge_attach': {
      const s = sessions.get(obj.session);
      if (!s) { sendTo(ws, { type: 'bridge_error', error: 'нет такой сессии: ' + obj.session }); break; }
      attach(ws, s);
      break;
    }
    case 'bridge_rename_session': {
      const s = sessions.get(obj.session || (ws.session && ws.session.id));
      const name = String(obj.name || '').trim().slice(0, 80);
      if (!s || !name) { sendTo(ws, { type: 'bridge_error', error: 'rename: нужна сессия и непустое имя' }); break; }
      s.name = name;
      s.named = true;
      piSend(s, { type: 'set_session_name', name }); // персистентно в pi
      broadcastSessions();
      break;
    }
    case 'bridge_delete_session': {
      const id = obj.session || (ws.session && ws.session.id);
      if (!sessions.has(id)) { sendTo(ws, { type: 'bridge_error', error: 'нет такой сессии: ' + id }); break; }
      deleteSession(id);
      break;
    }
    case 'bridge_list_disk_sessions': {
      listDiskSessions(!!obj.force)
        .then(list => sendTo(ws, { type: 'bridge_disk_sessions', sessions: list }))
        .catch(e => sendTo(ws, { type: 'bridge_error', error: 'скан сессий: ' + e.message }));
      break;
    }
    case 'bridge_open_session': {
      const file = obj.file ? path.resolve(String(obj.file)) : '';
      if (!file || !file.endsWith('.jsonl')) { sendTo(ws, { type: 'bridge_error', error: 'open: нужен путь к .jsonl' }); break; }
      if (!fs.existsSync(file)) { sendTo(ws, { type: 'bridge_error', error: 'файл сессии не найден: ' + file }); break; }
      const busy = [...sessions.values()].find(x => (x.argsTarget || x.state.sessionFile) === file);
      if (busy) { sendTo(ws, { type: 'bridge_error', error: 'сессия уже открыта в мосте' }); attach(ws, busy); break; }
      const meta = diskCache.list.find(x => x.file === file);
      const s = createSession(meta && meta.name ? meta.name : undefined, ['--session', file]);
      s.argsTarget = file;
      log(`[session] open from disk: ${file}`);
      attach(ws, s);
      diskCache.at = 0; // флаг open в списке устарел
      broadcastSessions();
      break;
    }
    default:
      sendTo(ws, { type: 'bridge_error', error: 'неизвестная команда моста: ' + obj.type });
  }
}

/* ---------- HTTP + WebSocket ---------- */

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    return;
  }
  if (req.method === 'GET' && req.url === '/md.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'md.js')).pipe(res);
    return;
  }
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cwd: CWD, sessions: sessionList() }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  allClients.add(ws);
  log(`[ws] client connected (total=${allClients.size})`);
  // авто-привязка: клиент помнит свою сессию (?session=<id> из localStorage на телефоне);
  // если её нет (удалили) — фолбэк на первую (или создаём)
  let preferred = null;
  try {
    const q = new URL(req.url, 'http://localhost').searchParams.get('session');
    if (q && sessions.has(q)) preferred = sessions.get(q);
  } catch {}
  const first = preferred || [...sessions.values()][0] || createSession();
  attach(ws, first);

  ws.on('message', (data) => {
    const text = data.toString('utf8');
    let obj;
    try { obj = JSON.parse(text); } catch { obj = null; }

    if (!obj || typeof obj !== 'object') {
      // plain text → обычный промпт в текущую сессию
      const s = ws.session;
      if (!s || !s.proc) { sendTo(ws, { type: 'bridge_error', error: 'pi не запущен' }); return; }
      if (s.recovering) { sendTo(ws, { type: 'bridge_error', error: 'идёт восстановление сессии, попробуйте через несколько секунд' }); return; }
      s.lastPrompt = text;
      piSend(s, { id: 'p' + Date.now(), type: 'prompt', message: text });
      return;
    }
    if (typeof obj.type !== 'string') {
      sendTo(ws, { type: 'bridge_error', error: 'JSON без поля "type" не является RPC-командой' });
      return;
    }
    if (/^bridge_/.test(obj.type)) { handleBridgeCommand(ws, obj); return; }

    const s = ws.session;
    if (!s) { sendTo(ws, { type: 'bridge_error', error: 'сессия не выбрана' }); return; }
    if (s.recovering) { sendTo(ws, { type: 'bridge_error', error: 'идёт восстановление сессии, команда отложена: ' + obj.type }); return; }
    if (!s.proc) { sendTo(ws, { type: 'bridge_error', error: 'pi не запущен, команда не отправлена: ' + obj.type }); return; }
    if (obj.type === 'prompt' && typeof obj.message === 'string' && obj.message.trim()) s.lastPrompt = obj.message;
    if (!piSend(s, obj)) sendTo(ws, { type: 'bridge_error', error: 'stdin pi недоступен' });
  });

  ws.on('close', () => {
    allClients.delete(ws);
    if (ws.session) ws.session.clients.delete(ws);
    log(`[ws] client closed (total=${allClients.size})`);
  });
  ws.on('error', () => { try { ws.close(); } catch {} });
});

server.listen(PORT, HOST, () => {
  log(`pi-bridge: http://${HOST}:${PORT}  (page /, ws /ws, health /healthz)`);
  log(`pi cwd: ${CWD}`);
  createSession(); // сессия по умолчанию
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`[bridge] ${sig}, останавливаюсь`);
    for (const s of sessions.values()) stopSessionProc(s);
    setTimeout(() => process.exit(0), 500);
  });
}
