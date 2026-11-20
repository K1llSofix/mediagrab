'use strict';

/**
 * Запасной путь для Pinterest: если yt-dlp не смог обработать пин (обычно это картинка, а не видео),
 * читаем og:image со страницы и качаем оригинал с i.pinimg.com.
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function isPinterestUrl(u) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    return host === 'pin.it' || /(^|\.)pinterest\.[a-z.]+$/.test(host);
  } catch {
    return false;
  }
}

function isPinImageHost(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && /(^|\.)pinimg\.com$/.test(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function decodeEntities(s = '') {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Значение <meta property|name="key" content="..."> независимо от порядка атрибутов. */
function metaContent(html, key) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const k = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!k || k[1].toLowerCase() !== key) continue;
    const c = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    if (c) return decodeEntities(c[1] !== undefined ? c[1] : c[2]);
  }
  return null;
}

/** https://i.pinimg.com/736x/ab/cd/x.jpg  ->  https://i.pinimg.com/originals/ab/cd/x.jpg */
function originalImageUrl(u) {
  if (!isPinImageHost(u)) return null;
  const url = new URL(u);
  url.pathname = url.pathname.replace(/^\/(?:\d+x(?:\d+)?(?:_[A-Za-z]+)?|originals)\//, '/originals/');
  return url.toString();
}

function safeName(s) {
  return (
    String(s || '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
      .replace(/[. ]+$/, '') || 'Pinterest'
  );
}

/** Возвращает описание картинки-пина или null, если это не картинка. */
async function scrapePin(url, fetchFn, signal) {
  const res = await fetchFn(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal,
  });
  if (!res.ok) return null;
  const html = await res.text();
  if (metaContent(html, 'og:video') || metaContent(html, 'og:video:url')) return null; // видео-пин — задача yt-dlp

  const image = metaContent(html, 'og:image') || metaContent(html, 'twitter:image');
  if (!image || !isPinImageHost(image)) return null;

  const idRe = /\/pin\/(?:[^/?#]*--)?(\d+)/;
  const id = (idRe.exec(res.url || '') || idRe.exec(url) || [])[1] || String(Date.now());
  const rawTitle = metaContent(html, 'og:title') || (/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [])[1] || '';
  const title = safeName(decodeEntities(rawTitle).replace(/\s*\|\s*Pinterest\s*$/i, '')) || 'Pinterest';

  return {
    kind: 'image',
    title,
    uploader: null,
    duration: null,
    thumbnail: image,
    site: 'Pinterest',
    heights: [],
    splitStreams: false,
    audioOnly: false,
    image: { url: image, originalUrl: originalImageUrl(image), basename: `${title} [${id}]` },
  };
}

const EXT_BY_TYPE = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function extFromContentType(ct = '') {
  return EXT_BY_TYPE[ct.split(';')[0].trim().toLowerCase()] || null;
}

module.exports = {
  USER_AGENT,
  isPinterestUrl,
  isPinImageHost,
  metaContent,
  originalImageUrl,
  safeName,
  scrapePin,
  extFromContentType,
};
