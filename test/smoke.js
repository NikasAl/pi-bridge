#!/usr/bin/env node
/**
 * Smoke-тест моста (v2): поднимает server.js с фейковой pi и проверяет:
 *   A) базовый цикл: hello/get_state/get_messages, prompt (plain text), стрим событий;
 *   B) переподключение: строгая проверка, что дельты НЕ задваиваются;
 *   C) мульти-сессии: create/attach/rename/delete + get_session_stats;
 *   D) preferred session: reconnect с ?session=<id> остаётся на своей сессии;
 *   E) md.js: рендер маркдауна и защита от XSS.
 * Запуск: node test/smoke.js   (или npm test)
 */
'use strict';

const assert = require('assert');
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
    PI_BRIDGE_SESSION_DIR: '/tmp/pi-bridge-test-sessions',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
// stdio=inherit: логи моста идут прямо в консоль теста

function cleanup(code) {
  server.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}
let failed = false;
function fail(msg) { console.error('FAIL:', msg); failed = true; cleanup(1); }
function pass(msg) { console.log('PASS:', msg); }

const master = setTimeout(() => fail('общий таймаут теста'), 25000);

/* ---------- D) md.js (чистая функция, без сервера) ---------- */
function testMd() {
  const md = require(path.join(__dirname, '..', 'md.js'));
  const out = md.render('# Заголовок\n\n- пункт 1\n- пункт 2\n\n```js\nlet x = "<b>";\n```\n\nТекст с **жирным**, *курсивом*, `кодом` и [ссылкой](https://example.com).');
  assert.ok(out.includes('<h1>Заголовок</h1>'), 'h1');
  assert.ok(out.includes('<ul>') && out.includes('<li>пункт 1</li>'), 'ul/li');
  assert.ok(out.includes('<pre><code>let x = &quot;&lt;b&gt;&quot;;'), 'fenced code + escape');
  assert.ok(out.includes('<strong>жирным</strong>'), 'bold');
  assert.ok(out.includes('<em>курсивом</em>'), 'em');
  assert.ok(out.includes('<code>кодом</code>'), 'inline code');
  assert.ok(out.includes('<a href="https://example.com"'), 'link');
  const xss = md.render('<script>alert(1)</script> и <img src=x onerror=alert(2)>');
  assert.ok(!xss.includes('<script>'), 'XSS script экранирован');
  assert.ok(!xss.includes('<img'), 'XSS img экранирован');
  assert.ok(xss.includes('&lt;script&gt;'), 'XSS превращён в текст');
  pass('md.js: заголовки/списки/код/инлайн/ссылки + XSS-экранирование');
}

/* ---------- подключение клиента с накоплением событий ---------- */
function makeClient(label, onEvent, url) {
  const ws = new WebSocket(url || ('ws://127.0.0.1:' + PORT + '/ws'));
  const c = { ws, events: [], label };
  ws.on('error', (e) => fail(label + ' ws error: ' + e.message));
  ws.on('message', (data) => {
    const o = JSON.parse(data.toString());
    c.events.push(o);
    if (onEvent) onEvent(o);
  });
  c.waitFor = (pred, what, ms) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const found = c.events.find(pred);
      if (found) { clearInterval(iv); res(found); }
      else if (Date.now() - t0 > (ms || 6000)) { clearInterval(iv); rej(new Error(label + ': не дождались ' + what)); }
    }, 40);
  });
  c.send = (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  c.close = () => { try { ws.close(); } catch {} };
  return c;
}

const textOf = (c, fromIdx) => c.events.slice(fromIdx || 0)
  .filter(e => e.type === 'message_update' && e.assistantMessageEvent && e.assistantMessageEvent.type === 'text_delta')
  .map(e => e.assistantMessageEvent.delta).join('');
const settledIdx = (c, fromIdx) => {
  for (let i = fromIdx || 0; i < c.events.length; i++) if (c.events[i].type === 'agent_settled') return i;
  return -1;
};
function helloActive(cl) { const h = [...cl.events].reverse().find(e => e.type === 'bridge_hello'); return h ? h.active : null; }

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/healthz');
      if (r.ok) return;
    } catch {}
    await new Promise(res => setTimeout(res, 100));
  }
  throw new Error('сервер не поднялся за 5с');
}

async function main() {
  testMd();
  await waitReady();

  /* ---------- A) базовый цикл ---------- */
  const a = makeClient('A');
  await a.waitFor(o => o.type === 'bridge_hello', 'hello');
  await a.waitFor(o => o.type === 'response' && o.command === 'get_state' && o.success, 'get_state');
  const msgsA = await a.waitFor(o => o.type === 'response' && o.command === 'get_messages', 'get_messages');
  assert.strictEqual(msgsA.data.messages.length, 2, 'история: 2 сообщения');
  a.send(JSON.stringify({ type: 'get_session_stats' }));
  const statsA = await a.waitFor(o => o.type === 'response' && o.command === 'get_session_stats' && o.success, 'stats');
  assert.ok(statsA.data.contextUsage && statsA.data.contextUsage.percent === 30, 'contextUsage в stats');
  pass('A: hello + get_state + get_messages (2 сообщ.) + get_session_stats (ctx 30%)');

  a.send('тестовый запрос'); // plain text → мост оборачивает в prompt
  const t0 = a.events.length;
  await a.waitFor(o => o.type === 'agent_settled', 'agent_settled (A)');
  const ta = textOf(a, t0);
  assert.strictEqual(ta, 'Понял: «тестовый запрос». Выполняю тестовый ответ.', 'точный текст дельт A');
  const toolEndA = a.events.find(e => e.type === 'tool_execution_end');
  assert.ok(toolEndA && toolEndA.result.content[0].text === 'hi', 'tool_execution_end');
  pass('A: prompt(plain text) → стрим без искажений, tool-события на месте');
  a.close();

  /* ---------- B) переподключение: нет дублей ---------- */
  const b = makeClient('B');
  await b.waitFor(o => o.type === 'bridge_hello', 'hello B');
  const msgsB = await b.waitFor(o => o.type === 'response' && o.command === 'get_messages', 'get_messages B');
  assert.strictEqual(msgsB.data.messages.length, 2, 'после ресинка история снова 2 (не 4)');
  pass('B: переподключение, история отдаётся заново, без удвоения на уровне моста');

  b.send(JSON.stringify({ id: 'c1', type: 'prompt', message: 'второй запрос' }));
  const t1 = b.events.length;
  await b.waitFor(o => o.type === 'agent_settled' && b.events.indexOf(o) >= t1, 'agent_settled (B)');
  const tb = textOf(b, t1);
  assert.strictEqual(tb, 'Понял: «второй запрос». Выполняю тестовый ответ.', 'точный текст дельт B — дублей нет');
  const starts = b.events.slice(t1).filter(e => e.type === 'agent_start').length;
  assert.strictEqual(starts, 1, 'agent_start ровно один после ресинка');
  pass('B: после переподключения стрим ровно один экземпляр каждого события');

  /* ---------- C) мульти-сессии ---------- */
  const oldActive = helloActive(b);
  b.send(JSON.stringify({ type: 'bridge_create_session' }));
  const lst2 = await b.waitFor(o => o.type === 'bridge_sessions' && o.sessions.length === 2, 'bridge_sessions x2');
  const newS = lst2.sessions.find(s => s.id !== oldActive);
  const helloNew = await b.waitFor(o => o.type === 'bridge_hello' && o.active !== oldActive, 'hello новой сессии');
  assert.strictEqual(helloNew.active, newS.id, 'attach к новой сессии после create');
  await b.waitFor(o => o.type === 'response' && o.command === 'get_messages', 'get_messages новой сессии');
  pass('C: create_session → вторая сессия, клиент привязан к ней');

  b.send(JSON.stringify({ id: 'c2', type: 'prompt', message: 'третий запрос' }));
  const t2 = b.events.length;
  await b.waitFor(o => o.type === 'agent_settled' && b.events.indexOf(o) >= t2, 'agent_settled (C)');
  assert.strictEqual(textOf(b, t2), 'Понял: «третий запрос». Выполняю тестовый ответ.', 'точный текст дельт C');
  pass('C: промпт в новую сессию работает независимо');

  b.send(JSON.stringify({ type: 'bridge_rename_session', session: helloNew.active, name: 'Моя тема' }));
  await b.waitFor(o => o.type === 'bridge_sessions' && o.sessions.some(s => s.name === 'Моя тема'), 'rename в списке');
  pass('C: переименование сессии отражается в списке');

  b.send(JSON.stringify({ type: 'bridge_delete_session', session: helloNew.active }));
  await b.waitFor(o => o.type === 'bridge_sessions' && o.sessions.length === 1, 'bridge_sessions x1 после delete');
  await b.waitFor(o => o.type === 'bridge_hello' && o.active !== helloNew.active, 'hello: перепривязка к оставшейся');
  pass('C: удаление сессии → клиент перепривязан к оставшейся');

  b.send(JSON.stringify({ type: 'bridge_attach', session: helloNew.active }));
  const err = await b.waitFor(o => o.type === 'bridge_error', 'bridge_error на attach удалённой');
  assert.ok(/нет такой сессии/.test(err.error), 'текст ошибки про отсутствие сессии');
  pass('C: attach к удалённой сессии даёт внятную ошибку');

  b.close();

  /* ---------- D) preferred session: после сна/перегрузки остаёмся на своей сессии ---------- */
  // на моменте: в системе одна сессия (s1). Клиент создаёт вторую (s2),
  // новый клиент с ?session=s2 должен сразу попасть в s2, а не в первую
  const d = makeClient('D');
  await d.waitFor(o => o.type === 'bridge_hello', 'hello D');
  const s1id = helloActive(d);
  d.send(JSON.stringify({ type: 'bridge_create_session' }));
  await d.waitFor(o => o.type === 'bridge_sessions' && o.sessions.length === 2, '2 сессии');
  const s2id = d.events.filter(o => o.type === 'bridge_sessions').pop().sessions.map(s => s.id).find(id => id !== s1id);
  const helloD = await d.waitFor(o => o.type === 'bridge_hello' && o.active === s2id, 'attach D к s2');
  assert.strictEqual(helloD.active, s2id, 'D в s2');
  pass('D: новая сессия создана (s2)');

  const d2 = makeClient('D2', null, 'ws://127.0.0.1:' + PORT + '/ws?session=' + s2id);
  const helloD2 = await d2.waitFor(o => o.type === 'bridge_hello', 'hello D2');
  assert.strictEqual(helloD2.active, s2id, '?session= — сразу привязка к своей сессии');
  pass('D: reconnect с ?session=s2 → привязка сразу к s2, не к первой');

  // устаревший ?session= (удалили сессию) — фолбэк на первую без падения
  d2.send(JSON.stringify({ type: 'bridge_delete_session', session: s2id }));
  await d2.waitFor(o => o.type === 'bridge_sessions' && o.sessions.length === 1, 'после delete s2');
  const d3 = makeClient('D3', null, 'ws://127.0.0.1:' + PORT + '/ws?session=' + s2id);
  const helloD3 = await d3.waitFor(o => o.type === 'bridge_hello', 'hello D3');
  assert.strictEqual(helloD3.active, s1id, 'удалённая сессия из ?session= → фолбэк на первую');
  pass('D: ?session= на удалённую сессию → фолбэк на первую (без ошибки)');

  d.close(); d2.close(); d3.close();
  clearTimeout(master);
  console.log('SMOKE OK');
  cleanup(0);
}

main().catch((e) => fail(e.message));
