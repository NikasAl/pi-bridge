/**
 * send_media — pi-расширение моста: инструмент выдачи файлов хоста в чат-клиент.
 *
 * Модель вызывает тул с элементами {kind, path, title?, note?}; execute проверяет
 * каждый путь (realpath-containment в MEDIA_DIRS, обычный файл, расширение из
 * белого списка — так же, как GET /media в server.js) и возвращает готовые
 * URL /media?path=... Байты файлов через RPC не ходят: их отдаёт HTTP-эндпоинт
 * /media самого моста, а карточку в логе строит страница из result.details.
 *
 * Загрузка: мост сам добавляет `--extension <repo>/extension/send-media.js`
 * к каждому спавну pi (см. server.js, PI_BRIDGE_MEDIA_EXT), поэтому инструмент
 * есть ТОЛЬКО в сессиях моста. НЕ копируйте файл в ~/.pi/agent/extensions/ —
 * иначе тул появится во всех pi-сессиях машины.
 *
 * MEDIA_DIRS — те же корни, что у /media (через ":", дефолт ~/myprjs/Ideal).
 * Пути в items — абсолютные или относительные от любого из корней; в ответе
 * path предпочитается относительным (меньше утечки структуры каталогов в логи
 * nginx на VPS).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/* Должен совпадать с MEDIA_MIME в server.js (процессы разные, общего кода нет). */
const MEDIA_MIME = {
  m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};

const MAX_ITEMS = 50;

function mediaRoots() {
  const raw = process.env.MEDIA_DIRS || path.join(os.homedir(), 'myprjs', 'Ideal');
  return String(raw).split(':').map(s => s.trim()).filter(Boolean).map(s => {
    if (s === '~') return os.homedir();
    if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
    return path.resolve(s);
  });
}

function realRoots() {
  return mediaRoots()
    .map(r => { try { return fs.realpathSync(r); } catch { return null; } })
    .filter(Boolean);
}

/* realpath + containment: файл обязан лежать под одним из корней
 * (../ и симлинки наружу отсекаются так же, как в /media). */
function tryResolve(cand, roots) {
  let rf = null;
  try { rf = fs.realpathSync(cand); } catch { return null; }
  for (const r of roots) {
    if (rf === r || rf.startsWith(r + path.sep)) return rf;
  }
  return null;
}

function failItem(item, error) {
  return { ok: false, kind: item && item.kind, path: item && item.path, title: item && item.title, error };
}

function resolveItem(item, roots) {
  if (!item || typeof item !== 'object') return failItem(item, 'элемент не объект');
  const rawPath = String(item.path || '').trim();
  if (!rawPath || rawPath.indexOf('\0') >= 0) return failItem(item, 'пустой или некорректный путь');

  const candList = rawPath.startsWith('/')
    ? [path.resolve(rawPath)]                                    // абсолютный — только проверка
    : roots.map(r => path.resolve(r, rawPath));                  // относительный — по корням по порядку
  let real = null;
  for (const cand of candList) {
    real = tryResolve(cand, roots);
    if (real) break;
  }
  if (!real) {
    return failItem(item, rawPath.startsWith('/')
      ? 'файл не найден или лежит вне MEDIA_DIRS'
      : 'не найден ни в одном каталоге MEDIA_DIRS');
  }

  const ext = path.extname(real).slice(1).toLowerCase();
  const mime = MEDIA_MIME[ext];
  if (!mime) return failItem(item, 'расширение .' + (ext || '?') + ' не в белом списке (media)');

  let st;
  try { st = fs.statSync(real); } catch { return failItem(item, 'файл не читается'); }
  if (!st.isFile()) return failItem(item, 'это не обычный файл (каталоги не отдаются)');

  let kind = String(item.kind || '').toLowerCase();
  if (kind !== 'audio' && kind !== 'image' && kind !== 'video') {
    kind = mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'image';
  }

  // отображаемый путь: относительный от корня, если получилось (для URL и логов)
  let display = rawPath.startsWith('/') ? real : rawPath;
  for (const r of roots) {
    if (real === r || real.startsWith(r + path.sep)) {
      display = path.relative(r, real) || path.basename(real);
      break;
    }
  }

  const out = {
    ok: true,
    kind,
    path: display,
    url: 'media?path=' + encodeURIComponent(display),
    size: st.size,
  };
  const title = String(item.title || '').trim();
  const note = String(item.note || '').trim();
  if (title) out.title = title.slice(0, 160);
  if (note) out.note = note.slice(0, 300);
  return out;
}

export default function (pi) {
  pi.registerTool({
    name: 'send_media',
    label: 'send media',
    description:
      'Отправить пользователю в чат-клиент файлы с этого компьютера (аудио/картинки/видео): ' +
      'в чате появится карточка с плеером, миниатюрами и ссылками на скачивание. ' +
      'Используй, когда пользователь просит прислать/показать файлы или медиа в чат ' +
      '(например, «пришли одобренные треки из suno», «покажи картинки из отчёта»). ' +
      'Пути — абсолютные или относительные от каталогов MEDIA_DIRS. ' +
      'Неверные/запрещённые пути вернутся с ошибкой — исправь их и вызови инструмент снова.',
    // Обычная JSON Schema: pi валидирует и её (coerceWithJsonSchema), TypeBox не нужен —
    // расширению нечему импортироваться из модулей pi.
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'От 1 до ' + MAX_ITEMS + ' элементов — что отправить',
          minItems: 1,
          maxItems: MAX_ITEMS,
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['audio', 'image', 'video'], description: 'Тип медиа' },
              path: { type: 'string', description: 'Абсолютный путь или относительный от одного из каталогов MEDIA_DIRS' },
              title: { type: 'string', description: 'Подпись в карточке (опционально)' },
              note: { type: 'string', description: 'Короткий комментарий к файлу (опционально)' },
            },
            required: ['kind', 'path'],
          },
        },
      },
      required: ['items'],
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const roots = realRoots();
      const list = Array.isArray(params && params.items) ? params.items : [];
      const out = list.slice(0, MAX_ITEMS).map(it => resolveItem(it, roots));
      const okCount = out.filter(i => i.ok).length;

      const lines = [];
      lines.push(okCount
        ? 'Готово к отправке: ' + okCount + ' из ' + out.length + '. Карточка уже показана пользователю.'
        : 'Ни один путь не прошёл проверку.');
      for (const it of out) {
        if (!it.ok) lines.push('ОШИБКА: ' + (it.path || '?') + ' — ' + it.error);
      }
      if (okCount) lines.push('Пути из result.details.items[].path можно использовать в повторных вызовах.');

      return { content: [{ type: 'text', text: lines.join('\n') }], details: { items: out } };
    },
  });
}
