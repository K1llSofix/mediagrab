'use strict';

/** Куки только этих доменов нужны YouTube; остальное в файл не попадает. */
const DOMAIN_RE = /(^|\.)(youtube\.com|google\.com|googlevideo\.com|youtube-nocookie\.com)$/i;

/** Есть ли среди куки признак входа в аккаунт Google. */
function hasLogin(cookies) {
  return cookies.some((c) => c.name === 'SAPISID' && DOMAIN_RE.test(String(c.domain || '').replace(/^\./, '')));
}

/**
 * Куки Electron -> формат Netscape (cookies.txt), который понимает yt-dlp.
 * HttpOnly-куки помечаются префиксом #HttpOnly_, сессионным ставится срок 30 дней.
 */
function toNetscape(cookies, now = Date.now()) {
  const fallbackExpiry = Math.floor(now / 1000) + 30 * 86400;
  const lines = ['# Netscape HTTP Cookie File', '# Exported by MediaGrab', ''];
  for (const c of cookies) {
    const bare = String(c.domain || '').replace(/^\./, '');
    if (!bare || !DOMAIN_RE.test(bare)) continue;
    const includeSubdomains = !c.hostOnly;
    const domain = includeSubdomains ? `.${bare}` : bare;
    const expiry = c.session || !c.expirationDate ? fallbackExpiry : Math.floor(c.expirationDate);
    lines.push([
      c.httpOnly ? `#HttpOnly_${domain}` : domain,
      includeSubdomains ? 'TRUE' : 'FALSE',
      c.path || '/',
      c.secure ? 'TRUE' : 'FALSE',
      expiry,
      c.name,
      c.value,
    ].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { toNetscape, hasLogin, DOMAIN_RE };
