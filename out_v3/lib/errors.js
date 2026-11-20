'use strict';

const { t } = require('./messages');

const RULES = [
  { re: /confirm you.?re not a bot/i, key: 'err.bot' },
  {
    re: /Could not copy (?:Chrome|Chromium|Edge|Brave|Opera|Vivaldi) cookie database|Failed to decrypt with DPAPI|cookie database.*(?:locked|in use)|could not find .* cookies? database/i,
    key: 'err.cookies',
  },
  { re: /Private video|This video is private/i, key: 'err.private' },
  { re: /age.?restricted|confirm your age|age verification|Sign in to confirm your age/i, key: 'err.age' },
  {
    re: /(?:login|log in|sign in) (?:is )?required|requires? (?:a )?login|Please log in|rate-limit reached|empty media response|Use --cookies|cookies? .*(?:needed|required)|restricted video|checkpoint/i,
    key: 'err.login',
  },
  {
    re: /not available in your country|geo.?restrict|blocked it in your country|not made this video available in your country/i,
    key: 'err.geo',
  },
  { re: /HTTP Error 429|Too Many Requests/i, key: 'err.rate' },
  { re: /Unsupported URL/i, key: 'err.unsupported' },
  { re: /Requested format is not available/i, key: 'err.format' },
  { re: /fragment \d+ not found|unable to continue/i, key: 'err.hls_fragment' },
  { re: /Video unavailable|has been removed|no longer available|does not exist|HTTP Error 404|Not Found/i, key: 'err.unavailable' },
  { re: /JavaScript runtime|n challenge|nsig|Signature solving failed/i, key: 'err.jsrt' },
  { re: /ffmpeg.*(?:not found|not installed)|ffprobe.*not found|Postprocessing/i, key: 'err.ffmpeg' },
  {
    re: /Unable to download (?:webpage|JSON)|getaddrinfo|Connection (?:reset|refused|timed out|aborted)|timed out|Network is unreachable|Temporary failure in name resolution|SSL|TransportError|Failed to resolve|Errno 11001/i,
    key: 'err.network',
  },
  // VK отвечает «Access denied», когда видео доступно только вошедшим, друзьям или по особой ссылке
  { re: /\[vk[^\]]*\][^\n]*(?:Access denied|registered users|private|friends|members only|Доступ)/i, key: 'err.vk_private' },
];

const COOKIE_RE = RULES[1].re;
const TRANSIENT_RE =
  /Unable to download|getaddrinfo|Connection (?:reset|refused|timed out|aborted)|timed out|Read timed out|Temporary failure|Network is unreachable|HTTP Error 5\d\d|IncompleteRead|Remote end closed|TransportError|HTTP Error 429|Too Many Requests|Errno 11001/i;

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
  return RULES[0].re.test(String(text || ''));
}

/** true, если сайт требует войти в аккаунт: «не бот», закрытое видео, возраст, обязательный вход. */
function isLoginError(text) {
  const s = String(text || '');
  return [0, 2, 3, 4].some((i) => RULES[i].re.test(s));
}

/** true, если сбой случился именно на субтитрах (само видео при этом можно скачать без них). */
function isSubtitleError(text) {
  return /subtitles?/i.test(String(text || '')) && /Unable to download|HTTP Error|Too Many Requests/i.test(String(text || ''));
}

/** true для временных сбоев сети или лимитов, после которых стоит повторить попытку. */
function isTransientError(text) {
  return TRANSIENT_RE.test(String(text || ''));
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
