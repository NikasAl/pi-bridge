#!/usr/bin/env node
/**
 * pi-bridge — минимальный WebSocket-мост к pi coding agent в RPC-режиме.
 *
 * Что делает:
 *   - спавнит `pi --mode rpc` и держит процесс (перезапуск с backoff при падении);
 *   - всё, что pi пишет в stdout (JSONL-события), бродкастит всем WS-клиентам как есть;
 *   - JSON-сообщения от WS-клиентов пересылает в stdin pi (strict JSONL);
 *   - plain-text от клиента оборачивает в {"type":"prompt","message":...};
 *   - отдаёт index.html на GET / и health-check на GET /healthz.
 *
 * Авторизации НЕТ — закрывать nginx'ом (basic auth + TLS). Слушает 0.0.0.0:PORT.
 *
 * Переменные окружения:
 *   PORT              порт HTTP/WS (по умолчанию 8765)
 *   HOST              интерфейс (по умолчанию 0.0.0.0)
 *   PI_BRIDGE_CWD     рабочий каталог pi-сессии (по умолчанию — cwd процесса)
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

let pi = null;            // текущий процесс pi
let stdoutBuf = '';       // буфер для строгого JSONL-фрейминга (сплит только по \n)
let restartDelay = 2000;  // backoff перезапуска
let restartScheduled = false;
const clients = new Set();

function scheduleRestart(extra) {
  if (restartScheduled) return;   // error и exit могут прийти оба — рестартим один раз
  restartScheduled = true;
  pi = null;
  broadcast(Object.assign({ type: 'bridge_status', status: 'pi_down' }, extra || {}));
  setTimeout(() => { restartScheduled = false; startPi(); }, restartDelay);
  restartDelay = Math.min(restartDelay * 2, 15000);
}

function log(...a) { console.log(new Date().toISOString(), ...a); }
function broadcast(obj) {
  let s;
  try { s = JSON.stringify(obj); } catch { return; }
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(s);
  }
}
function sendTo(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

/* ---------- управление процессом pi ---------- */

function startPi() {
  log(`[pi] spawn: ${CMD} ${ARGS.join(' ')} (cwd=${CWD})`);
  let child;
  try {
    child = spawn(CMD, ARGS, { cwd: CWD, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    log('[pi] spawn error:', e.message);
    broadcast({ type: 'bridge_status', status: 'pi_error', error: e.message });
    setTimeout(startPi, restartDelay);
    restartDelay = Math.min(restartDelay * 2, 15000);
    return;
  }
  pi = child;
  // backoff сбрасываем только после 30с устойчивой работы — иначе быстрый краш-луп
  setTimeout(() => { if (pi === child) restartDelay = 2000; }, 30000);
  broadcast({ type: 'bridge_status', status: 'pi_up', pid: child.pid });

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).replace(/\r$/, '');
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch {
        broadcast({ type: 'bridge_raw', line }); // не-JSON строка — покажем клиенту как есть
        continue;
      }
      broadcast(obj);
    }
    if (stdoutBuf.length > 1 << 20) stdoutBuf = ''; // защита от распухания без \n
  });

  child.stderr.on('data', (c) => {
    const text = c.toString('utf8').trim();
    if (!text) return;
    process.stderr.write('[pi:stderr] ' + text + '\n');
    broadcast({ type: 'bridge_stderr', line: text });
  });

  child.on('error', (e) => {
    // например ENOENT — бинарника нет; exit при этом может НЕ прийти
    log('[pi] error:', e.message);
    broadcast({ type: 'bridge_status', status: 'pi_error', error: e.message });
    scheduleRestart();
  });

  child.on('exit', (code, signal) => {
    log(`[pi] exited code=${code} signal=${signal}`);
    scheduleRestart({ code, signal });
  });
}

function piSend(obj) {
  if (!pi || !pi.stdin.writable) return false;
  try {
    pi.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  } catch (e) {
    log('[pi] stdin write failed:', e.message);
    return false;
  }
}

function stopPi() {
  if (!pi) return;
  try { pi.stdin.end(); } catch {} // orderly shutdown: закрыть stdin
  const child = pi;
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
}

/* ---------- HTTP + WebSocket ---------- */

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    return;
  }
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, piRunning: !!pi, cwd: CWD }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  clients.add(ws);
  log(`[ws] client connected (total=${clients.size})`);
  sendTo(ws, { type: 'bridge_hello', piRunning: !!pi, cwd: CWD, cmd: CMD });
  // подтянуть состояние и историю сессии для этого клиента
  piSend({ id: 'state-' + Date.now(), type: 'get_state' });
  piSend({ id: 'msgs-' + Date.now(), type: 'get_messages' });

  ws.on('message', (data) => {
    const text = data.toString('utf8');
    let obj;
    try { obj = JSON.parse(text); } catch { obj = null; }
    if (!obj || typeof obj !== 'object') {
      // plain text → обычный промпт
      obj = { id: 'p' + Date.now(), type: 'prompt', message: text };
    } else if (typeof obj.type !== 'string') {
      sendTo(ws, { type: 'bridge_error', error: 'JSON без поля "type" не является RPC-командой' });
      return;
    }
    if (!pi) {
      sendTo(ws, { type: 'bridge_error', error: 'pi не запущен, команда не отправлена: ' + obj.type });
      return;
    }
    if (!piSend(obj)) sendTo(ws, { type: 'bridge_error', error: 'stdin pi недоступен' });
  });

  ws.on('close', () => {
    clients.delete(ws);
    log(`[ws] client closed (total=${clients.size})`);
  });
  ws.on('error', () => clients.delete(ws));
});

server.listen(PORT, HOST, () => {
  log(`pi-bridge: http://${HOST}:${PORT}  (page /, ws /ws, health /healthz)`);
  log(`pi cwd: ${CWD}`);
  startPi();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`[bridge] ${sig}, останавливаюсь`);
    stopPi();
    setTimeout(() => process.exit(0), 500);
  });
}
