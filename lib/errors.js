'use strict';

const { t } = require('./messages');

const RULES = [
  { name: 'bot', re: /confirm you.?re not a bot/i, key: 'err.bot' },
  {
    name: 'cookies',
    re: /Could not copy (?:Chrome|Chromium|Edge|Brave|Opera|Vivaldi) cookie database|Failed to decrypt with DPAPI|cookie database.*(?:locked|in use)|could not find .* cookies? database/i,
    key: 'err.cookies',
  },
  { name: 'private', re: /Private video|This video is private/i, key: 'err.private' },
  { name: 'age', re: /age.?restricted|confirm your age|age verification|Sign in to confirm your age/i, key: 'err.age' },
  {
    name: 'login',
    re: /(?:login|log in|sign in) (?:is )?required|requires? (?:a )?login|Please log in|rate-limit reached|empty media response|Use --cookies|cookies? .*(?:needed|required)|restricted video|checkpoint/i,
    key: 'err.login',
  },
  {
    name: 'geo',
    re: /not available in your country|geo.?restrict|blocked it in your country|not made this video available in your country/i,
    key: 'err.geo',
  },
  { name: 'rate', re: /HTTP Error 429|Too Many Requests/i, key: 'err.rate' },
  { name: 'forbidden', re: /HTTP Error 403|Forbidden/i, key: 'err.forbidden' },
  { name: 'unsupported', re: /Unsupported URL/i, key: 'err.unsupported' },
  { name: 'format', re: /Requested format is not available/i, key: 'err.format' },
  // ffmpeg раньше «недоступно»: текст «ffprobe and ffmpeg not found» содержит слова Not Found
  { name: 'ffmpeg', re: /ffmpeg.*(?:not found|not installed)|ffprobe.*not found|Postprocessing/i, key: 'err.ffmpeg' },
  { name: 'unavailable', re: /Video unavailable|has been removed|no longer available|does not exist|HTTP Error 404|Not Found/i, key: 'err.unavailable' },
  { name: 'jsrt', re: /JavaScript runtime|n challenge|nsig|Signature solving failed/i, key: 'err.jsrt' },
  {
    name: 'network',
    re: /Unable to download (?:webpage|JSON)|getaddrinfo|Connection (?:reset|refused|timed out|aborted)|timed out|Network is unreachable|Temporary failure in name resolution|\bSSL\b|TransportError|Failed to resolve|Errno 11001/i,
    key: 'err.network',
  },
  // VK отвечает «Access denied», когда видео доступно только вошедшим, друзьям или по особой ссылке
  { name: 'vk', re: /\[vk[^\]]*\][^\n]*(?:Access denied|registered users|private|friends|members only|Доступ)/i, key: 'err.vk_private' },
];

/** Правило по имени: порядок правил можно менять, ничего не сломается. */
const RULE = Object.fromEntries(RULES.map((r) => [r.name, r]));
const LOGIN_RULES = ['bot', 'private', 'age', 'login'].map((n) => RULE[n]);

const COOKIE_RE = RULE.cookies.re;
// Временные сбои: сеть, 5xx, лимиты. Ошибки 4xx (кроме 429) — постоянные: удалённое видео не появится через 5 секунд.
const TRANSIENT_RE =
  /Unable to download|getaddrinfo|Connection (?:reset|refused|timed out|aborted)|timed out|Read timed out|Temporary failure|Network is unreachable|HTTP Error 5\d\d|IncompleteRead|Remote end closed|TransportError|HTTP Error 429|Too Many Requests|Errno 11001/i;
const PERMANENT_4XX_RE = /HTTP Error 4(?!29)\d\d/i;

/** Превращает вывод ошибки yt-dlp в понятное сообщение на текущем языке. */
function explain(text) {
  const raw = String(text || '').trim();
  if (!raw) return t('err.unknown');
  const errorLines = raw.split(/\r?\n/).filter((l) => /^ERROR:/i.test(l.trim()));
  const haystack = errorLines.length ? errorLines.join('\n') : raw;
  for (const rule of RULES) {
    if (rule.re.test(haystack)) return t(rule.key);
  }
  const first = (errorLines[0] || raw.split(/\r?\n/).pop() || raw).replace(/^ERROR:\s*/i, '').trim();
  return first.length > 300 ? `${first.slice(0, 300)}…` : first;
}

/** true, если yt-dlp не смог прочитать куки браузера (тогда можно повторить без них). */
function isCookieError(text) {
  return COOKIE_RE.test(String(text || ''));
}

/** true, если YouTube требует подтвердить, что вы не бот. */
function isBotError(text) {
  return RULE.bot.re.test(String(text || ''));
}

/** true, если сайт требует войти в аккаунт: «не бот», закрытое видео, возраст, обязательный вход. */
function isLoginError(text) {
  const s = String(text || '');
  return LOGIN_RULES.some((r) => r.re.test(s));
}

/** true, если сбой случился именно на субтитрах (само видео при этом можно скачать без них). */
function isSubtitleError(text) {
  return /subtitles?/i.test(String(text || '')) && /Unable to download|HTTP Error|Too Many Requests/i.test(String(text || ''));
}

/** true для временных сбоев сети или лимитов, после которых стоит повторить попытку. */
function isTransientError(text) {
  const s = String(text || '');
  if (PERMANENT_4XX_RE.test(s) && !/HTTP Error 5\d\d/.test(s)) return false;
  return TRANSIENT_RE.test(s);
}

/** true, если yt-dlp не умеет разбирать эту страницу и можно попробовать браузер-перехватчик. */
function isUnsupportedError(text) {
  const s = String(text || '');
  return (
    /Unsupported URL|No video formats found/i.test(s) ||
    /\[generic\][^\n]*(?:Cloudflare|anti-bot|HTTP Error 403|impersonate)/i.test(s)
  );
}

module.exports = { explain, isCookieError, isTransientError, isBotError, isLoginError, isSubtitleError, isUnsupportedError };
