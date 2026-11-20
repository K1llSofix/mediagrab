'use strict';
/* Логика подписок без обращения к DOM: работает и в окне, и в тестах (node --test). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SubsCore = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const MAX_SEEN = 600;          // сколько уже виденных ссылок помним на подписку
  const MAX_SUBS = 30;
  const CHECK_EVERY_MS = 60 * 60 * 1000; // проверка раз в час, пока приложение открыто
  const FRESH_WINDOW = 15;       // смотрим первые N видео канала/плейлиста
  const MAX_NEW_PER_CHECK = FRESH_WINDOW; // за проверку виден максимум FRESH_WINDOW записей, поэтому ничего не отбрасываем

  /** Для канала YouTube без вкладки берём «Видео», иначе yt-dlp вернёт список вкладок. */
  function normalizeSubUrl(url) {
    let u;
    try { u = new URL(String(url).trim()); } catch { return ''; }
    if (!/^https?:$/.test(u.protocol)) return '';
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtube.com' && /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/?$/.test(u.pathname)) {
      u.pathname = `${u.pathname.replace(/\/$/, '')}/videos`;
    }
    u.hash = '';
    return u.toString();
  }

  function sanitizeSubs(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const s of raw) {
      if (!s || typeof s.url !== 'string' || !/^https?:\/\//.test(s.url)) continue;
      if (out.some((x) => x.url === s.url)) continue;
      out.push({
        url: s.url,
        title: typeof s.title === 'string' ? s.title.slice(0, 200) : '',
        format: typeof s.format === 'string' ? s.format : 'mp4',
        quality: typeof s.quality === 'string' ? s.quality : '',
        seen: Array.isArray(s.seen) ? s.seen.filter((x) => typeof x === 'string').slice(-MAX_SEEN) : [],
        lastCheck: Number.isFinite(s.lastCheck) ? s.lastCheck : 0,
        lastError: typeof s.lastError === 'string' ? s.lastError.slice(0, 300) : '',
      });
      if (out.length >= MAX_SUBS) break;
    }
    return out;
  }

  /** Новая подписка: всё, что есть сейчас, считается уже виденным, скачиваться будет только будущее. */
  function makeSub({ url, title, format, quality, entries }) {
    return sanitizeSubs([{ url, title, format, quality, seen: (entries || []).map((e) => e.url), lastCheck: Date.now() }])[0] || null;
  }

  /** Какие из текущих записей ещё не видели (порядок: старые первыми, чтобы очередь шла по хронологии). */
  function newEntries(sub, entries) {
    const known = new Set(sub.seen);
    const fresh = (entries || []).filter((e) => e && e.url && !known.has(e.url));
    return fresh.slice(0, MAX_NEW_PER_CHECK).reverse();
  }

  function markSeen(sub, entries) {
    const merged = [...sub.seen];
    const have = new Set(merged);
    for (const e of entries || []) if (e && e.url && !have.has(e.url)) { merged.push(e.url); have.add(e.url); }
    sub.seen = merged.slice(-MAX_SEEN);
    return sub;
  }

  const isDue = (sub, now = Date.now(), every = CHECK_EVERY_MS) => now - (sub.lastCheck || 0) >= every;

  return { MAX_SEEN, MAX_SUBS, CHECK_EVERY_MS, FRESH_WINDOW, MAX_NEW_PER_CHECK, normalizeSubUrl, sanitizeSubs, makeSub, newEntries, markSeen, isDue };
}));
