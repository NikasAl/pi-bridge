#!/usr/bin/env node
/**
 * fake-pi — эмулятор `pi --mode rpc` для проверки моста без реальной pi/токенов.
 * Читает JSONL-команды из stdin, пишет JSONL-события в stdout по протоколу
 * из docs/rpc.md и docs/json.md (упрощённо, но с теми же полями).
 */
'use strict';

// эмулируем CLI-поведение pi: --session <file> выбирает файл сессии,
// --session-dir <dir> — каталог по умолчанию; файл сессии ведём по-настоящему
// (JSONL), чтобы мост мог тестировать санацию
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
function argVal(name) { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; }
const SESSION_DIR = argVal('--session-dir') || '/tmp';
const SESSION_FILE = argVal('--session') || path.join(SESSION_DIR, 'fake-' + Date.now() + '_' + process.pid + '.jsonl');
// первый корень MEDIA_DIRS — фейковый резолвер путей send_media (как реальный execute)
const MEDIA_ROOT_FAKE = String(process.env.MEDIA_DIRS || '').split(':').map(s => s.trim()).filter(Boolean)[0] || '/tmp';

let entrySeq = 0;
let fileLastId = null;
function initSessionFile() {
  try { fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true }); } catch {}
  if (fs.existsSync(SESSION_FILE)) {
    // продолжаем существующий файл: запоминаем id последней записи для parentId-цепочки
    try {
      const lines = fs.readFileSync(SESSION_FILE, 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try { const e = JSON.parse(lines[i]); if (e && e.id) { fileLastId = e.id; break; } } catch {}
      }
    } catch {}
    return;
  }
  const header = { type: 'session', version: 3, id: 'fake-' + process.pid, timestamp: new Date().toISOString(), cwd: process.cwd() };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(header) + '\n');
}
function appendEntry(message, extra) {
  const e = Object.assign({
    type: 'message',
    id: 'fe' + (++entrySeq) + '_' + Math.random().toString(16).slice(2, 6),
    parentId: fileLastId,
    timestamp: new Date().toISOString(),
    message,
  }, extra || {});
  fs.appendFileSync(SESSION_FILE, JSON.stringify(e) + '\n');
  fileLastId = e.id;
}
function hasBrokenDoneMarker() {
  try { return fs.readFileSync(SESSION_FILE, 'utf8').indexOf('"customType":"fake.broken-done"') >= 0; }
  catch { return false; }
}
initSessionFile();

let streaming = false;
let sessionName = null;
let mediaSeq = 0;
const historyExtra = [];         // сообщения после базовой тройки (для ресинка media-кейса)
function pushHistory(m) { historyExtra.push(m); }

// состояние модели/мышления для тестов «выбора модели»
const MODELS = [
  { id: 'fake-model', name: 'Fake Model', provider: 'fake', input: ['text', 'image'], contextWindow: 200000 },
  { id: 'fake-pro', name: 'Fake Pro', provider: 'fake', input: ['text', 'image'], contextWindow: 200000, reasoning: true },
  { id: 'gpt-x', name: 'GPT-X (без vision)', provider: 'other', input: ['text'], contextWindow: 100000 },
];
const THINK_LEVELS = ['off', 'low', 'medium', 'high'];
let curModel = MODELS[0];
let thinkingLevel = 'medium';

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function respond(id, command, success, data, error) {
  const r = { id, type: 'response', command, success };
  if (success) r.data = data; else r.error = error || 'error';
  emit(r);
}

function resolveMediaItem(it) {
  const p = String((it && it.path) || '').trim();
  let real = null;
  try { real = fs.realpathSync(p.startsWith('/') ? p : path.resolve(MEDIA_ROOT_FAKE, p)); } catch {}
  if (!real) return { ok: false, kind: it && it.kind, path: p, title: it && it.title, error: 'файл не найден' };
  let st;
  try { st = fs.statSync(real); } catch { return { ok: false, path: p, error: 'не читается' }; }
  if (!st.isFile()) return { ok: false, path: p, error: 'не обычный файл' };
  const disp = p.startsWith('/') ? (path.relative(MEDIA_ROOT_FAKE, real) || path.basename(real)) : p;
  return { ok: true, kind: (it && it.kind) || 'audio', path: disp, url: '/media?path=' + encodeURIComponent(disp), title: (it && it.title) || '', size: st.size };
}

/* сценарий «media:» + JSON-массив items — эмуляция вызова send_media:
 * tool-события в стриме + полноценные записи в файле/истории сессии */
function runMedia(id, message) {
  let items = [];
  try { items = JSON.parse(message.slice(6)); } catch {}
  if (!Array.isArray(items) || !items.length) items = [{ kind: 'audio', path: '/nonexistent/a.m4a', title: 'битый путь' }];
  streaming = true;
  emit({ type: 'agent_start' });
  appendEntry({ role: 'user', content: message, timestamp: Date.now() });
  pushHistory({ role: 'user', content: message, timestamp: Date.now() });
  emit({ type: 'message_start', message: { role: 'user', content: message, timestamp: Date.now() } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Подбираю медиа… ' } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Подбираю медиа…' } });
  const callId = 'call_media_' + (++mediaSeq);
  emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: callId, toolName: 'send_media' } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1, toolCall: { id: callId, name: 'send_media', arguments: { items } } } });
  emit({ type: 'tool_execution_start', toolCallId: callId, toolName: 'send_media', args: { items } });
  const out = items.map(resolveMediaItem);
  const okCount = out.filter(i => i.ok).length;
  const result = { content: [{ type: 'text', text: 'Готово к отправке: ' + okCount + ' из ' + out.length + '.' }], details: { items: out } };
  emit({ type: 'tool_execution_end', toolCallId: callId, toolName: 'send_media', result, isError: okCount === 0 });
  const assistantMsg = { role: 'assistant', content: [
    { type: 'text', text: 'Подбираю медиа…' },
    { type: 'toolCall', id: callId, name: 'send_media', arguments: { items } },
  ], timestamp: Date.now() };
  const toolResultMsg = { role: 'toolResult', toolCallId: callId, toolName: 'send_media', content: result.content, details: result.details, isError: okCount === 0, timestamp: Date.now() };
  appendEntry(assistantMsg);
  appendEntry(toolResultMsg);
  pushHistory(assistantMsg);
  pushHistory(toolResultMsg);
  emit({ type: 'message_end', message: { role: 'assistant' } });
  emit({ type: 'agent_end', messages: [], willRetry: false });
  emit({ type: 'agent_settled', aborted: false });
  streaming = false;
  respond(id, 'prompt', true, { disposition: 'started' });
}

function runPrompt(id, message, images) {
  streaming = true;
  emit({ type: 'agent_start' });
  appendEntry({ role: 'user', content: message, timestamp: Date.now() });
  if (/БИТЫЙ/i.test(message) && !hasBrokenDoneMarker()) {
    // эмуляция бага: tool_call с пустыми id и name → pi пишет битую пару,
    // результат — "Tool  not found" (два пробела). Маркер-запись custom
    // гарантирует, что после санации повторный промпт пройдёт нормально.
    emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: '', toolName: '' } });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: { id: '', name: '', arguments: {} } } });
    emit({ type: 'tool_execution_start', toolCallId: '', toolName: '', args: {} });
    emit({ type: 'tool_execution_end', toolCallId: '', toolName: '', result: { content: [{ type: 'text', text: 'Tool  not found' }] }, isError: true });
    appendEntry({ role: 'assistant', content: [{ type: 'toolCall', id: '', name: '', arguments: {} }], timestamp: Date.now() });
    appendEntry({ role: 'toolResult', toolCallId: '', toolName: '', content: [{ type: 'text', text: 'Tool  not found' }], isError: true, timestamp: Date.now() });
    appendEntry({ type: 'custom', customType: 'fake.broken-done', data: { at: Date.now() } });
    emit({ type: 'agent_end', messages: [], willRetry: false });
    emit({ type: 'agent_settled', aborted: false });
    streaming = false;
    respond(id, 'prompt', true, { disposition: 'started' });
    return;
  }
  const userContent = images && images.length
    ? [{ type: 'text', text: message }, ...images.map(i => ({ type: 'image', data: String(i.data || ''), mimeType: i.mimeType || 'image/png' }))]
    : message;
  emit({ type: 'message_start', message: { role: 'user', content: userContent, timestamp: Date.now() } });
  const parts = images && images.length
    ? ['Фото (' + images.length + '/' + (images[0].mimeType || '-') + '). ', '«' + message + '». ', 'Выполняю тестовый ответ.']
    : ['Понял: ', '«' + message + '». ', 'Выполняю тестовый ответ.'];
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
  for (const part of parts) {
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: part } });
  }
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'ok' } });
  appendEntry({ role: 'assistant', content: [{ type: 'text', text: 'ok: ' + message }], timestamp: Date.now() });
  // tool call
  emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 'call_1', toolName: 'bash' } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '{"command":"echo hi"}' } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1, toolCall: { id: 'call_1', name: 'bash', arguments: { command: 'echo hi' } } } });
  emit({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: { command: 'echo hi' } });
  emit({ type: 'tool_execution_update', toolCallId: 'call_1', toolName: 'bash', args: { command: 'echo hi' }, partialResult: { content: [{ type: 'text', text: 'hi' }] } });
  emit({ type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'bash', result: { content: [{ type: 'text', text: 'hi' }] }, isError: false });
  emit({ type: 'message_end', message: { role: 'assistant' } });
  emit({ type: 'agent_end', messages: [], willRetry: false });
  emit({ type: 'agent_settled', aborted: false });
  streaming = false;
  respond(id, 'prompt', true, { disposition: 'started' });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let cmd;
    try { cmd = JSON.parse(line); } catch { continue; }
    switch (cmd.type) {
      case 'get_state':
        respond(cmd.id, 'get_state', true, {
          model: curModel,
          thinkingLevel, isStreaming: streaming, isCompacting: false,
          sessionFile: SESSION_FILE, sessionId: 'fake123',
          sessionName: sessionName || undefined,
          messageCount: 2, pendingMessageCount: 0,
        });
        break;
      case 'get_session_stats':
        respond(cmd.id, 'get_session_stats', true, {
          sessionFile: '/tmp/fake-session.jsonl', sessionId: 'fake123',
          tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
          cost: 0.45,
          contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 },
        });
        break;
      case 'set_session_name':
        sessionName = String(cmd.name || '').slice(0, 80);
        respond(cmd.id, 'set_session_name', true);
        break;
      case 'get_messages':
        respond(cmd.id, 'get_messages', true, { messages: [
          { role: 'user', content: 'Привет из истории сессии' },
          { role: 'assistant', content: [
            { type: 'thinking', thinking: 'старые размышления' },
            { type: 'text', text: 'Прошлый ответ ассистента из истории.' },
          ] },
          // user-сообщение с картинкой — мост обязан вырезать base64 перед бродкастом
          { role: 'user', content: [
            { type: 'text', text: 'Смотри фото из истории' },
            { type: 'image', data: 'HISTIMGBASE64DATA', mimeType: 'image/png' },
          ] },
        ].concat(historyExtra) });
        break;
      case 'prompt':
        if (streaming && !cmd.streamingBehavior) {
          respond(cmd.id, 'prompt', false, null, 'Agent is streaming: specify streamingBehavior');
        } else if (cmd.streamingBehavior) {
          respond(cmd.id, 'prompt', true, { disposition: 'queued' });
        } else {
          if (/^media:/.test(cmd.message || '')) runMedia(cmd.id, cmd.message);
          else runPrompt(cmd.id, cmd.message || '', cmd.images);
        }
        break;
      case 'steer':
      case 'follow_up':
        respond(cmd.id, cmd.type, true, { disposition: 'queued' });
        emit({ type: 'queue_update', steering: cmd.type === 'steer' ? [cmd.message] : [], followUp: cmd.type === 'follow_up' ? [cmd.message] : [] });
        break;
      case 'abort':
        streaming = false;
        emit({ type: 'agent_settled', aborted: true });
        respond(cmd.id, 'abort', true);
        break;
      case 'new_session':
        respond(cmd.id, 'new_session', true, { cancelled: false });
        break;
      case 'get_available_models':
        respond(cmd.id, 'get_available_models', true, { models: MODELS });
        break;
      case 'set_model': {
        const m = MODELS.find(x => x.id === cmd.modelId && String(x.provider) === String(cmd.provider));
        if (!m) { respond(cmd.id, 'set_model', false, null, 'модель не найдена: ' + cmd.modelId); break; }
        curModel = m;
        respond(cmd.id, 'set_model', true, m);
        break;
      }
      case 'cycle_model': {
        const idx = MODELS.findIndex(x => x.id === curModel.id);
        curModel = MODELS[(idx + 1) % MODELS.length];
        respond(cmd.id, 'cycle_model', true, { model: curModel, thinkingLevel });
        break;
      }
      case 'get_available_thinking_levels':
        respond(cmd.id, 'get_available_thinking_levels', true, { levels: THINK_LEVELS });
        break;
      case 'set_thinking_level':
        if (THINK_LEVELS.includes(cmd.level)) thinkingLevel = cmd.level;
        respond(cmd.id, 'set_thinking_level', true);
        break;
      default:
        respond(cmd.id, cmd.type, true, {});
    }
  }
});
process.stdin.on('end', () => process.exit(0));
