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

function sessionList() {
  return [...sessions.values()].map(s => ({
    id: s.id, name: s.name, alive: !!s.proc,
    streaming: !!s.state.isStreaming,
  }));
}
function broadcastSessions() {
  const msg = JSON.stringify({ type: 'bridge_sessions', sessions: sessionList() });
  for (const ws of allClients) if (ws.readyState === ws.OPEN) ws.send(msg);
}

/* ---------- сессия = отдельный процесс pi ---------- */

function createSession(name) {
  const id = 's' + (++seq);
  const s = {
    id, seq,
    name: (name || 'Сессия ' + seq).slice(0, 80),
    proc: null, buf: '', clients: new Set(),
    named: false,                    // автоимя по первому сообщению уже выставлено
    restarting: false, delayMs: 2000, restartTimer: null, dead: false,
    state: { isStreaming: false, sessionFile: null, sessionId: null, thinkingLevel: null },
  };
  sessions.set(id, s);
  spawnPi(s);
  return s;
}

function spawnPi(s) {
  log(`[pi:${s.id}] spawn: ${CMD} ${ARGS.join(' ')} (cwd=${CWD})`);
  let child;
  try {
    child = spawn(CMD, ARGS, { cwd: CWD, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    log(`[pi:${s.id}] spawn error:`, e.message);
    broadcastTo(s, { type: 'bridge_status', status: 'pi_error', error: e.message });
    scheduleRestart(s);
    return;
  }
  s.proc = child;
  broadcastTo(s, { type: 'bridge_status', status: 'pi_up', pid: child.pid });
  broadcastSessions();

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
  if (obj.type === 'agent_settled') { s.state.isStreaming = false; broadcastSessions(); return; }
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

wss.on('connection', (ws) => {
  allClients.add(ws);
  log(`[ws] client connected (total=${allClients.size})`);
  // авто-привязка: к активной сессии клиента нет — берём первую (или создаём)
  const first = [...sessions.values()][0] || createSession();
  attach(ws, first);

  ws.on('message', (data) => {
    const text = data.toString('utf8');
    let obj;
    try { obj = JSON.parse(text); } catch { obj = null; }

    if (!obj || typeof obj !== 'object') {
      // plain text → обычный промпт в текущую сессию
      const s = ws.session;
      if (!s || !s.proc) { sendTo(ws, { type: 'bridge_error', error: 'pi не запущен' }); return; }
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
    if (!s.proc) { sendTo(ws, { type: 'bridge_error', error: 'pi не запущен, команда не отправлена: ' + obj.type }); return; }
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
