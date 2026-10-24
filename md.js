/*
 * md.js — компактный безопасный рендер Markdown для лога чата pi-bridge.
 * Поддержка: заголовки #..####, списки ul/ol, fenced-код ```, инлайн-код,
 * **жирный**, *курсив*, _курсив_, ~~зачёркнутый~~, ссылки, цитаты, hr, абзацы.
 * Безопасность: сначала экранирование HTML, потом разметка — инъекции невозможны.
 * UMD: работает и в браузере (window.piMd), и в Node (module.exports) для тестов.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.piMd = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(>])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[\s(>])_([^_\n]+)_/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
  }

  function render(src) {
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let list = null;        // 'ul' | 'ol' | null
    let para = [];
    let inCode = false;
    let codeBuf = [];

    function closeList() { if (list) { out.push('</' + list + '>'); list = null; } }
    function openList(t) { if (list !== t) { closeList(); out.push('<' + t + '>'); list = t; } }
    function flushPara() {
      if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = line.match(/^```\w*\s*$/);
      if (fence) {
        if (inCode) { out.push('<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>'); inCode = false; codeBuf = []; }
        else { flushPara(); closeList(); inCode = true; }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }

      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { flushPara(); closeList(); const n = h[1].length; out.push('<h' + n + '>' + inline(h[2]) + '</h' + n + '>'); continue; }

      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) { flushPara(); openList('ul'); out.push('<li>' + inline(ul[1]) + '</li>'); continue; }

      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ol) { flushPara(); openList('ol'); out.push('<li>' + inline(ol[1]) + '</li>'); continue; }

      if (/^\s*>/.test(line)) {
        flushPara(); closeList();
        out.push('<blockquote>' + inline(line.replace(/^\s*>\s?/, '')) + '</blockquote>');
        continue;
      }

      if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flushPara(); closeList(); out.push('<hr>'); continue; }

      if (!line.trim()) { flushPara(); closeList(); continue; }
      para.push(line);
    }
    if (inCode) out.push('<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>');
    flushPara();
    closeList();
    return out.join('\n');
  }

  return { render: render, inline: inline, esc: esc };
});
