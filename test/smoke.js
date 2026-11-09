#!/usr/bin/env node
/**
 * Smoke-тест моста (v2): поднимает server.js с фейковой pi и проверяет:
 *   A) базовый цикл: hello/get_state/get_messages, prompt (plain text), стрим событий;
 *   B) переподключение: строгая проверка, что дельты НЕ задваиваются;
 *   C) мульти-сессии: create/attach/rename/delete + get_session_stats;
 *   D) preferred session: reconnect с ?session=<id> остаётся на своей сессии;
 *   E) md.js: рендер маркдауна и защита от XSS.
 *   F) картинки: images проходят в prompt до pi, base64 не попадает клиентам.
 *   G) сессии с диска: скан каталога, имена, открытие через spawn --session.
 *   H) страховка «Tool not found»: детект → abort → санация → рестарт → повтор промпта.
 *   I) выбор модели: список, set_model/cycle_model, мышление.
 *   J) GET /media: 200/206/416/403 (traversal, симлинк, ext)/404/304/HEAD/dl.
 *   K) send_media: тул-события + карточка (media-card.js в stub-DOM) + ресинк из истории.
 * Запуск: node test/smoke.js   (или npm test)
 */
'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 8799;
const MEDIA_ROOT1 = '/tmp/pi-bridge-test-media/root1';
const MEDIA_ROOT2 = '/tmp/pi-bridge-test-media/root2';
const MEDIA_OUTSIDE = '/tmp/pi-bridge-test-media/outside';
const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    PI_BRIDGE_CMD: 'node',
    PI_BRIDGE_ARGS: path.join(__dirname, 'fake-pi.js'),
    PI_BRIDGE_SESSION_DIR: '/tmp/pi-bridge-test-sessions',
    PI_BRIDGE_MEDIA_EXT: '0',          // fake-pi не получает --extension
    MEDIA_DIRS: MEDIA_ROOT1 + ':' + MEDIA_ROOT2,
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

const master = setTimeout(() => fail('общий таймаут теста'), 90000);

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

/* ---------- I) media-card.js (чистая функция, stub-DOM без браузера) ---------- */
function testMediaCard(){
  const mc = require(path.join(__dirname, '..', 'media-card.js'));
  // минимальный stub document.createElement — достаточно для media-card.js
  const doc = { createElement(tag){
    return {
      tag, children: [], className: '', textContent: '', parentNode: null,
      appendChild(c){ c.parentNode = this; this.children.push(c); return c; },
      replaceChild(n, o){ const i = this.children.indexOf(o); if (i >= 0) this.children[i] = n; n.parentNode = this; o.parentNode = null; },
    };
  } };
  // 1) оболочка (инструмент ещё работает)
  const shell = mc.create(doc, null);
  assert.strictEqual(shell.className, 'media-card', 'класс оболочки');
  assert.strictEqual(shell.children[0].textContent, 'медиа…', 'summary оболочки');
  // 2) полная карточка: аудио + картинки + битый путь
  const items = [
    { ok: true, kind: 'audio', path: 'suno/a.m4a', url: 'media?path=suno%2Fa.m4a', title: 'Трек А' },
    { ok: true, kind: 'image', path: 'p1.png', url: 'media?path=p1.png' },
    { ok: true, kind: 'image', path: 'p2.png', url: 'media?path=p2.png' },
    { ok: false, path: 'x.txt', error: 'расширение .txt не в белом списке' },
  ];
  const card = mc.create(doc, items);
  const sum = card.children[0];
  assert.strictEqual(sum.textContent, 'медиа 3: 1 аудио · 2 картинки', 'summary карточки: ' + sum.textContent);
  const kinds = { audio: 0, img: 0 };
  (function walk(n){
    (n.children || []).forEach(ch => {
      if (ch.tag === 'audio') kinds.audio++;
      if (ch.tag === 'img'){ kinds.img++; assert.strictEqual(ch.loading, 'lazy', 'img loading=lazy'); }
      walk(ch);
    });
  })(card);
  assert.strictEqual(kinds.audio, 1, 'один <audio>');
  assert.strictEqual(kinds.img, 2, 'две <img> в гриде');
  const miss = card.children.filter(c => c.className === 'media-miss');
  assert.strictEqual(miss.length, 1, 'одна строка «недоступно»');
  assert.ok(miss[0].textContent.includes('x.txt') && miss[0].textContent.includes('белом списке'), 'текст miss-строки');
  // 3) onerror: аудио заменяется на «файл недоступен»
  let audioEl = null;
  (function walk(n){ (n.children || []).forEach(ch => { if (ch.tag === 'audio' && !audioEl) audioEl = ch; walk(ch); }); })(card);
  assert.ok(audioEl && audioEl.onerror, 'onerror навешан');
  const parent = audioEl.parentNode;
  audioEl.onerror();
  assert.ok(parent.children.some(c => c.className === 'media-miss' && c.textContent.includes('недоступен')), 'onerror → «файл недоступен»');
  assert.ok(!parent.children.some(c => c.tag === 'audio'), 'битое аудио удалено из DOM');
  // 4) ничего не доставлено + склонение
  assert.strictEqual(mc.summaryText([{ ok: false, path: 'p', error: 'e' }]), 'медиа: ничего не доставлено', 'пустая карточка');
  assert.ok(mc.summaryText(Array.from({ length: 5 }, () => ({ ok: true, kind: 'image', url: 'u' }))).includes('5 картинок'), 'склонение 5');
  assert.ok(mc.summaryText([{ ok: true, kind: 'video', url: 'v' }]).includes('1 видео'), 'видео в summary');
  pass('media-card.js: оболочка, summary/склонения, audio/img/video, miss-строки, onerror-замена');
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
  testMediaCard();
  await waitReady();

  /* ---------- A) базовый цикл ---------- */
  const a = makeClient('A');
  await a.waitFor(o => o.type === 'bridge_hello', 'hello');
  await a.waitFor(o => o.type === 'response' && o.command === 'get_state' && o.success, 'get_state');
  const msgsA = await a.waitFor(o => o.type === 'response' && o.command === 'get_messages', 'get_messages');
  assert.strictEqual(msgsA.data.messages.length, 3, 'история: 3 сообщения');
  const histImg = msgsA.data.messages[2].content.find(b => b.type === 'image');
  assert.ok(histImg, 'в истории есть image-блок');
  assert.strictEqual(histImg.data, '', 'base64 вырезан мостом (стрим истории)');
  assert.strictEqual(histImg.dataStripped, true, 'флаг dataStripped');
  a.send(JSON.stringify({ type: 'get_session_stats' }));
  const statsA = await a.waitFor(o => o.type === 'response' && o.command === 'get_session_stats' && o.success, 'stats');
  assert.ok(statsA.data.contextUsage && statsA.data.contextUsage.percent === 30, 'contextUsage в stats');
  pass('A: hello + get_state + get_messages (3 сообщ., base64 вырезан) + get_session_stats (ctx 30%)');

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
  assert.strictEqual(msgsB.data.messages.length, 3, 'после ресинка история снова 3 (не 6)');
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

  /* ---------- F) картинки: pass-through в pi + стрип base64 наружу ---------- */
  const f = makeClient('F');
  await f.waitFor(o => o.type === 'bridge_hello', 'hello F');
  await f.waitFor(o => o.type === 'response' && o.command === 'get_messages', 'get_messages F');
  f.send(JSON.stringify({
    id: 'f1', type: 'prompt', message: 'что на фото?',
    images: [{ type: 'image', data: 'AABBCCDD', mimeType: 'image/png' }],
  }));
  const tF = f.events.length;
  await f.waitFor(o => o.type === 'agent_settled' && f.events.indexOf(o) >= tF, 'agent_settled (F)');
  const msF = f.events.slice(tF).find(o => o.type === 'message_start' && o.message && o.message.role === 'user');
  assert.ok(msF && Array.isArray(msF.message.content) && msF.message.content.some(b => b.type === 'image'),
    'user-сообщение содержит image-блок');
  const imgBlockF = msF.message.content.find(b => b.type === 'image');
  assert.strictEqual(imgBlockF.data, '', 'base64 вырезан мостом из живого события');
  assert.strictEqual(imgBlockF.dataStripped, true, 'флаг dataStripped на живом событии');
  const tf = textOf(f, tF);
  assert.ok(/Фото \(1\/image\/png\)/.test(tf), 'images дошли до pi (эхо в тексте): ' + JSON.stringify(tf));
  pass('F: images проходят в prompt до pi, base64 не попадает клиентам');
  f.close();

  /* ---------- G) сессии с диска: скан + открытие через --session ---------- */
  const fsp = require('fs').promises;
  const sessDir = '/tmp/pi-bridge-test-sessions';
  await fsp.mkdir(sessDir, { recursive: true });
  const mkSession = (id, name) => [
    JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T10:00:00.000Z', cwd: '/tmp' }),
    JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T10:00:01.000Z', message: { role: 'user', content: 'Первый промпт сессии ' + id, timestamp: Date.now() } }),
    JSON.stringify({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-01-01T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ответ' }], timestamp: Date.now() } }),
    JSON.stringify({ type: 'session_info', id: 'm3', parentId: 'm2', timestamp: '2026-01-01T10:00:03.000Z', name }),
  ].join('\n') + '\n';
  const fileA = path.join(sessDir, '2026-01-01T100000_000Z_aaaaaaa1.jsonl');
  const fileB = path.join(sessDir, '2026-01-02T100000_000Z_bbbbbbb2.jsonl');
  await fsp.writeFile(fileA, mkSession('aaaaaaa1', 'Дисковая сессия А'));
  await fsp.writeFile(fileB, mkSession('bbbbbbb2', ''));

  const g = makeClient('G');
  await g.waitFor(o => o.type === 'bridge_hello', 'hello G');
  g.send(JSON.stringify({ type: 'bridge_list_disk_sessions', force: true }));
  const disk = await g.waitFor(o => o.type === 'bridge_disk_sessions', 'bridge_disk_sessions');
  const fa = disk.sessions.find(x => x.file === fileA);
  const fb = disk.sessions.find(x => x.file === fileB);
  assert.ok(fa && fa.name === 'Дисковая сессия А', 'имя из session_info: ' + JSON.stringify(fa));
  assert.ok(fb && fb.name === 'Первый промпт сессии bbbbbbb2', 'имя из первого user-сообщения');
  assert.ok(fb.mtime >= fa.mtime, 'fileB записан позже fileA (mtime честный)');
  assert.ok(disk.sessions.every((x, i) => i === 0 || disk.sessions[i - 1].mtime >= x.mtime), 'сортировка mtime desc');
  pass('G: скан каталога сессий — имена из session_info/первого промпта, сортировка');

  const beforeG = helloActive(g);
  g.send(JSON.stringify({ type: 'bridge_open_session', file: fileA }));
  const helloG = await g.waitFor(o => o.type === 'bridge_hello' && o.active !== beforeG, 'hello открытой сессии');
  const gs = await g.waitFor(o => o.type === 'response' && o.command === 'get_state' && o.success && o.data.sessionFile === fileA,
    'get_state открытой сессии');
  assert.strictEqual(gs.data.sessionFile, fileA, 'pi заспавнен с --session <file> (argv до fake-pi дошёл)');
  assert.ok(helloG.sessions.some(x => x.id === helloG.active && x.file === fileA), 'файл сессии в списке мост-сессий');
  pass('G: открытие сессии — новый процесс pi с --session, клиент привязан');

  g.send(JSON.stringify({ type: 'bridge_open_session', file: fileA }));
  const dupG = await g.waitFor(o => o.type === 'bridge_error', 'ошибка повторного открытия');
  assert.ok(/уже открыта/.test(dupG.error), 'текст ошибки про уже открытую сессию');
  pass('G: повторное открытие той же сессии отклоняется (защита от двух писателей)');

  g.send(JSON.stringify({ type: 'bridge_list_disk_sessions', force: true }));
  await g.waitFor(o => o.type === 'bridge_disk_sessions' && (o.sessions.find(x => x.file === fileA) || {}).open,
    'флаг open в списке');
  pass('G: открытая сессия помечена в списке «На диске»');
  g.close();

  /* ---------- H) страховка «Tool not found» ---------- */
  const fsSync = require('fs');
  const h = makeClient('H');
  await h.waitFor(o => o.type === 'bridge_hello', 'hello H');
  const stH = await h.waitFor(o => o.type === 'response' && o.command === 'get_state' && o.success, 'get_state H');
  const fileH = stH.data.sessionFile;
  assert.ok(fileH && fileH.endsWith('.jsonl'), 'файл сессии известен: ' + fileH);

  h.send(JSON.stringify({ id: 'h1', type: 'prompt', message: 'БИТЫЙ тест' }));
  const rec1 = await h.waitFor(o => o.type === 'bridge_status' && o.status === 'recovering', 'bridge_status recovering', 10000);
  assert.ok(rec1.reason, 'причина восстановления указана');
  pass('H: битый tool-call обнаружен (Tool␠␠not found / пустые id), запущено восстановление');

  const rec2 = await h.waitFor(o => o.type === 'bridge_status' && o.status === 'recovered', 'bridge_status recovered', 25000);
  assert.ok(h.events.some(o => o.type === 'bridge_status' && o.status === 'pi_down'), 'pi перезапускался в ходе восстановления');
  pass('H: recovery дошёл до конца — pi перезапущен на санированном файле');

  const sanitized = fsSync.readFileSync(fileH, 'utf8');
  assert.ok(!sanitized.includes('"toolCallId":""'), 'toolResult с пустым toolCallId вырезан');
  assert.ok(!sanitized.includes('"id":"","name":""'), 'toolCall с пустыми id/name вырезан');
  assert.ok(sanitized.includes('"role":"user"') && sanitized.includes('fake.broken-done'), 'остальная история жива (user-записи и маркер на месте)');
  assert.ok(fsSync.existsSync(fileH + '.bak-toolnotfound'), 'бэкап файла сессии создан');
  pass('H: файл сессии санирован (бита пара вырезана, бэкап создан, история цела)');

  // повтор последнего промпта: после recovered fake-процесс уже «здоров» (маркер),
  // поэтому тот же текст должен пройти обычным ходом
  const recIdx = h.events.indexOf(rec2);
  await h.waitFor(o => o.type === 'agent_settled' && h.events.indexOf(o) > recIdx, 'agent_settled повторного промпта', 15000);
  const th = textOf(h, recIdx + 1);
  assert.ok(th.includes('Понял: «БИТЫЙ тест»'), 'последний промпт повторён после санации: ' + JSON.stringify(th));
  pass('H: последний user-промпт автоматически повторён');

  // команды клиента во время recovery отклоняются с внятной ошибкой (не теряются молча)
  h.close();

  /* ---------- I) выбор модели: список, set_model/cycle_model, мышление ---------- */
  const i = makeClient('I');
  await i.waitFor(o => o.type === 'bridge_hello', 'hello I');
  await i.waitFor(o => o.type === 'response' && o.command === 'get_state' && o.success, 'get_state I');

  i.send(JSON.stringify({ id: 'i1', type: 'get_available_models' }));
  const lvl = await i.waitFor(o => o.type === 'response' && o.command === 'get_available_models' && o.success, 'get_available_models');
  assert.ok(Array.isArray(lvl.data.models) && lvl.data.models.length >= 3, 'список моделей (3+)');
  assert.ok(lvl.data.models.some(m => m.id === 'fake-model' && m.provider === 'fake'), 'есть fake-model/fake');
  pass('I: get_available_models — список моделей проходит через мост к клиенту');

  i.send(JSON.stringify({ id: 'i2', type: 'set_model', provider: 'fake', modelId: 'fake-pro' }));
  const setI = await i.waitFor(o => o.type === 'response' && o.command === 'set_model' && o.success, 'set_model');
  assert.strictEqual(setI.data.id, 'fake-pro', 'set_model вернул выбранную модель');
  i.send(JSON.stringify({ id: 'i3', type: 'get_state' }));
  const stI = await i.waitFor(o => o.type === 'response' && o.command === 'get_state' && o.success && o.data.model && o.data.model.id === 'fake-pro', 'get_state после set_model');
  assert.strictEqual(stI.data.model.id, 'fake-pro', 'состояние сессии отражает новую модель');
  pass('I: set_model переключает модель сессии (подтверждается get_state)');

  i.send(JSON.stringify({ id: 'i4', type: 'cycle_model' }));
  const cyI = await i.waitFor(o => o.type === 'response' && o.command === 'cycle_model' && o.success && o.data.model, 'cycle_model');
  assert.ok(cyI.data.model.id !== 'fake-pro', 'cycle_model ушёл с текущей модели');
  pass('I: cycle_model — следующая модель');

  i.send(JSON.stringify({ id: 'i5', type: 'get_available_thinking_levels' }));
  await i.waitFor(o => o.type === 'response' && o.command === 'get_available_thinking_levels' && o.success && Array.isArray(o.data.levels) && o.data.levels.includes('off'), 'уровни мышления');
  i.send(JSON.stringify({ id: 'i6', type: 'set_thinking_level', level: 'high' }));
  await i.waitFor(o => o.type === 'response' && o.command === 'set_thinking_level' && o.success, 'set_thinking_level');
  i.send(JSON.stringify({ id: 'i7', type: 'get_state' }));
  const stT = await i.waitFor(o => o.type === 'response' && o.command === 'get_state' && o.success && o.data.thinkingLevel === 'high', 'get_state уровень мышления');
  assert.strictEqual(stT.data.thinkingLevel, 'high', 'уровень мышления сменился');
  pass('I: мышление — список уровней + установка high подтверждается get_state');
  i.close();

  /* ---------- J) GET /media: 200/206/416/403/404/304/HEAD/dl ---------- */
  const fsp2 = require('fs').promises;
  await fsp2.mkdir(MEDIA_ROOT1 + '/suno', { recursive: true });
  await fsp2.mkdir(MEDIA_ROOT2, { recursive: true });
  await fsp2.mkdir(MEDIA_OUTSIDE, { recursive: true });
  const buf256 = Buffer.from(Array.from({ length: 256 }, (_, i) => i % 256));
  await fsp2.writeFile(MEDIA_ROOT1 + '/track.m4a', buf256);
  await fsp2.writeFile(MEDIA_ROOT1 + '/suno/clip.mp3', Buffer.alloc(100, 7));
  await fsp2.writeFile(MEDIA_ROOT1 + '/pic.png', Buffer.alloc(64, 3));
  await fsp2.writeFile(MEDIA_ROOT2 + '/second.wav', Buffer.alloc(10, 9));
  await fsp2.writeFile(MEDIA_ROOT1 + '/note.txt', 'секрет');
  await fsp2.writeFile(MEDIA_ROOT1 + '/empty.m4a', '');
  await fsp2.writeFile(MEDIA_OUTSIDE + '/secret.txt', 'не должен отдаваться');
  try { await fsp2.unlink(MEDIA_ROOT1 + '/link-out.m4a'); } catch {}
  await fsp2.symlink(MEDIA_OUTSIDE + '/secret.txt', MEDIA_ROOT1 + '/link-out.m4a');

  const murl = (q) => 'http://127.0.0.1:' + PORT + '/media?path=' + encodeURIComponent(q);
  const absTrack = MEDIA_ROOT1 + '/track.m4a';

  let r = await fetch(murl(absTrack));
  assert.strictEqual(r.status, 200, '200 на абсолютный путь');
  assert.strictEqual(r.headers.get('content-type'), 'audio/mp4', 'MIME по расширению');
  assert.strictEqual(r.headers.get('accept-ranges'), 'bytes', 'Accept-Ranges на 200');
  assert.ok(r.headers.get('etag'), 'ETag есть');
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff', 'nosniff');
  assert.strictEqual(r.headers.get('content-security-policy'), "default-src 'none'", 'CSP на /media');
  assert.strictEqual(r.headers.get('cache-control'), 'private, max-age=3600', 'Cache-Control');
  const body1 = Buffer.from(await r.arrayBuffer());
  assert.ok(body1.equals(buf256), 'тело 200 == файл целиком');
  const etag1 = r.headers.get('etag');
  pass('J: 200 по абсолютному пути, MIME/заголовки/тело');

  r = await fetch(murl('track.m4a'));
  assert.strictEqual(r.status, 200, 'относительный путь резолвится по первому корню');
  r = await fetch(murl('suno/clip.mp3'));
  assert.strictEqual(r.status, 200, 'подкаталог: 200');
  assert.strictEqual(r.headers.get('content-type'), 'audio/mpeg', 'подкаталог + audio/mpeg');
  r = await fetch(murl('second.wav'));
  assert.strictEqual(r.status, 200, 'второй корень: 200');
  assert.strictEqual(r.headers.get('content-type'), 'audio/wav', 'второй корень MEDIA_DIRS');
  pass('J: относительные пути и второй корень');

  r = await fetch(murl(absTrack), { headers: { Range: 'bytes=0-9' } });
  assert.strictEqual(r.status, 206, '206 на корректный диапазон');
  assert.strictEqual(r.headers.get('content-range'), 'bytes 0-9/256', 'Content-Range 0-9');
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(buf256.subarray(0, 10)), 'тело 206 — первые 10 байт');
  r = await fetch(murl(absTrack), { headers: { Range: 'bytes=-5' } });
  assert.strictEqual(r.status, 206, 'suffix-диапазон: 206');
  assert.strictEqual(r.headers.get('content-range'), 'bytes 251-255/256', 'suffix Content-Range');
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(buf256.subarray(251)), 'suffix — последние 5 байт');
  r = await fetch(murl(absTrack), { headers: { Range: 'bytes=10-' } });
  assert.strictEqual(r.status, 206, 'открытый диапазон: 206');
  assert.strictEqual(r.headers.get('content-range'), 'bytes 10-255/256', 'открытый Content-Range');
  pass('J: Range — a-b, -suffix, открытый');

  r = await fetch(murl(absTrack), { headers: { Range: 'bytes=999999-' } });
  assert.strictEqual(r.status, 416, 'за пределами: 416');
  assert.strictEqual(r.headers.get('content-range'), 'bytes */256', '416 + Content-Range */size');
  r = await fetch(murl(absTrack), { headers: { Range: 'bytes=zz' } });
  assert.strictEqual(r.status, 416, 'мусорный Range → 416');
  r = await fetch(murl(absTrack), { headers: { Range: 'bytes=5-2' } });
  assert.strictEqual(r.status, 416, 'start>end → 416');
  r = await fetch(murl(MEDIA_ROOT1 + '/empty.m4a'), { headers: { Range: 'bytes=0-' } });
  assert.strictEqual(r.status, 416, 'Range на пустом файле → 416');
  pass('J: 416 — за пределами, мусор, инверсия, пустой файл');

  r = await fetch(murl(absTrack), { headers: { 'If-None-Match': etag1 } });
  assert.strictEqual(r.status, 304, '304 по If-None-Match/ETag');
  assert.strictEqual((await r.arrayBuffer()).byteLength, 0, '304 без тела');
  pass('J: 304 по ETag');

  r = await fetch(murl('/etc/hostname'));
  assert.strictEqual(r.status, 403, 'абсолютный путь вне корней → 403');
  r = await fetch(murl('../outside/secret.txt'));
  assert.strictEqual(r.status, 403, 'относительный traversal → 403');
  r = await fetch(murl(MEDIA_ROOT1 + '/link-out.m4a'));
  assert.strictEqual(r.status, 403, 'симлинк наружу → 403');
  r = await fetch(murl('note.txt'));
  assert.strictEqual(r.status, 403, 'расширение вне whitelist → 403');
  r = await fetch(murl('suno'));
  assert.strictEqual(r.status, 403, 'каталог не отдаётся → 403');
  const secretCheck = await fetch(murl(MEDIA_OUTSIDE + '/secret.txt'));
  assert.strictEqual(secretCheck.status, 403, 'файл вне корней напрямую → 403');
  pass('J: 403 — traversal, симлинк, не-медиа расширение, каталог');

  r = await fetch(murl('missing.m4a'));
  assert.strictEqual(r.status, 404, 'несуществующий файл → 404');
  r = await fetch(murl(absTrack), { method: 'HEAD' });
  assert.strictEqual(r.status, 200, 'HEAD: 200');
  assert.strictEqual(r.headers.get('content-length'), '256', 'HEAD: Content-Length');
  assert.strictEqual(r.headers.get('accept-ranges'), 'bytes', 'HEAD: Accept-Ranges');
  assert.strictEqual((await r.arrayBuffer()).byteLength, 0, 'HEAD без тела');
  r = await fetch(murl(absTrack) + '&dl=1');
  assert.ok(String(r.headers.get('content-disposition') || '').startsWith("attachment; filename*=UTF-8''"), 'dl=1 → attachment');
  pass('J: 404, HEAD, dl=1');

  /* ---------- K) send_media: тул-события, карточка, ресинк из истории ---------- */
  const j = makeClient('K');
  await j.waitFor(o => o.type === 'bridge_hello', 'hello J');
  await j.waitFor(o => o.type === 'response' && o.command === 'get_messages', 'get_messages J');
  const itemsJ = [
    { kind: 'audio', path: MEDIA_ROOT1 + '/track.m4a', title: 'Трек декабря' },   // абсолютный
    { kind: 'image', path: 'pic.png' },                                            // относительный
    { kind: 'audio', path: MEDIA_ROOT1 + '/no-such.m4a', title: 'битый' },         // не существует
  ];
  j.send(JSON.stringify({ id: 'j1', type: 'prompt', message: 'media:' + JSON.stringify(itemsJ) }));
  const tJ = j.events.length;
  await j.waitFor(o => o.type === 'agent_settled' && j.events.indexOf(o) >= tJ, 'agent_settled (J)');

  const teJ = j.events.slice(tJ).find(o => o.type === 'tool_execution_end' && o.toolName === 'send_media');
  assert.ok(teJ, 'tool_execution_end send_media дошёл до клиента');
  assert.ok(teJ.result && Array.isArray(teJ.result.details.items), 'details.items в результате');
  const detJ = teJ.result.details.items;
  assert.strictEqual(detJ.length, 3, '3 элемента');
  assert.strictEqual(detJ[0].ok, true, 'абсолютный путь прошёл');
  assert.strictEqual(detJ[0].url, 'media?path=' + encodeURIComponent('track.m4a'),
    'абсолютный путь → относительный URL: ' + JSON.stringify(detJ[0]));
  assert.strictEqual(detJ[1].ok, true, 'относительный путь прошёл');
  assert.strictEqual(detJ[1].url, 'media?path=pic.png', 'относительный путь сохранён в URL');
  assert.strictEqual(detJ[2].ok, false, 'битый путь помечен ok:false');
  assert.ok(detJ[2].error, 'ошибка для модели присутствует');
  const tsJ = j.events.slice(tJ).find(o => o.type === 'tool_execution_start' && o.toolName === 'send_media');
  assert.ok(tsJ && tsJ.args && tsJ.args.items.length === 3, 'tool_execution_start несёт args.items (карточка строится сразу)');
  pass('K: тул-события send_media ретранслируются с details.items и URL /media');

  // ресинк: новый клиент получает историю с toolCall-блоком и toolResult с details
  const j2 = makeClient('K2');
  await j2.waitFor(o => o.type === 'bridge_hello', 'hello J2');
  const msgsJ = await j2.waitFor(o => o.type === 'response' && o.command === 'get_messages', 'get_messages J2');
  const msgs = msgsJ.data.messages;
  const asstIdx = msgs.findIndex(m => m.role === 'assistant' &&
    Array.isArray(m.content) && m.content.some(b => (b.type === 'toolCall' || b.type === 'toolcall') && (b.name === 'send_media' || b.toolName === 'send_media')));
  assert.ok(asstIdx >= 0, 'в истории есть assistant с toolCall send_media');
  const tcJ = msgs[asstIdx].content.find(b => (b.type === 'toolCall' || b.type === 'toolcall') && (b.name === 'send_media' || b.toolName === 'send_media'));
  assert.ok(tcJ.id && Array.isArray(tcJ.arguments.items) && tcJ.arguments.items.length === 3, 'toolCall.arguments.items персистентны');
  const trIdx = msgs.findIndex(m => (m.role === 'toolResult' || m.role === 'tool') && m.toolCallId === tcJ.id);
  assert.ok(trIdx > asstIdx, 'в истории есть toolResult по тому же toolCallId');
  assert.strictEqual(msgs[trIdx].toolName, 'send_media', 'toolName у toolResult');
  assert.ok(msgs[trIdx].details && msgs[trIdx].details.items && msgs[trIdx].details.items.length === 3,
    'details.items персистентны (карточка восстановится по ним)');
  assert.strictEqual(msgs[trIdx].details.items[0].url, detJ[0].url, 'URL в истории совпадает с живым');
  pass('K: ресинк — карточка восстанавливается из toolCall+toolResult (дедуп по toolCallId)');
  j.close(); j2.close();

  clearTimeout(master);
  console.log('SMOKE OK');
  cleanup(0);
}

main().catch((e) => fail(e.message));
