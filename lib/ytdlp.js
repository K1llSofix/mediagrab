'use strict';

const { fetchExpected, verifyFile } = require('./checksum');
const fs = require('node:fs');
const path = require('node:path');
const { runCapture } = require('./proc');
const { saveResponse } = require('./download');
const { potArgs } = require('./potoken');
const { GIF_WIDTHS } = require('./gif');
const { t } = require('./messages');

const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
const BROWSERS = ['chrome', 'chromium', 'edge', 'firefox', 'brave', 'opera', 'vivaldi', 'safari'];
const ALLOWED_HEADERS = ['referer', 'origin', 'user-agent', 'cookie'];

/** Шаблоны имён файлов (выбираются по ключу, произвольный текст в yt-dlp не передаётся). */
const OUTPUT_TEMPLATES = {
  title: '%(title).120s [%(id)s].%(ext)s',
  uploader: '%(uploader).60s - %(title).100s [%(id)s].%(ext)s',
  site: '%(extractor_key)s/%(title).120s [%(id)s].%(ext)s',
};
const SUB_LANGS_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?(?:,[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?){0,9}$/;
const RATE_RE = /^\d{1,4}(?:\.\d+)?[KMG]$/i;
const VIDEO_FORMATS = ['mp4', 'webm', 'gif'];
const AUDIO_FORMATS = ['mp3', 'm4a', 'flac'];
const GIF_MAX_SECONDS = 30;
const TIME_RE = /^(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d+)?$|^\d+(?:\.\d+)?$/;

/** Безопасное имя файла из заголовка страницы (убираем спецсимволы и %, чтобы не сломать шаблон yt-dlp). */
function sanitizeFilename(title) {
  return String(title || '')
    .replace(/[\\/:*?"<>|%]+/g, ' ')
    .replace(/[\x00-\x1f]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 120);
}

/** «90», «1:30», «1:02:30» -> секунды; null для пустой строки, NaN для неверного ввода. */
function clockToSeconds(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (!TIME_RE.test(s)) return NaN;
  return s.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
}

/** GIF делается только из короткого фрагмента: нужны и начало, и конец, не длиннее 30 секунд. */
function checkGifClip(job) {
  const s = clockToSeconds(job.clipStart) || 0;
  const e = clockToSeconds(job.clipEnd);
  if (!(e > s) || e - s > GIF_MAX_SECONDS) throw new Error(t('yt.gif_clip', { max: GIF_MAX_SECONDS }));
}

/** Фрагмент видео: «с…до» -> аргумент --download-sections. Пустые поля = весь ролик. */
function buildSection(start, end) {
  const s = String(start || '').trim();
  const e = String(end || '').trim();
  if (!s && !e) return null;
  if ((s && !TIME_RE.test(s)) || (e && !TIME_RE.test(e))) throw new Error(t('yt.bad_time'));
  return `*${s || '0'}-${e || 'inf'}`;
}
const PROGRESS_DOWNLOAD =
  'download:[PROGRESS]|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|' +
  '%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|' +
  '%(progress.fragment_index)s|%(progress.fragment_count)s';
const PROGRESS_POST = 'postprocess:[POST]|%(progress.status)s|%(progress.postprocessor)s';

/** Имя официального standalone-бинарника yt-dlp для текущей платформы. */
function assetName(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

const binaryPath = (binDir) => path.join(binDir, assetName());

/** Скачивает yt-dlp при первом запуске. fetchFn — fetch (в Electron это net.fetch). */
async function ensureBinary({ binDir, fetchFn, onProgress }) {
  const bin = binaryPath(binDir);
  if (fs.existsSync(bin) && fs.statSync(bin).size > 1_000_000) return bin;
  fs.mkdirSync(binDir, { recursive: true });
  const res = await fetchFn(RELEASE_BASE + assetName());
  if (!res.ok) throw new Error(t('yt.download_failed', { what: 'yt-dlp', status: res.status }));
  await saveResponse(res, bin, onProgress);
  // сверка с официальным файлом сумм релиза; если его получить не удалось, проверка пропускается
  const expected = await fetchExpected({ fetchFn, url: `${RELEASE_BASE}SHA2-256SUMS`, name: assetName() });
  const v = await verifyFile(bin, expected);
  if (!v.ok) {
    await fs.promises.rm(bin, { force: true });
    throw new Error(t('yt.checksum_failed', { what: 'yt-dlp' }));
  }
  if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
  return bin;
}

async function getVersion(bin) {
  const { stdout } = await runCapture(bin, ['--version'], { timeoutMs: 20_000 });
  return stdout.trim();
}

/** Самообновление standalone-бинарника (сайты часто меняются, и yt-dlp нужно обновлять). */
async function updateBinary(bin) {
  const { code, stdout, stderr } = await runCapture(bin, ['-U'], { timeoutMs: 120_000 });
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || t('yt.update_failed'));
  return { output: stdout.trim(), version: await getVersion(bin) };
}

/** Общие аргументы для любого запуска yt-dlp. */
function commonArgs(ctx = {}) {
  // --encoding: standalone-exe игнорирует PYTHONUTF8, а без UTF-8 на Windows ломаются кириллица и кавычки в выводе.
  const a = ['--ignore-config', '--no-warnings', '--encoding', 'utf-8', '--socket-timeout', '30'];
  if (ctx.ffmpegPath) a.push('--ffmpeg-location', ctx.ffmpegPath);
  // Для YouTube yt-dlp нужен внешний JS-рантайм. Основной — скачанный Deno, запасной — Electron в режиме Node.
  if (ctx.denoPath) a.push('--js-runtimes', `deno:${ctx.denoPath}`);
  if (ctx.jsRuntimePath) a.push('--js-runtimes', `node:${ctx.jsRuntimePath}`);
  // Запасная попытка без входа: другие клиенты YouTube иногда не вызывают проверку «вы не бот».
  // Эксперимент: токен подтверждения. Плагин берёт токен у локального сервера, а клиент mweb без него не работает.
  if (ctx.po) a.push(...potArgs(ctx.po));
  if (ctx.altClients) a.push('--extractor-args', `youtube:player_client=tv,android_vr,web_safari${ctx.po ? ',mweb' : ''}`);
  else if (ctx.po) a.push('--extractor-args', 'youtube:player_client=default,mweb');
  if (ctx.proxy) a.push('--proxy', ctx.proxy);
  if (ctx.impersonate) a.push('--impersonate', 'chrome');
  if (ctx.cookiesFile) a.push('--cookies', ctx.cookiesFile);
  else if (ctx.cookiesBrowser && BROWSERS.includes(ctx.cookiesBrowser)) a.push('--cookies-from-browser', ctx.cookiesBrowser);
  if (ctx.headers && typeof ctx.headers === 'object') {
    for (const [k, v] of Object.entries(ctx.headers)) {
      const low = k.toLowerCase();
      if (!ALLOWED_HEADERS.includes(low) || typeof v !== 'string') continue;
      const clean = v.replace(/[\r\n\0]+/g, '').trim();
      if (!clean) continue;
      if (low === 'user-agent') a.push('--user-agent', clean);
      else if (low === 'referer') a.push('--referer', clean);
      else a.push('--add-header', `${k}:${clean}`);
    }
  }
  return a;
}

function buildInfoArgs(url, ctx) {
  // При включённом токене просим подробный вывод, чтобы в деталях ошибки было видно, загрузился ли плагин и выдан ли токен.
  const end = ctx && Number.isInteger(ctx.playlistEnd) && ctx.playlistEnd > 0 ? ['--playlist-end', String(Math.min(ctx.playlistEnd, 200))] : [];
  return [...commonArgs(ctx), ...(ctx && ctx.po ? ['-v'] : []), '--no-playlist', '--flat-playlist', ...end, '-J', '--', url];
}

/**
 * Из подробного вывода yt-dlp оставляет только строки про плагины и токены (без строки с аргументами:
 * в ней могут быть пароль прокси и пути).
 */
function poDebugLines(stderr, limit = 10) {
  return String(stderr || '').split(/\r?\n/)
    .filter((l) => /\[debug\]/.test(l) && !/Command-line config/i.test(l) && /plugin|PO Token|\bpot\b|bgutil/i.test(l))
    .map((l) => l.trim().slice(0, 240))
    .slice(0, limit);
}

/** Сортировка форматов: `res` — это меньшая сторона кадра, поэтому «1080p» корректно работает и для вертикальных Shorts/TikTok. */
function videoSort(quality) {
  const res = quality === 'best' ? 'res' : `res:${quality}`;
  return `${res},vcodec:h264,acodec:aac`;
}

function buildDownloadArgs(job, ctx) {
  const { url, format, quality, outDir } = job;
  if (!VIDEO_FORMATS.includes(format) && !AUDIO_FORMATS.includes(format)) throw new Error(t('yt.bad_format'));
  if ((format === 'mp4' || format === 'webm') && !(quality === 'best' || /^\d{2,4}$/.test(String(quality)))) throw new Error(t('yt.bad_quality'));
  if (format === 'mp3' && !/^\d{2,3}$/.test(String(quality))) throw new Error(t('yt.bad_bitrate'));
  if ((format === 'm4a' || format === 'flac') && quality !== 'best') throw new Error(t('yt.bad_quality'));
  const lang = typeof job.audioLang === 'string' && LANG_RE.test(job.audioLang) ? job.audioLang : '';
  if (format === 'gif') {
    if (!GIF_WIDTHS.includes(String(quality))) throw new Error(t('yt.bad_quality'));
    checkGifClip(job);
  }

  const customName = job.customTitle ? sanitizeFilename(job.customTitle) : '';
  const outTemplate = customName
    ? `${customName}.%(ext)s`
    : (OUTPUT_TEMPLATES[job.nameTemplate] || OUTPUT_TEMPLATES.title);

  // Для перехваченных потоков с балансеров лучше не давить CDN в 4 параллельных потока
  const fragments = '4';

  const args = [
    ...commonArgs(ctx),
    '--no-playlist',
    '--playlist-end', '200',
    '--newline', '--progress', '--no-quiet', '--no-simulate',
    '--windows-filenames',
    '--concurrent-fragments', fragments,
    '--retries', '10', '--fragment-retries', '10',
    '--embed-metadata',
    '-P', outDir,
    '-o', outTemplate,
    '--progress-template', PROGRESS_DOWNLOAD,
    '--progress-template', PROGRESS_POST,
    '--print', 'after_move:[FILE]%(filepath)s',
  ];

  if (format === 'mp4') {
    args.push('-f', lang ? `bv*+ba[language^=${lang}]/bv*+ba/b` : 'bv*+ba/b', '-S', videoSort(String(quality)), '--merge-output-format', 'mp4', '--remux-video', 'mp4');
  } else if (format === 'webm') {
    // Только потоки, уже лежащие в WebM (VP9 + Opus): склейка без перекодирования. Если таких нет, yt-dlp сообщит, что формат недоступен.
    const res = quality === 'best' ? 'res' : `res:${quality}`;
    args.push('-f', lang ? `bv*[ext=webm]+ba[ext=webm][language^=${lang}]/bv*[ext=webm]+ba[ext=webm]/b[ext=webm]` : 'bv*[ext=webm]+ba[ext=webm]/b[ext=webm]', '-S', `${res},vcodec:vp9`, '--merge-output-format', 'webm');
  } else if (format === 'gif') {
    // Скачиваем небольшое видео без звука, а GIF из него делает ffmpeg (см. main.js, lib/gif.js).
    args.push('-f', 'bv*/b', '-S', 'res:720,vcodec:h264', '--merge-output-format', 'mp4', '--remux-video', 'mp4');
  } else if (format === 'mp3') {
    args.push('-f', lang ? `ba[language^=${lang}]/ba/b` : 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', `${quality}K`);
  } else if (format === 'm4a') {
    args.push('-f', lang ? `ba[ext=m4a][language^=${lang}]/ba[ext=m4a]/ba/b` : 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'm4a');
  } else {
    args.push('-f', lang ? `ba[language^=${lang}]/ba/b` : 'ba/b', '-x', '--audio-format', 'flac');
  }
  if ((format === 'mp3' || format === 'm4a' || format === 'flac') && job.embedCover) args.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
  if ((format === 'mp4' || format === 'webm') && job.subs && SUB_LANGS_RE.test(String(job.subLangs || ''))) {
    args.push('--write-subs', '--write-auto-subs', '--sub-langs', String(job.subLangs), '--embed-subs', '--sleep-subtitles', '3');
  }
  if (RATE_RE.test(String(job.limitRate || ''))) args.push('--limit-rate', String(job.limitRate));
  const section = buildSection(job.clipStart, job.clipEnd);
  if (section) {
    args.push('--download-sections', section);
    // без этого границы сдвигаются к ближайшим ключевым кадрам (до нескольких секунд); для GIF точность обязательна
    if (format === 'gif' || job.exactCut === true) args.push('--force-keyframes-at-cuts');
  }
  args.push('--', url);
  return args;
}

async function fetchInfo({ bin, url, ctx, signal }) {
  const { code, stdout, stderr } = await runCapture(bin, buildInfoArgs(url, ctx), {
    env: ctx && ctx.env,
    signal,
    timeoutMs: 120_000,
  });
  if (code !== 0) {
    let msg = stderr.trim() || t('yt.exit_code', { code });
    if (ctx && ctx.po) {
      // сначала сами ошибки, затем строки про плагины и токены
      const errs = stderr.split(/\r?\n/).filter((l) => /^ERROR:/.test(l.trim())).join('\n');
      const dbg = poDebugLines(stderr);
      msg = `${errs || msg}\n[po-debug] ${dbg.length ? `\n${dbg.join('\n')}` : 'no plugin/token lines in yt-dlp output (plugin not loaded?)'}`;
    }
    throw new Error(msg);
  }
  const text = stdout.trim();
  const start = text.indexOf('{');
  if (start < 0) throw new Error(t('yt.parse_failed'));
  try {
    return JSON.parse(text.slice(start));
  } catch {
    throw new Error(t('yt.parse_failed'));
  }
}

const lastThumb = (o) => (o && (o.thumbnail || (Array.isArray(o.thumbnails) && o.thumbnails.length ? o.thumbnails[o.thumbnails.length - 1].url : null))) || null;
const isVideoFmt = (f) => f.vcodec && f.vcodec !== 'none';
const isAudioFmt = (f) => f.acodec && f.acodec !== 'none';

const side = (f) => (f.height && f.width ? Math.min(f.height, f.width) : f.height || f.width);
const sizeOf = (f) => (Number(f.filesize) > 0 ? Number(f.filesize) : Number(f.filesize_approx) > 0 ? Number(f.filesize_approx) : 0);

/** По каждой высоте: максимальная частота кадров и примерный размер файла (видео + лучшее аудио). */
function collectQualities(formats) {
  const audioBest = formats.filter((f) => isAudioFmt(f) && !isVideoFmt(f)).reduce((m, f) => Math.max(m, sizeOf(f)), 0);
  const by = new Map();
  for (const f of formats) {
    if (!isVideoFmt(f) || !side(f)) continue;
    const q = by.get(side(f)) || { height: side(f), fps: 0, bytes: 0 };
    if (Number(f.fps) > q.fps) q.fps = Math.round(Number(f.fps));
    const withAudio = isAudioFmt(f) ? 0 : audioBest; // в готовом потоке аудио уже есть
    q.bytes = Math.max(q.bytes, sizeOf(f) ? sizeOf(f) + withAudio : 0);
    by.set(q.height, q);
  }
  return [...by.values()].sort((a, b) => b.height - a.height);
}

const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

/** Языки аудиодорожек. Показываем только если их больше одной (иначе выбирать нечего). */
function collectAudioTracks(formats) {
  const by = new Map();
  for (const f of formats) {
    if (!isAudioFmt(f) || isVideoFmt(f) || typeof f.language !== 'string' || !LANG_RE.test(f.language)) continue;
    const key = f.language.toLowerCase();
    const cur = by.get(key) || { lang: f.language, original: false };
    if (/original/i.test(String(f.format_note || ''))) cur.original = true;
    by.set(key, cur);
  }
  return by.size > 1 ? [...by.values()].slice(0, 30) : [];
}

/** Субтитры: ручные и автоматические (у автоматических оставляем только язык оригинала, остальные — машинный перевод). */
function collectSubs(raw) {
  const ok = (code) => LANG_RE.test(code);
  const manual = Object.keys(raw.subtitles || {}).filter((c) => ok(c) && c !== 'live_chat');
  const auto = Object.keys(raw.automatic_captions || {})
    .filter((c) => /-orig$/.test(c) && ok(c));
  return { manual: manual.slice(0, 40), auto: auto.slice(0, 5) };
}

/** Главы ролика: для выбора фрагмента одним щелчком. */
function collectChapters(raw, duration) {
  if (!Array.isArray(raw.chapters)) return [];
  return raw.chapters
    .filter((c) => c && Number.isFinite(c.start_time) && Number.isFinite(c.end_time) && c.end_time > c.start_time)
    .slice(0, 100)
    .map((c) => ({
      title: String(c.title || '').slice(0, 120),
      start: Math.floor(c.start_time),
      end: duration ? Math.min(Math.ceil(c.end_time), Math.floor(duration)) : Math.ceil(c.end_time),
    }));
}

/** Приводит JSON yt-dlp к компактному виду для интерфейса. */
function normalizeInfo(raw) {
  if (!raw || typeof raw !== 'object') throw new Error(t('yt.empty'));
  const site = raw.extractor_key || raw.extractor || '';

  if (raw._type === 'playlist') {
    const entries = Array.isArray(raw.entries) ? raw.entries.filter(Boolean) : [];
    const first = entries[0] || {};
    // Плейлист/канал/профиль: пользователь выбирает видео. Карусель Instagram сюда не попадает.
    const looksLikeCollection = /Tab|Playlist|Channel|User|Album|Series|Collection|Mix|Profile/i.test(site) || /Set$/.test(site); // SoundcloudSet — это плейлист
    const list = looksLikeCollection
      ? entries.slice(0, 200)
          .map((e) => ({
            url: e.url || e.webpage_url || '',
            title: e.title || '',
            duration: typeof e.duration === 'number' ? e.duration : null,
          }))
          .filter((e) => /^https?:\/\//.test(e.url))
      : [];
    return {
      collection: list.length > 1,
      entries: list.length > 1 ? list : [],
      kind: 'playlist',
      title: raw.title || first.title || '',
      uploader: raw.uploader || raw.channel || first.uploader || null,
      duration: null,
      thumbnail: lastThumb(raw) || lastThumb(first),
      site,
      count: raw.playlist_count || entries.length || null,
      heights: [],
      splitStreams: false,
      audioOnly: false,
    };
  }

  const formats = Array.isArray(raw.formats) ? raw.formats : [];
  const sides = formats
    .filter((f) => isVideoFmt(f) && (f.height || f.width))
    .map((f) => (f.height && f.width ? Math.min(f.height, f.width) : f.height || f.width));
  const heights = [...new Set(sides)].sort((a, b) => b - a);
  const videoOnly = formats.some((f) => isVideoFmt(f) && !isAudioFmt(f));
  const qualities = collectQualities(formats);
  const audioOnly = formats.some((f) => isAudioFmt(f) && !isVideoFmt(f));

  return {
    kind: 'video',
    title: raw.title || raw.id || '',
    uploader: raw.uploader || raw.channel || null,
    duration: typeof raw.duration === 'number' ? raw.duration : null,
    thumbnail: lastThumb(raw),
    site,
    heights,
    splitStreams: videoOnly && audioOnly,
    audioOnly: heights.length === 0 && audioOnly,
    qualities,
    audioTracks: collectAudioTracks(formats),
    subs: collectSubs(raw),
    chapters: collectChapters(raw, typeof raw.duration === 'number' ? raw.duration : null),
    // идущий эфир или анонс: скачивать такое нельзя (загрузка зависла бы до конца трансляции)
    live: raw.is_live === true || raw.live_status === 'is_live' || raw.live_status === 'is_upcoming',
  };
}

module.exports = {
  VIDEO_FORMATS, AUDIO_FORMATS, GIF_MAX_SECONDS, clockToSeconds,
  poDebugLines,
  sanitizeFilename,
  assetName,
  binaryPath,
  ensureBinary,
  getVersion,
  updateBinary,
  commonArgs,
  buildInfoArgs,
  buildDownloadArgs,
  fetchInfo,
  normalizeInfo,
  buildSection,
  BROWSERS,
};
