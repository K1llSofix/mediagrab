'use strict';

/**
 * Бережное отношение к аккаунту и лимитам сайта. Чистая логика без таймеров: время и случайность передаются снаружи,
 * поэтому всё проверяется тестами.
 *
 * - Загрузки с входом в аккаунт стартуют не чаще чем раз в 5–10 секунд и не больше 40 в час.
 * - После ответа 429 («слишком много запросов») включается пауза для того сайта, который ответил (остальные работают):
 *   1 мин, затем 3 мин, затем 5 мин (если лимиты повторяются подряд). После 15 минут без лимитов счёт сбрасывается.
 */

const HOUR = 3600 * 1000;
const COOLDOWNS_MS = [60 * 1000, 3 * 60 * 1000, 5 * 60 * 1000];
const CALM_RESET_MS = 15 * 60 * 1000;

class Throttle {
  constructor({ now = Date.now, rnd = Math.random, gapMs = [5000, 10000], perHour = 40 } = {}) {
    this.now = now;
    this.rnd = rnd;
    this.gapMs = gapMs;
    this.perHour = perHour;
    this.loginStarts = []; // моменты, на которые назначены старты загрузок с аккаунтом
    this.nextLoginAt = 0;
    this.sites = new Map(); // ключ сайта -> { level, coolUntil, lastLimitAt }
  }

  /** Резервирует место для загрузки с аккаунтом: { waitMs } или { blocked: true, retryInMs }. */
  reserveLogin() {
    const now = this.now();
    this.loginStarts = this.loginStarts.filter((ts) => now - ts < HOUR);
    if (this.loginStarts.length >= this.perHour) {
      return { blocked: true, retryInMs: Math.max(1000, this.loginStarts[0] + HOUR - now) };
    }
    const startAt = Math.max(now, this.nextLoginAt);
    const [lo, hi] = this.gapMs;
    const prevNext = this.nextLoginAt;
    this.nextLoginAt = startAt + lo + this.rnd() * (hi - lo);
    this.loginStarts.push(startAt);
    return { waitMs: Math.max(0, Math.round(startAt - now)), slot: { startAt, prevNext, nextAt: this.nextLoginAt } };
  }

  /** Загрузку отменили, не дождавшись старта: слот возвращается, часовой лимит не сгорает. */
  releaseLogin(slot) {
    if (!slot) return;
    const i = this.loginStarts.indexOf(slot.startAt);
    if (i >= 0) this.loginStarts.splice(i, 1);
    if (this.nextLoginAt === slot.nextAt) this.nextLoginAt = slot.prevNext; // только если после нас никто не встал в очередь
  }

  /** Сайт ответил 429: включаем общую паузу, каждый следующий подряд лимит делает её длиннее. */
  noteRateLimit(site = '*') {
    const now = this.now();
    const s = this.sites.get(site) || { level: 0, coolUntil: 0, lastLimitAt: 0 };
    if (now - s.lastLimitAt > CALM_RESET_MS) s.level = 0;
    s.level += 1;
    s.lastLimitAt = now;
    s.coolUntil = now + COOLDOWNS_MS[Math.min(s.level, COOLDOWNS_MS.length) - 1];
    this.sites.set(site, s);
  }

  /** Сколько миллисекунд ещё действует пауза для сайта. */
  cooldownLeft(site = '*') {
    const s = this.sites.get(site);
    return s ? Math.max(0, s.coolUntil - this.now()) : 0;
  }
}

/** Ключ сайта для пауз: youtu.be и youtube.com — один сайт, иначе последние две части домена. */
function siteKey(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host)) return 'youtube';
    return host.split('.').slice(-2).join('.');
  } catch { return '*'; }
}

const RATE_LIMIT_RE = /HTTP Error 429|Too Many Requests/i;
const isRateLimit = (text) => RATE_LIMIT_RE.test(String(text || ''));

module.exports = { Throttle, isRateLimit, siteKey, COOLDOWNS_MS };
