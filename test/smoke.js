#!/usr/bin/env node
/**
 * Smoke-тест моста: поднимает server.js с фейковой pi, подключается WS-клиентом,
 * проверяет hello, get_state/get_messages, отправку prompt и поток событий.
 * Запуск: node test/smoke.js   (или npm test)
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 8799;
const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    PI_BRIDGE_CMD: 'node',
    PI_BRIDGE_ARGS: path.join(__dirname, 'fake-pi.js'),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const events = [];
let gotHello = false, gotState = false, gotMessages = false;

function fail(msg) { console.error('FAIL:', msg); cleanup(1); }
function pass(msg) { console.log('PASS:', msg); }

function cleanup(code) {
  try { ws && ws.close(); } catch {}
  server.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}

let ws;
const timer = setTimeout(() => fail('timeout, собранные события: ' + JSON.stringify(events.map(e => e.type))), 8000);

function waitFor(pred, label, next) {
  const iv = setInterval(() => {
    if (pred()) { clearInterval(iv); next(); }
  }, 50);
  setTimeout(() => { if (!pred()) { clearInterval(iv); fail('не дождались: ' + label); } }, 5000);
}

// stdio=inherit: логи моста идут прямо в консоль теста

setTimeout(() => {
  ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
  ws.on('error', (e) => fail('ws error: ' + e.message));
  ws.on('message', (data) => {
    const o = JSON.parse(data.toString());
    events.push(o);
    if (o.type === 'bridge_hello') gotHello = true;
    if (o.type === 'response' && o.command === 'get_state') {
      gotState = true;
      if (!o.success || o.data.model.name !== 'Fake Model') fail('get_state неожиданный: ' + JSON.stringify(o));
    }
    if (o.type === 'response' && o.command === 'get_messages') {
      gotMessages = true;
      const ms = o.data.messages;
      if (!Array.isArray(ms) || ms.length !== 2) fail('get_messages неожиданный');
    }
    if (o.type === 'agent_settled') {
      // финальная проверка содержимого стрима
      const deltas = events.filter(e => e.type === 'message_update' && e.assistantMessageEvent && e.assistantMessageEvent.type === 'text_delta')
        .map(e => e.assistantMessageEvent.delta).join('');
      if (!deltas.includes('Выполняю тестовый ответ')) fail('дельты текста не дошли: ' + JSON.stringify(deltas));
      const toolEnd = events.find(e => e.type === 'tool_execution_end');
      if (!toolEnd || toolEnd.result.content[0].text !== 'hi') fail('tool_execution_end не дошёл');
      pass('hello=' + gotHello + ', state=' + gotState + ', messages=' + gotMessages);
      pass('стрим text_delta и tool-события ретранслируются');
      console.log('SMOKE OK');
      clearTimeout(timer);
      cleanup(0);
    }
  });
  ws.on('open', () => {
    waitFor(() => gotHello && gotState && gotMessages, 'hello/state/messages', () => {
      // 1) plain text → мост должен обернуть в prompt
      ws.send('тестовый запрос');
      // 2) явная steer-команда
      setTimeout(() => ws.send(JSON.stringify({ id: 's1', type: 'steer', message: 'смени курс' })), 300);
      setTimeout(() => {
        const steerResp = events.find(e => e.type === 'response' && e.command === 'steer');
        if (!steerResp || !steerResp.success) fail('steer не прошёл: ' + JSON.stringify(events.filter(e => e.command === 'steer')));
        pass('steer принят (disposition=' + (steerResp && steerResp.data && steerResp.data.disposition) + ')');
      }, 600);
    });
  });
}, 700);
