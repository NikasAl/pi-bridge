/*
 * media-card.js — карточка доставленных файлов (инструмент send_media) для лога чата.
 *
 * Вход: массив items из result.details инструмента send_media:
 *   { ok: true,  kind: 'audio'|'image'|'video', path, url: '/media?path=...', title?, note? }
 *   { ok: false, path, error }
 * items = null/undefined → карточка-«оболочка» (инструмент ещё выполняется).
 *
 * DOM строится только через createElement/textContent (без innerHTML) —
 * путь/заголовок из модели не могут внедрить разметку. У audio/img/video
 * ставится onerror: недоступный файл заменяется строкой «файл недоступен».
 *
 * UMD: браузер (window.piMediaCard) и Node для тестов.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.piMediaCard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function plural(n, one, few, many) {
    n = Math.abs(n) % 100;
    const n1 = n % 10;
    if (n > 10 && n < 20) return many;
    if (n1 > 1 && n1 < 5) return few;
    if (n1 === 1) return one;
    return many;
  }

  function countKinds(items) {
    const c = { total: 0, audio: 0, image: 0, video: 0, other: 0 };
    (items || []).forEach(it => {
      if (!it || !it.ok || !it.url) return;
      c.total++;
      if (it.kind === 'audio') c.audio++;
      else if (it.kind === 'image') c.image++;
      else if (it.kind === 'video') c.video++;
      else c.other++;
    });
    return c;
  }

  /* «медиа 3: 2 аудио · 1 картинка» / «медиа…» (оболочка) / «ничего не доставлено» */
  function summaryText(items) {
    if (!items) return 'медиа…';
    const c = countKinds(items);
    if (!c.total) return 'медиа: ничего не доставлено';
    const parts = [];
    if (c.audio) parts.push(c.audio + ' аудио');
    if (c.image) parts.push(c.image + ' ' + plural(c.image, 'картинка', 'картинки', 'картинок'));
    if (c.video) parts.push(c.video + ' видео');
    if (c.other) parts.push(c.other + ' ' + plural(c.other, 'файл', 'файла', 'файлов'));
    return 'медиа ' + c.total + ': ' + parts.join(' · ');
  }

  function titleOf(it) {
    const t = String((it && it.title) || '').trim();
    return t || (it && it.path) || '';
  }

  function missSpan(doc, it) {
    const sp = doc.createElement('span');
    sp.className = 'media-miss';
    let text = 'файл недоступен: ' + ((it && (it.title || it.path)) || '?');
    if (it && it.error) text += ' — ' + it.error;
    sp.textContent = text;
    return sp;
  }

  function wireError(el, doc, it) {
    el.onerror = function () {
      const sp = missSpan(doc, it);
      if (el.parentNode) el.parentNode.replaceChild(sp, el);
    };
  }

  function create(doc, items) {
    const det = doc.createElement('details');
    det.className = 'media-card';
    const sum = doc.createElement('summary');
    sum.textContent = summaryText(items);
    det.appendChild(sum);
    if (!items) return det;                       // оболочка: ждём результат execute

    const ok = items.filter(it => it && it.ok && it.url);
    const bad = items.filter(it => !it || !it.ok || !it.url);

    let audioBox = null, imgBox = null, videoBox = null;
    const section = cls => {
      const d = doc.createElement('div');
      d.className = cls;
      det.appendChild(d);
      return d;
    };
    const titleEl = it => {
      const d = doc.createElement('div');
      d.className = 'media-title';
      d.textContent = titleOf(it) + (it.note ? ' — ' + it.note : '');
      return d;
    };

    ok.forEach(it => {
      const kind = it.kind || 'other';
      if (kind === 'audio') {
        audioBox = audioBox || section('media-audio');
        const row = doc.createElement('div');
        row.className = 'media-row';
        row.appendChild(titleEl(it));
        const a = doc.createElement('audio');
        a.controls = true;
        a.preload = 'metadata';
        a.src = it.url;
        wireError(a, doc, it);
        row.appendChild(a);
        audioBox.appendChild(row);
      } else if (kind === 'video') {
        videoBox = videoBox || section('media-video');
        videoBox.appendChild(titleEl(it));
        const v = doc.createElement('video');
        v.controls = true;
        v.preload = 'metadata';
        v.setAttribute('playsinline', '');
        v.src = it.url;
        wireError(v, doc, it);
        videoBox.appendChild(v);
      } else {
        imgBox = imgBox || section('media-grid');
        const img = doc.createElement('img');
        img.loading = 'lazy';
        img.alt = titleOf(it);
        img.src = it.url;
        wireError(img, doc, it);
        imgBox.appendChild(img);
      }
    });

    bad.forEach(it => det.appendChild(missSpan(doc, it)));
    return det;
  }

  return { create, summaryText, countKinds };
});
