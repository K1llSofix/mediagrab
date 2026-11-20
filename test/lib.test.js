'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeZip } = require('./zipmaker');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ProgressTracker } = require('../lib/progress');
const { explain } = require('../lib/errors');
const ytdlp = require('../lib/ytdlp');
const pin = require('../lib/pinterest');
const { saveResponse } = require('../lib/download');

test('прогресс: два потока идут монотонно, обработка не доходит до 100%', () => {
  const t = new ProgressTracker({ expectedStreams: 2 });
  const seen = [];
  const feed = (l) => { const e = t.handleLine(l); if (e && e.percent != null) seen.push(e.percent); return e; };
  feed('[PROGRESS]|downloading|0|1000|NA|100|10|NA|NA');
  feed('[PROGRESS]|downloading|500|1000|NA|100|5|NA|NA');
  feed('[PROGRESS]|finished|1000|1000|NA|NA|NA|NA|NA');
  feed('[PROGRESS]|downloading|100|200|NA|50|2|NA|NA');
  const post = feed('[POST]|started|Merger');
  assert.equal(post.text, 'Склейка видео и звука…');
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i] >= seen[i - 1], 'монотонность');
  assert.ok(Math.abs(seen[1] - 0.45) < 1e-9);
  assert.ok(post.percent < 1);
  assert.equal(t.handleLine('[FILE]C:\\Видео\\Клип [abc].mp4').path, 'C:\\Видео\\Клип [abc].mp4');
});

test('прогресс: фрагменты без размера и набор файлов', () => {
  const t = new ProgressTracker();
  assert.equal(t.handleLine('[download] Downloading item 2 of 4').entries, 4);
  const e = t.handleLine('[PROGRESS]|downloading|10|NA|NA|NA|NA|3|10');
  assert.ok(Math.abs(e.percent - (1 + 0.3) / 4) < 1e-9);
  const n = t.handleLine('[PROGRESS]|downloading|10|NA|NA|NA|NA|NA|NA');
  assert.equal(n.percent, null);
});

test('ошибки: понятные сообщения', () => {
  assert.match(explain('ERROR: [youtube] x: Sign in to confirm you’re not a bot'), /не бот/);
  assert.match(explain('ERROR: [Instagram] x: Instagram sent an empty media response. Check if this post is accessible in your browser'), /вход в аккаунт/);
  assert.match(explain('ERROR: Unsupported URL: https://example.com'), /не поддерживается/);
  assert.match(explain('ERROR: [x] y: something weird'), /something weird/);
});

test('аргументы: mp4 1080 и mp3 192', () => {
  const ctx = { ffmpegPath: '/ff', jsRuntimePath: '/electron', cookiesBrowser: 'firefox', proxy: 'http://p:1' };
  const a = ytdlp.buildDownloadArgs({ url: 'https://youtu.be/x', format: 'mp4', quality: '1080', outDir: '/out' }, ctx);
  assert.ok(a.includes('res:1080,vcodec:h264,acodec:aac'));
  assert.ok(a.includes('--merge-output-format'));
  assert.deepEqual(a.slice(-2), ['--', 'https://youtu.be/x']);
  assert.ok(a.join(' ').includes('--cookies-from-browser firefox'));
  assert.ok(a.join(' ').includes('--js-runtimes node:/electron'));
  const b = ytdlp.buildDownloadArgs({ url: 'https://vk.com/video1', format: 'mp3', quality: '192', outDir: '/o' }, {});
  assert.ok(b.includes('--audio-format') && b.includes('192K') && b.includes('-x'));
  const best = ytdlp.buildDownloadArgs({ url: 'u', format: 'mp4', quality: 'best', outDir: '/o' }, {});
  assert.ok(best.includes('res,vcodec:h264,acodec:aac'));
  assert.throws(() => ytdlp.buildDownloadArgs({ url: 'u', format: 'mp4', quality: '1080;rm', outDir: '/o' }, {}));
  assert.throws(() => ytdlp.buildDownloadArgs({ url: 'u', format: 'exe', quality: '1', outDir: '/o' }, {}));
});

test('normalizeInfo: качество по меньшей стороне, раздельные потоки', () => {
  const info = ytdlp.normalizeInfo({
    title: 'T', uploader: 'U', duration: 61, extractor_key: 'Youtube',
    formats: [
      { vcodec: 'avc1', acodec: 'none', width: 1080, height: 1920 },
      { vcodec: 'vp9', acodec: 'none', width: 1280, height: 720 },
      { vcodec: 'none', acodec: 'mp4a' },
      { vcodec: 'none', acodec: 'none', ext: 'mhtml' },
    ],
  });
  assert.deepEqual(info.heights, [1080, 720]);
  assert.equal(info.splitStreams, true);
  const tt = ytdlp.normalizeInfo({ title: 'x', formats: [{ vcodec: 'h264', acodec: 'aac', width: 576, height: 1024 }] });
  assert.deepEqual(tt.heights, [576]);
  assert.equal(tt.splitStreams, false);
});

test('Pinterest: ссылки, оригинал, разбор страницы', async () => {
  assert.ok(pin.isPinterestUrl('https://ru.pinterest.com/pin/123/'));
  assert.ok(pin.isPinterestUrl('https://pin.it/abc'));
  assert.ok(!pin.isPinterestUrl('https://notpinterest.com/x'));
  assert.equal(pin.originalImageUrl('https://i.pinimg.com/736x/ab/cd/x.jpg'), 'https://i.pinimg.com/originals/ab/cd/x.jpg');
  assert.equal(pin.originalImageUrl('https://evil.com/736x/x.jpg'), null);
  const html = '<head><meta content="https://i.pinimg.com/736x/aa/bb/c.jpg" property="og:image"><meta property="og:title" content="Кот &amp; лампа | Pinterest"></head>';
  const info = await pin.scrapePin('https://pin.it/x', async () => ({ ok: true, url: 'https://www.pinterest.com/pin/slug--555/', text: async () => html }));
  assert.equal(info.kind, 'image');
  assert.equal(info.image.basename, 'Кот & лампа [555]');
  assert.equal(info.image.originalUrl, 'https://i.pinimg.com/originals/aa/bb/c.jpg');
  const video = await pin.scrapePin('u', async () => ({ ok: true, url: 'u', text: async () => html + '<meta property="og:video" content="https://v/x.mp4">' }));
  assert.equal(video, null);
});

test('saveResponse: пишет файл и сообщает прогресс', async () => {
  const server = http.createServer((_, res) => res.end(Buffer.alloc(5000, 7)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-'));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    let last = 0;
    const dest = path.join(dir, 'f.bin');
    await saveResponse(res, dest, (d) => { last = d; });
    assert.equal(fs.statSync(dest).size, 5000);
    assert.equal(last, 5000);
    assert.ok(!fs.existsSync(`${dest}.part`));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isCookieError распознаёт сбой чтения кук', () => {
  const { isCookieError } = require('../lib/errors');
  assert.ok(isCookieError('ERROR: Could not copy Chrome cookie database. See https://github.com/yt-dlp/yt-dlp/issues/7271'));
  assert.ok(!isCookieError('ERROR: Unsupported URL'));
});

test('unzip: достаёт файл из настоящего ZIP (deflate и stored)', async () => {
  const { extractFile } = require('../lib/unzip');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-zip-'));
  try {
    const payload = Buffer.concat([require('node:crypto').randomBytes(200000), Buffer.alloc(300000, 'deno')]);
    fs.writeFileSync(path.join(dir, 'a.zip'), makeZip([{ name: 'deno', data: payload }]));
    fs.writeFileSync(path.join(dir, 'b.zip'), makeZip([{ name: 'deno', data: payload, store: true }]));
    for (const z of ['a.zip', 'b.zip']) {
      const out = path.join(dir, `out-${z}`);
      await extractFile(path.join(dir, z), 'deno', out);
      assert.ok(fs.readFileSync(out).equals(payload), z);
    }
    await assert.rejects(extractFile(path.join(dir, 'a.zip'), 'nope', path.join(dir, 'x')), /не удалось распаковать|nope/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Deno: имена архивов и аргументы yt-dlp', () => {
  const { denoAsset, denoPath } = require('../lib/deno');
  assert.equal(denoAsset('win32', 'x64'), 'deno-x86_64-pc-windows-msvc.zip');
  assert.equal(denoAsset('darwin', 'arm64'), 'deno-aarch64-apple-darwin.zip');
  assert.equal(denoAsset('linux', 'x64'), 'deno-x86_64-unknown-linux-gnu.zip');
  assert.ok(denoPath('/b', 'win32').endsWith('deno.exe'));
  const args = ytdlp.commonArgs({ denoPath: '/b/deno', jsRuntimePath: '/electron' }).join(' ');
  assert.ok(args.includes('--js-runtimes deno:/b/deno'));
  assert.ok(args.includes('--js-runtimes node:/electron'));
});

test('автоповтор: временные сбои отличаются от постоянных', () => {
  const { isTransientError } = require('../lib/errors');
  assert.ok(isTransientError('ERROR: Unable to download webpage: <urlopen error timed out>'));
  assert.ok(isTransientError('ERROR: unable to download video data: HTTP Error 503'));
  assert.ok(!isTransientError('ERROR: [youtube] x: Private video'));
  assert.ok(!isTransientError('ERROR: Unsupported URL: https://example.com'));
});

test('сообщения: английский язык и возврат на русский', () => {
  const { setLang, t } = require('../lib/messages');
  try {
    setLang('en');
    assert.match(explain('ERROR: Unsupported URL: x'), /not supported/);
    const tr = new ProgressTracker();
    assert.equal(tr.handleLine('[POST]|started|Merger').text, 'Merging video and audio…');
    setLang('xx'); // неизвестный язык -> английский (его поймёт больше людей)
    assert.equal(t('proc.aborted'), 'Cancelled');
  } finally {
    setLang('ru');
  }
});

test('yt-dlp запускается с принудительным UTF-8', () => {
  const a = ytdlp.commonArgs({});
  const i = a.indexOf('--encoding');
  assert.ok(i >= 0 && a[i + 1] === 'utf-8');
});

test('cookies: экспорт в формат Netscape и признак входа', () => {
  const { toNetscape, hasLogin } = require('../lib/cookies');
  const cookies = [
    { name: 'SAPISID', value: 'abc', domain: '.youtube.com', hostOnly: false, path: '/', secure: true, httpOnly: false, expirationDate: 2000000000.5 },
    { name: 'LOGIN_INFO', value: 'x', domain: '.youtube.com', hostOnly: false, path: '/', secure: true, httpOnly: true, session: true },
    { name: 'host', value: 'h', domain: 'accounts.google.com', hostOnly: true, path: '/', secure: false, httpOnly: false, expirationDate: 2000000001 },
    { name: 'other', value: 'o', domain: '.example.com', hostOnly: false, path: '/', secure: false, httpOnly: false, expirationDate: 2000000001 },
  ];
  assert.ok(hasLogin(cookies));
  assert.ok(!hasLogin(cookies.slice(1)));
  const lines = toNetscape(cookies, 1_700_000_000_000).split('\n');
  assert.equal(lines[0], '# Netscape HTTP Cookie File');
  assert.ok(lines.includes('.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSAPISID\tabc'));
  assert.ok(lines.includes(`#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t${1_700_000_000 + 30 * 86400}\tLOGIN_INFO\tx`));
  assert.ok(lines.includes('accounts.google.com\tFALSE\t/\tFALSE\t2000000001\thost\th'));
  assert.ok(!lines.some((l) => l.includes('example.com')));
});

test('«вы не бот»: распознавание и запасные клиенты', () => {
  const { isBotError } = require('../lib/errors');
  assert.ok(isBotError('ERROR: Sign in to confirm you’re not a bot.'));
  assert.ok(!isBotError('ERROR: Private video'));
  assert.ok(ytdlp.commonArgs({ altClients: true }).join(' ').includes('youtube:player_client='));
  assert.ok(!ytdlp.commonArgs({}).join(' ').includes('player_client'));
});

test('опции загрузки: имя, лимит, обложка, субтитры, фрагмент', () => {
  const base = { url: 'https://youtu.be/x', format: 'mp4', quality: '720', outDir: '/o' };
  const a = ytdlp.buildDownloadArgs({ ...base, nameTemplate: 'site', limitRate: '2M', subs: true, subLangs: 'ru,en', clipStart: '1:20', clipEnd: '2:05' }, {});
  const s = a.join(' ');
  assert.ok(s.includes('%(extractor_key)s/%(title).120s'));
  assert.ok(s.includes('--limit-rate 2M'));
  assert.ok(s.includes('--sub-langs ru,en') && s.includes('--embed-subs'));
  assert.ok(s.includes('--download-sections *1:20-2:05'));
  const m = ytdlp.buildDownloadArgs({ ...base, format: 'mp3', quality: '320', embedCover: true, subs: true, subLangs: 'ru' }, {}).join(' ');
  assert.ok(m.includes('--embed-thumbnail') && !m.includes('--embed-subs'));
  // мусор из интерфейса не попадает в аргументы
  const bad = ytdlp.buildDownloadArgs({ ...base, nameTemplate: '%(x)s', limitRate: '2M; rm', subs: true, subLangs: 'ru --exec x' }, {}).join(' ');
  assert.ok(!bad.includes('--limit-rate') && !bad.includes('--sub-langs') && bad.includes('%(title).120s'));
  assert.equal(ytdlp.buildSection('', ''), null);
  assert.equal(ytdlp.buildSection('', '90'), '*0-90');
  assert.equal(ytdlp.buildSection('1:00', ''), '*1:00-inf');
  assert.throws(() => ytdlp.buildSection('abc', '1:00'));
});

test('normalizeInfo: список плейлиста для выбора, карусель без списка', () => {
  const entries = [1, 2, 3].map((i) => ({ url: `https://www.youtube.com/watch?v=${i}`, title: `V${i}`, duration: 60 * i }));
  const pl = ytdlp.normalizeInfo({ _type: 'playlist', extractor_key: 'YoutubeTab', title: 'Мой плейлист', entries });
  assert.equal(pl.collection, true);
  assert.equal(pl.entries.length, 3);
  assert.equal(pl.entries[2].duration, 180);
  const carousel = ytdlp.normalizeInfo({ _type: 'playlist', extractor_key: 'Instagram', title: 'Пост', entries });
  assert.equal(carousel.collection, false);
  assert.deepEqual(carousel.entries, []);
});

test('browserLogin: поиск браузера и куки DevTools', () => {
  const { findBrowser, fromCdpCookies, hasYoutubeLogin, browserCandidates } = require('../lib/browserLogin');
  const env = { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  assert.ok(browserCandidates('win32', env).some((p) => /msedge\.exe$/.test(p)));
  const edge = browserCandidates('win32', env).find((p) => /msedge\.exe$/.test(p));
  assert.equal(findBrowser((p) => p === edge, 'win32', env), edge);
  assert.equal(findBrowser(() => false, 'win32', env), null);

  const list = fromCdpCookies([
    { name: 'SAPISID', value: 'x', domain: '.youtube.com', path: '/', expires: 2000000000, secure: true, httpOnly: false, session: false },
    { name: 'tmp', value: 'y', domain: 'www.youtube.com', path: '/', expires: -1, session: true },
  ]);
  assert.equal(list[0].hostOnly, false);
  assert.equal(list[1].hostOnly, true);
  assert.equal(list[1].session, true);
  assert.ok(hasYoutubeLogin(list));
  assert.ok(!hasYoutubeLogin([{ name: 'SAPISID', domain: '.google.com' }]));
  const txt = require('../lib/cookies').toNetscape(list);
  assert.match(txt, /\.youtube\.com\tTRUE\t\/\tTRUE\t2000000000\tSAPISID\tx/);
});

test('isLoginError: когда нужен вход', () => {
  const { isLoginError } = require('../lib/errors');
  assert.ok(isLoginError("ERROR: Sign in to confirm you're not a bot"));
  assert.ok(isLoginError('ERROR: This video is private'));
  assert.ok(isLoginError('ERROR: login required'));
  assert.ok(isLoginError('Sign in to confirm your age'));
  assert.ok(!isLoginError('ERROR: Unsupported URL'));
  assert.ok(!isLoginError('HTTP Error 429'));
});

test('isSubtitleError и пропуск субтитров', () => {
  const { isSubtitleError } = require('../lib/errors');
  assert.ok(isSubtitleError("ERROR: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests"));
  assert.ok(!isSubtitleError('ERROR: HTTP Error 429: Too Many Requests'));
  const a = ytdlp.buildDownloadArgs({ url: 'https://youtu.be/x', kind: 'video', format: 'mp4', quality: 'best', outDir: os.tmpdir(), subs: true, subLangs: 'ru,en' }, {});
  assert.ok(a.includes('--sleep-subtitles'));
});

test('Throttle: интервалы для аккаунта, лимит за час и общий cooldown', () => {
  const { Throttle, isRateLimit } = require('../lib/throttle');
  let now = 1_000_000;
  const th = new Throttle({ now: () => now, rnd: () => 0.5, gapMs: [5000, 10000], perHour: 3 });

  // старты с аккаунтом выстраиваются с интервалом 7.5 с
  assert.equal(th.reserveLogin().waitMs, 0);
  assert.equal(th.reserveLogin().waitMs, 7500);
  assert.equal(th.reserveLogin().waitMs, 15000);
  // четвёртый за час блокируется и сообщает, когда освободится слот
  const blocked = th.reserveLogin();
  assert.ok(blocked.blocked);
  assert.ok(blocked.retryInMs > 3_500_000 && blocked.retryInMs <= 3_600_000);
  // через час снова можно
  now += 3_600_001;
  assert.equal(th.reserveLogin().waitMs, 0);

  // 429: 1 мин, затем 3 мин, затем 5 мин; после спокойных 15 минут счёт сбрасывается
  assert.equal(th.cooldownLeft(), 0);
  th.noteRateLimit();
  assert.equal(th.cooldownLeft(), 60_000);
  now += 61_000;
  assert.equal(th.cooldownLeft(), 0);
  th.noteRateLimit();
  assert.equal(th.cooldownLeft(), 180_000);
  now += 181_000;
  th.noteRateLimit();
  assert.equal(th.cooldownLeft(), 300_000);
  now += 20 * 60_000;
  th.noteRateLimit();
  assert.equal(th.cooldownLeft(), 60_000);

  assert.ok(isRateLimit('ERROR: HTTP Error 429: Too Many Requests'));
  assert.ok(!isRateLimit('ERROR: Unsupported URL'));
});

test('все языки: те же ключи и подстановки, что в русском', () => {
  const vm = require('node:vm');
  const { DICT, setLang, t } = require('../lib/messages');
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

  const win = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/i18n.js'), 'utf8'), { window: win });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/i18n-more.js'), 'utf8'), { window: win });
  const ui = { ...win.I18N.dicts, ...win.I18N_MORE };

  for (const [name, dicts] of [['ui', ui], ['main', DICT]]) {
    for (const lang of ['en', 'uk', 'de', 'es']) {
      assert.ok(dicts[lang], `${name}: нет языка ${lang}`);
      assert.deepEqual(Object.keys(dicts[lang]).sort(), Object.keys(dicts.ru).sort(), `${name}/${lang}: набор ключей`);
      for (const k of Object.keys(dicts.ru)) assert.equal(ph(dicts[lang][k]), ph(dicts.ru[k]), `${name}/${lang}/${k}: подстановки`);
    }
  }
  setLang('de');
  assert.match(t('err.rate'), /Seite/);
  setLang('xx');
  assert.match(t('err.rate'), /rate-limiting/); // неизвестный язык -> английский
  setLang('ru');
});

test('прогресс: второй файл не держит 100%, а завышенная оценка не доходит до 100%', () => {
  // ждали один поток, но YouTube отдал видео и звук отдельно
  const tr = new ProgressTracker({ expectedStreams: 1 });
  tr.handleLine('[PROGRESS]|downloading|900|1000|NA|1000|1|NA|NA');
  tr.handleLine('[PROGRESS]|downloading|1000|1000|NA|1000|0|NA|NA');
  tr.handleLine('[PROGRESS]|finished|1000|1000|NA|NA|NA|NA|NA');
  const second = tr.handleLine('[PROGRESS]|downloading|100|1000|NA|1000|90|NA|NA');
  assert.ok(second.percent < 0.95, `было ${second.percent}`);
  assert.ok(second.percent >= 0.9);
  const later = tr.handleLine('[PROGRESS]|downloading|1000|1000|NA|1000|0|NA|NA');
  assert.equal(later.percent, 1);

  // оценка размера занижена: скачано больше «всего», но осталось ещё 100 секунд
  const t2 = new ProgressTracker({ expectedStreams: 1 });
  const ev = t2.handleLine('[PROGRESS]|downloading|1100|NA|1000|755000|103|NA|NA');
  assert.ok(ev.percent <= 0.99);
});

// ---------- Эксперимент: токен подтверждения ----------
const httpMod = require('node:http');

test('potoken: имена файлов по платформам', () => {
  const { serverAsset } = require('../lib/potoken');
  assert.equal(serverAsset('win32', 'x64'), 'bgutil-pot-windows-x86_64.exe');
  assert.equal(serverAsset('win32', 'arm64'), 'bgutil-pot-windows-x86_64.exe');
  assert.equal(serverAsset('darwin', 'x64'), 'bgutil-pot-macos-x86_64');
  assert.equal(serverAsset('darwin', 'arm64'), 'bgutil-pot-macos-aarch64');
  assert.equal(serverAsset('linux', 'x64'), 'bgutil-pot-linux-x86_64');
  assert.equal(serverAsset('linux', 'arm64'), null);
});

test('unzip: extractAll распаковывает дерево и отвергает «zip slip»', async () => {
  const { extractAll } = require('../lib/unzip');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-zipall-'));
  try {
    fs.writeFileSync(path.join(dir, 'ok.zip'), makeZip([{ name: 'root/yt_dlp_plugins/extractor/p.py', data: '# plugin\n'.repeat(50) }]));
    const n = await extractAll(path.join(dir, 'ok.zip'), path.join(dir, 'out'));
    assert.ok(n >= 1);
    assert.match(fs.readFileSync(path.join(dir, 'out/root/yt_dlp_plugins/extractor/p.py'), 'utf8'), /plugin/);

    fs.writeFileSync(path.join(dir, 'bad.zip'), makeZip([{ name: '../evil.txt', data: 'x' }]));
    await assert.rejects(extractAll(path.join(dir, 'bad.zip'), path.join(dir, 'out2')), /unsafe|не удалось распаковать/i);
    assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('potoken: ensureComponents скачивает, раскладывает плагин, пропускает свежее и терпит сбой обновления', async () => {
  const { ensureComponents, isInstalled, serverAsset, PLUGIN_ZIP, pluginsRoot, serverPath } = require('../lib/potoken');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-pot-'));
  const platform = process.platform;
  const asset = serverAsset(platform, 'x64') || serverAsset('linux', 'x64');
  // плагин внутри корневой папки: так архивы часто и собирают
  fs.writeFileSync(path.join(dir, 'plugin.zip'), makeZip([{ name: 'bgutil-ytdlp-pot-provider-rs/yt_dlp_plugins/extractor/bgutil.py', data: 'x = 1\n' }]));

  const hits = [];
  let broken = false;
  const srv = httpMod.createServer((req, res) => {
    hits.push(req.url);
    if (broken) { res.statusCode = 500; res.end(); return; }
    if (req.url.endsWith(asset)) { res.setHeader('content-length', 9); res.end('FAKE-EXE!'); return; }
    if (req.url.endsWith(PLUGIN_ZIP)) { const b = fs.readFileSync(path.join(dir, 'plugin.zip')); res.setHeader('content-length', b.length); res.end(b); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const fetchFn = (u) => fetch(u);
  const binDir = path.join(dir, 'bin');
  try {
    assert.equal(isInstalled(binDir), false);
    const r = await ensureComponents({ binDir, fetchFn, base, platform: process.platform === 'win32' ? 'win32' : 'linux', arch: 'x64' });
    assert.equal(r.pluginsRoot, pluginsRoot(binDir));
    assert.equal(fs.readFileSync(serverPath(binDir), 'utf8'), 'FAKE-EXE!');
    // плагин вынут из корневой папки архива и лежит как <plugins>/bgutil-pot/yt_dlp_plugins/...
    assert.ok(fs.existsSync(path.join(pluginsRoot(binDir), 'bgutil-pot/yt_dlp_plugins/extractor/bgutil.py')));
    assert.equal(isInstalled(binDir), true);
    if (process.platform !== 'win32') assert.ok(fs.statSync(serverPath(binDir)).mode & 0o100, 'нет бита исполнения');

    // свежие файлы повторно не качаются
    const before = hits.length;
    await ensureComponents({ binDir, fetchFn, base, platform: process.platform === 'win32' ? 'win32' : 'linux', arch: 'x64' });
    assert.equal(hits.length, before);

    // устаревшие файлы + сервер отвечает 500: остаются старые, ошибки нет
    broken = true;
    await ensureComponents({ binDir, fetchFn, base, platform: process.platform === 'win32' ? 'win32' : 'linux', arch: 'x64', maxAgeMs: -1 });
    assert.equal(isInstalled(binDir), true);

    // с нуля и сервер сломан: понятная ошибка
    await assert.rejects(ensureComponents({ binDir: path.join(dir, 'bin2'), fetchFn, base, platform: 'linux', arch: 'x64' }), /HTTP 500|500/);
    // платформа без сборки
    await assert.rejects(ensureComponents({ binDir: path.join(dir, 'bin3'), fetchFn, base, platform: 'linux', arch: 'arm64' }), /нет готовой|no ready-made/i);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('potoken: PotServer запускает настоящий процесс, отвечает на /ping, перезапускается и останавливается', async () => {
  const { PotServer } = require('../lib/potoken');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-potsrv-'));
  const script = path.join(dir, 'fake-server.js');
  // поддельный bgutil-pot: понимает «server --host H --port N» и отвечает на любой запрос
  fs.writeFileSync(script, `
    const a = process.argv.slice(2);
    if (a[0] !== 'server') process.exit(2);
    const host = a[a.indexOf('--host') + 1]; const port = Number(a[a.indexOf('--port') + 1]);
    require('http').createServer((q, s) => s.end('{}')).listen(port, host);
  `);
  const get = (url) => new Promise((resolve) => httpMod.get(url, (r) => { r.resume(); resolve(r.statusCode); }).on('error', () => resolve(0)));
  const server = new PotServer({ exe: process.execPath, argsPrefix: [script], startTimeoutMs: 10000 });
  try {
    const url = await server.start();
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(await get(`${url}/ping`), 200);
    assert.equal(await server.start(), url, 'повторный start не запускает второй процесс');

    // процесс убили снаружи: следующий start поднимает новый
    server.child.kill();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(server.running, false);
    const url2 = await server.start();
    assert.equal(await get(`${url2}/ping`), 200);

    server.stop();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await get(`${url2}/ping`), 0, 'после stop порт закрыт');
  } finally {
    server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // программа, которая сразу падает: понятная ошибка, а не зависание
  const bad = new PotServer({ exe: process.execPath, argsPrefix: ['-e', 'process.exit(1)'], startTimeoutMs: 5000 });
  await assert.rejects(bad.start(), /не запустился|didn't start/i);
});

test('yt-dlp: аргументы с токеном подтверждения', () => {
  const po = { pluginsRoot: '/p/plugins', baseUrl: 'http://127.0.0.1:5555' };
  const a = ytdlp.buildInfoArgs('https://youtu.be/x', { po });
  assert.deepEqual(a.slice(a.indexOf('--plugin-dirs'), a.indexOf('--plugin-dirs') + 2), ['--plugin-dirs', '/p/plugins']);
  assert.ok(a.includes('youtubepot-bgutilhttp:base_url=http://127.0.0.1:5555'));
  assert.ok(a.includes('youtube:player_client=default,mweb'));
  // с запасными клиентами остаётся один список клиентов, без конфликта
  const b = ytdlp.buildInfoArgs('https://youtu.be/x', { po, altClients: true });
  assert.equal(b.filter((x) => x.startsWith('youtube:player_client=')).length, 1);
  // без эксперимента ничего лишнего
  assert.ok(!ytdlp.buildInfoArgs('https://youtu.be/x', {}).includes('--plugin-dirs'));
});

test('poDebugLines: только строки про плагины и токены, без аргументов командной строки', () => {
  const out = [
    '[debug] Command-line config: [\'--proxy\', \'http://user:secret@h:1\', \'--plugin-dirs\', \'/p\']',
    '[debug] Plugin directories: /p/bgutil-pot',
    '[debug] Loaded 2 plugins',
    '[debug] [youtube] [pot] PO Token Providers: bgutil:http-1.2.3 (external)',
    '[debug] Python 3.13',
    'ERROR: [youtube] x: Sign in to confirm you’re not a bot',
  ].join('\n');
  const lines = ytdlp.poDebugLines(out);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => !l.includes('secret')));
  assert.ok(lines.some((l) => /PO Token Providers/.test(l)));
  assert.deepEqual(ytdlp.poDebugLines('ERROR: x'), []);
  assert.ok(ytdlp.buildInfoArgs('https://youtu.be/x', { po: { pluginsRoot: '/p', baseUrl: 'http://127.0.0.1:1' } }).includes('-v'));
  assert.ok(!ytdlp.buildInfoArgs('https://youtu.be/x', {}).includes('-v'));
});

test('запасные клиенты YouTube сохраняют mweb при включённом токене', () => {
  const po = { pluginsRoot: '/p', baseUrl: 'http://127.0.0.1:1' };
  const withPo = ytdlp.buildInfoArgs('https://youtu.be/x', { po, altClients: true });
  assert.ok(withPo.includes('youtube:player_client=tv,android_vr,web_safari,mweb'));
  const without = ytdlp.buildInfoArgs('https://youtu.be/x', { altClients: true });
  assert.ok(without.includes('youtube:player_client=tv,android_vr,web_safari'));
});

// ---------- Форматы: WebM, M4A, FLAC, GIF ----------
test('форматы: аргументы yt-dlp для webm, m4a, flac и gif, проверка ввода', () => {
  const base = { url: 'https://youtu.be/x', outDir: os.tmpdir(), embedCover: true };
  const arg = (a, k) => a[a.indexOf(k) + 1];

  const webm = ytdlp.buildDownloadArgs({ ...base, format: 'webm', quality: '720', subs: true, subLangs: 'ru' }, {});
  assert.equal(arg(webm, '--merge-output-format'), 'webm');
  assert.match(arg(webm, '-f'), /ext=webm/);
  assert.equal(arg(webm, '-S'), 'res:720,vcodec:vp9');
  assert.ok(webm.includes('--embed-subs'));
  assert.ok(!webm.includes('--remux-video'));

  const m4a = ytdlp.buildDownloadArgs({ ...base, format: 'm4a', quality: 'best' }, {});
  assert.equal(arg(m4a, '--audio-format'), 'm4a');
  assert.ok(!m4a.includes('--audio-quality'));
  assert.ok(m4a.includes('--embed-thumbnail'));

  const flac = ytdlp.buildDownloadArgs({ ...base, format: 'flac', quality: 'best' }, {});
  assert.equal(arg(flac, '--audio-format'), 'flac');
  assert.ok(flac.includes('--embed-thumbnail')); // обложка во FLAC (вшивается через mutagen в самом yt-dlp)

  const gif = ytdlp.buildDownloadArgs({ ...base, format: 'gif', quality: '480', clipStart: '1:05', clipEnd: '1:20' }, {});
  assert.equal(arg(gif, '--download-sections'), '*1:05-1:20');
  assert.ok(!gif.includes('--embed-subs') && !gif.includes('--audio-format'));
  assert.equal(arg(gif, '--merge-output-format'), 'mp4');

  // GIF: нужен конец, не длиннее 30 секунд, допустимая ширина
  assert.throws(() => ytdlp.buildDownloadArgs({ ...base, format: 'gif', quality: '480' }, {}), /GIF/);
  assert.throws(() => ytdlp.buildDownloadArgs({ ...base, format: 'gif', quality: '480', clipStart: '0', clipEnd: '31' }, {}), /GIF/);
  assert.throws(() => ytdlp.buildDownloadArgs({ ...base, format: 'gif', quality: '480', clipStart: '10', clipEnd: '10' }, {}), /GIF/);
  assert.doesNotThrow(() => ytdlp.buildDownloadArgs({ ...base, format: 'gif', quality: '320', clipEnd: '30' }, {}));
  assert.throws(() => ytdlp.buildDownloadArgs({ ...base, format: 'gif', quality: '999', clipEnd: '5' }, {}), /качество|quality/i);
  assert.throws(() => ytdlp.buildDownloadArgs({ ...base, format: 'ogg', quality: 'best' }, {}), /формат|format/i);
  assert.throws(() => ytdlp.buildDownloadArgs({ ...base, format: 'm4a', quality: '128' }, {}), /качество|quality/i);

  assert.equal(ytdlp.clockToSeconds('1:02:30'), 3750);
  assert.equal(ytdlp.clockToSeconds('90'), 90);
  assert.equal(ytdlp.clockToSeconds(''), null);
  assert.ok(Number.isNaN(ytdlp.clockToSeconds('abc')));
});

test('gif: настоящий ffmpeg превращает видео в GIF нужной ширины, отмена и ошибки', { skip: !require('node:child_process').spawnSync('ffmpeg', ['-version']).stdout }, async () => {
  const { makeGif } = require('../lib/gif');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-gif-'));
  try {
    const src = path.join(dir, 'clip.mp4');
    const gen = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24:duration=3', '-pix_fmt', 'yuv420p', src]);
    assert.equal(gen.status, 0, String(gen.stderr));

    const out = path.join(dir, 'clip.gif');
    const r = await makeGif({ ffmpeg: 'ffmpeg', input: src, output: out, width: '320' });
    assert.deepEqual(r, { ok: true });
    const head = fs.readFileSync(out).subarray(0, 6).toString('ascii');
    assert.match(head, /^GIF8[79]a$/);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out]);
    assert.equal(String(probe.stdout).trim(), '320,180');

    // ffmpeg не нашёл входной файл: { ok: false } с текстом ошибки
    const bad = await makeGif({ ffmpeg: 'ffmpeg', input: path.join(dir, 'nope.mp4'), output: path.join(dir, 'x.gif'), width: '480' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /nope\.mp4|No such file/i);
    // нет самого ffmpeg
    const missing = await makeGif({ ffmpeg: path.join(dir, 'no-ffmpeg'), input: src, output: path.join(dir, 'y.gif'), width: '480' });
    assert.equal(missing.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('subs-core: URL канала, новые записи, лимиты', () => {
  const S = require('../renderer/subs-core');
  assert.equal(S.normalizeSubUrl('https://www.youtube.com/@abc'), 'https://www.youtube.com/@abc/videos');
  assert.equal(S.normalizeSubUrl('https://youtube.com/@abc/shorts'), 'https://youtube.com/@abc/shorts');
  assert.equal(S.normalizeSubUrl('https://www.youtube.com/playlist?list=PL1'), 'https://www.youtube.com/playlist?list=PL1');
  assert.equal(S.normalizeSubUrl('javascript:alert(1)'), '');
  assert.equal(S.normalizeSubUrl('мусор'), '');
  const e = (n) => ({ url: `https://y/${n}`, title: `v${n}` });
  const sub = S.makeSub({ url: 'https://y/c', title: 'C', format: 'mp4', entries: [e(3), e(2), e(1)] });
  assert.deepEqual(S.newEntries(sub, [e(3), e(2), e(1)]), []);
  // новые идут от старых к новым
  assert.deepEqual(S.newEntries(sub, [e(5), e(4), e(3)]).map((x) => x.title), ['v4', 'v5']);
  S.markSeen(sub, [e(5), e(4)]);
  assert.deepEqual(S.newEntries(sub, [e(5), e(4)]), []);
  assert.ok(S.isDue({ lastCheck: 0 }) && !S.isDue({ lastCheck: Date.now() }));
  const many = Array.from({ length: 700 }, (_, i) => e(i));
  S.markSeen(sub, many);
  assert.ok(sub.seen.length <= S.MAX_SEEN);
  assert.deepEqual(S.sanitizeSubs([{ url: 'x' }, null, { url: 'https://a', seen: [1, 'b'] }, { url: 'https://a' }]).map((x) => x.seen), [['b']]);
});

test('playlistEnd попадает в аргументы получения информации', () => {
  const y = require('../lib/ytdlp');
  const a = y.buildInfoArgs('https://y/c', { playlistEnd: 15 });
  assert.equal(a[a.indexOf('--playlist-end') + 1], '15');
  assert.ok(!y.buildInfoArgs('https://y/c', {}).includes('--playlist-end'));
});

test('paths: перетаскивать можно только существующий файл по абсолютному пути', () => {
  const { isDraggableFile } = require('../lib/paths');
  const f = path.join(os.tmpdir(), `mg-drag-${process.pid}.txt`);
  fs.writeFileSync(f, 'x');
  assert.equal(isDraggableFile(f), true);
  assert.equal(isDraggableFile(os.tmpdir()), false);
  assert.equal(isDraggableFile('relative.txt'), false);
  assert.equal(isDraggableFile(`${f}\0`), false);
  assert.equal(isDraggableFile(null), false);
  fs.unlinkSync(f);
  assert.equal(isDraggableFile(f), false);
});

test('SoundCloud: трек — только аудио, set — плейлист', () => {
  const track = ytdlp.normalizeInfo({
    extractor_key: 'Soundcloud', title: 'Song', uploader: 'A', duration: 200, thumbnail: 'http://x/a.jpg',
    formats: [{ acodec: 'mp3', vcodec: 'none', ext: 'mp3' }, { acodec: 'opus', vcodec: 'none', ext: 'opus' }],
  });
  assert.equal(track.audioOnly, true);
  assert.deepEqual(track.heights, []);
  const set = ytdlp.normalizeInfo({
    _type: 'playlist', extractor_key: 'SoundcloudSet', title: 'Mix',
    entries: [{ url: 'https://soundcloud.com/a/1', title: '1' }, { url: 'https://soundcloud.com/a/2', title: '2' }],
  });
  assert.equal(set.collection, true);
  assert.equal(set.entries.length, 2);
});

test('fsx: renameRetry повторяет только временные ошибки, isDirectory отличает папку от файла', async () => {
  const { renameRetry, isDirectory } = require('../lib/fsx');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-fsx-'));
  const a = path.join(dir, 'a'); const b = path.join(dir, 'b');
  fs.writeFileSync(a, '1');
  await renameRetry(a, b);
  assert.equal(fs.readFileSync(b, 'utf8'), '1');
  const t0 = Date.now();
  await assert.rejects(renameRetry(path.join(dir, 'nope'), b, [500, 500]), { code: 'ENOENT' });
  assert.ok(Date.now() - t0 < 400, 'ENOENT не повторяется');
  // имитация временной блокировки: первые две попытки EPERM
  const orig = fs.promises.rename; let n = 0;
  fs.promises.rename = async (...args) => { n += 1; if (n < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' }); return orig(...args); };
  try { await renameRetry(b, a, [10, 10, 10]); } finally { fs.promises.rename = orig; }
  assert.equal(n, 3);
  assert.equal(isDirectory(dir), true);
  assert.equal(isDirectory(a), false);
  assert.equal(isDirectory(''), false);
  fs.rmSync(dir, { recursive: true });
});

test('subs-core: при 15 новых за проверку ничего не теряется', () => {
  const S = require('../renderer/subs-core');
  const e = (n) => ({ url: `https://y/${n}`, title: `v${n}` });
  const sub = S.makeSub({ url: 'https://y/c', title: 'C', format: 'mp4', entries: [e(0)] });
  const feed = Array.from({ length: S.FRESH_WINDOW }, (_, i) => e(100 - i));
  const fresh = S.newEntries(sub, feed);
  assert.equal(fresh.length, S.FRESH_WINDOW);
  S.markSeen(sub, fresh);
  assert.deepEqual(S.newEntries(sub, feed), []);
});

test('Throttle: пауза по сайтам и возврат слота при отмене', () => {
  const { Throttle, siteKey } = require('../lib/throttle');
  let now = 1_000_000;
  const th = new Throttle({ now: () => now, rnd: () => 0.5, gapMs: [5000, 10000], perHour: 2 });
  assert.equal(siteKey('https://youtu.be/x'), 'youtube');
  assert.equal(siteKey('https://www.youtube.com/watch?v=1'), 'youtube');
  assert.equal(siteKey('https://www.instagram.com/p/1'), 'instagram.com');
  th.noteRateLimit('instagram.com');
  assert.equal(th.cooldownLeft('instagram.com'), 60_000);
  assert.equal(th.cooldownLeft('youtube'), 0);
  // слот: отмена возвращает и интервал, и часовой лимит
  const a = th.reserveLogin();
  const b = th.reserveLogin();
  assert.ok(b.waitMs > 0 && !b.blocked);
  assert.equal(th.reserveLogin().blocked, true);
  th.releaseLogin(b.slot);
  const c = th.reserveLogin();
  assert.equal(c.blocked, undefined);
  assert.equal(c.waitMs, b.waitMs);
  th.releaseLogin(a.slot); // не ломается, если слот не последний
});

test('logger: маскировка секретов и ротация', () => {
  const { createLogger, mask } = require('../lib/logger');
  assert.equal(mask('proxy http://user:pa55@10.0.0.1:8080/x'), 'proxy http://***@10.0.0.1:8080/x');
  assert.match(mask('Cookie: SID=abc; HSID=def'), /Cookie: \*\*\*/);
  assert.match(mask('.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tsecretvalue'), /SAPISID\t\*\*\*/);
  assert.match(mask('--proxy socks5://u:p@h:1 -o x'), /--proxy \*\*\* -o x/);
  assert.equal(mask('обычный текст https://youtu.be/abc'), 'обычный текст https://youtu.be/abc');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-log-'));
  const log = createLogger(path.join(dir, 'logs'), { maxBytes: 300, keep: 2 });
  for (let i = 0; i < 40; i += 1) log.error(`line ${i} http://u:secret@h/`);
  const all = log.readAll();
  assert.ok(all.includes('line 39') && !all.includes('secret'));
  const files = fs.readdirSync(path.join(dir, 'logs')).sort();
  assert.ok(files.length <= 3, files.join());
  assert.ok(!all.includes('line 0 '), 'старое вытеснено ротацией');
  fs.rmSync(dir, { recursive: true });
});

test('winstate: окно за пределами мониторов получает позицию по умолчанию', () => {
  const { sanitizeState } = require('../lib/winstate');
  const mon = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  assert.deepEqual(sanitizeState({ x: 100, y: 50, width: 1200, height: 800, maximized: true }, mon), { width: 1200, height: 800, maximized: true, x: 100, y: 50 });
  assert.equal(sanitizeState({ x: 5000, y: 50, width: 1200, height: 800 }, mon).x, undefined); // монитор отключили
  const small = sanitizeState({ width: 100, height: 100 }, mon);
  assert.equal(small.width, 900); assert.equal(small.height, 600);
  assert.deepEqual(sanitizeState(null, mon), { width: 1080, height: 780, maximized: false });
  assert.equal(sanitizeState({ x: 'a', y: NaN, width: 'x' }, mon).x, undefined);
});

test('эфиры и точная вырезка', () => {
  const y = require('../lib/ytdlp');
  const base = { extractor_key: 'Youtube', title: 'T', formats: [{ vcodec: 'h264', acodec: 'none', height: 720, width: 1280 }] };
  assert.equal(y.normalizeInfo({ ...base, is_live: true }).live, true);
  assert.equal(y.normalizeInfo({ ...base, live_status: 'is_upcoming' }).live, true);
  assert.equal(y.normalizeInfo({ ...base, live_status: 'was_live' }).live, false);
  const job = { url: 'https://y/v', format: 'mp4', quality: 'best', outDir: '/tmp', clipStart: '0:10', clipEnd: '0:20' };
  assert.ok(!y.buildDownloadArgs(job, {}).includes('--force-keyframes-at-cuts'));
  assert.ok(y.buildDownloadArgs({ ...job, exactCut: true }, {}).includes('--force-keyframes-at-cuts'));
  assert.ok(y.buildDownloadArgs({ ...job, format: 'gif', quality: '480' }, {}).includes('--force-keyframes-at-cuts'));
  assert.ok(!y.buildDownloadArgs({ ...job, exactCut: true, clipStart: '', clipEnd: '' }, {}).includes('--force-keyframes-at-cuts'));
});

test('метаданные: качества с fps и размером, дорожки, субтитры, главы, язык звука', () => {
  const y = require('../lib/ytdlp');
  const raw = {
    extractor_key: 'Youtube', title: 'T', duration: 300,
    formats: [
      { vcodec: 'avc1', acodec: 'none', height: 1080, width: 1920, fps: 30, filesize: 100e6 },
      { vcodec: 'vp9', acodec: 'none', height: 1080, width: 1920, fps: 60, filesize_approx: 150e6 },
      { vcodec: 'avc1', acodec: 'none', height: 720, width: 1280, fps: 30 },
      { vcodec: 'none', acodec: 'opus', language: 'en-US', format_note: 'English original (default)', filesize: 5e6 },
      { vcodec: 'none', acodec: 'opus', language: 'ru', format_note: 'Russian', filesize: 5e6 },
    ],
    subtitles: { ru: [{}], 'en-US': [{}], live_chat: [{}] },
    automatic_captions: { 'en-orig': [{}], de: [{}], fr: [{}] },
    chapters: [{ title: 'Intro', start_time: 0, end_time: 60 }, { title: 'Main', start_time: 60.4, end_time: 400 }, { title: 'bad', start_time: 5, end_time: 5 }],
  };
  const n = y.normalizeInfo(raw);
  assert.deepEqual(n.qualities, [{ height: 1080, fps: 60, bytes: 155e6 }, { height: 720, fps: 30, bytes: 0 }]);
  assert.deepEqual(n.audioTracks.map((a) => [a.lang, a.original]), [['en-US', true], ['ru', false]]);
  assert.deepEqual(n.subs, { manual: ['ru', 'en-US'], auto: ['en-orig'] });
  assert.deepEqual(n.chapters, [{ title: 'Intro', start: 0, end: 60 }, { title: 'Main', start: 60, end: 300 }]);
  // одна дорожка — выбирать нечего
  assert.deepEqual(y.normalizeInfo({ ...raw, formats: raw.formats.slice(0, 4) }).audioTracks, []);
  const job = { url: 'https://y/v', format: 'mp4', quality: 'best', outDir: '/tmp', audioLang: 'en-US' };
  const f = (j) => { const a = y.buildDownloadArgs(j, {}); return a[a.indexOf('-f') + 1]; };
  assert.equal(f(job), 'bv*+ba[language^=en-US]/bv*+ba/b');
  assert.equal(f({ ...job, format: 'mp3', quality: '320' }), 'ba[language^=en-US]/ba/b');
  assert.equal(f({ ...job, audioLang: 'x; rm -rf' }), 'bv*+ba/b'); // мусор отбрасывается
  assert.equal(f({ ...job, format: 'webm' }).includes('[language^=en-US]'), true);
  assert.ok(y.buildDownloadArgs({ ...job, format: 'flac', quality: 'best', embedCover: true }, {}).includes('--embed-thumbnail'));
});

test('checksum: разбор файла сумм, проверка файла и пропуск, если сумм нет', async () => {
  const { parseSums, fetchExpected, verifyFile, sha256File } = require('../lib/checksum');
  const h1 = 'a'.repeat(64); const h2 = 'B'.repeat(64);
  const m = parseSums(`${h1}  yt-dlp.exe\n${h2} *yt-dlp_linux\nмусор\n`);
  assert.equal(m.get('yt-dlp.exe'), h1);
  assert.equal(m.get('yt-dlp_linux'), 'b'.repeat(64));
  assert.equal(parseSums(h1).get('*'), h1);
  const f = path.join(os.tmpdir(), `mg-sum-${process.pid}.bin`);
  fs.writeFileSync(f, 'hello');
  const real = await sha256File(f);
  assert.equal(real, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.deepEqual(await verifyFile(f, real), { checked: true, ok: true, actual: real });
  assert.equal((await verifyFile(f, h1)).ok, false);
  assert.deepEqual(await verifyFile(f, null), { checked: false, ok: true });
  const fakeFetch = (body, ok = true) => async () => ({ ok, text: async () => body });
  assert.equal(await fetchExpected({ fetchFn: fakeFetch(`${h1}  x.exe`), url: 'u', name: 'x.exe' }), h1);
  assert.equal(await fetchExpected({ fetchFn: fakeFetch('', false), url: 'u', name: 'x.exe' }), null);
  assert.equal(await fetchExpected({ fetchFn: async () => { throw new Error('net'); }, url: 'u', name: 'x.exe' }), null);
  fs.unlinkSync(f);
});

test('vault: куки шифруются на диске, временная копия удаляется, без шифрования — файл 0600', () => {
  const { createVault } = require('../lib/vault');
  const mk = (enabled) => ({
    isEncryptionAvailable: () => enabled,
    encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).toString('base64')}`),
    decryptString: (b) => Buffer.from(b.toString().slice(4), 'base64').toString(),
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-vault-'));
  const dir = path.join(root, 'data'); const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp);
  const v = createVault({ safeStorage: mk(true), dir, tmpRoot: tmp });
  assert.equal(v.filePath(), null);
  const p = v.save('# Netscape\nSAPISID\tsecret\n');
  assert.ok(fs.readFileSync(p, 'utf8').includes('secret'));
  assert.ok(!fs.readFileSync(v.encPath).toString().includes('secret'), 'на диске в открытом виде секрета нет');
  assert.ok(!fs.existsSync(v.plainPath));
  fs.appendFileSync(p, 'NEW\tcookie\n'); // yt-dlp обновил куки
  v.cleanup();
  assert.ok(!fs.existsSync(p) && fs.readdirSync(tmp).length === 0, 'временная копия удалена');
  const v2 = createVault({ safeStorage: mk(true), dir, tmpRoot: tmp });
  assert.ok(fs.readFileSync(v2.filePath(), 'utf8').includes('NEW\tcookie'), 'обновлённые куки сохранились');
  v2.remove();
  assert.equal(v2.filePath(), null);
  // старый открытый файл переезжает в шифрованное хранилище
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'youtube-cookies.txt'), 'old\tplain\n');
  const v3 = createVault({ safeStorage: mk(true), dir, tmpRoot: tmp });
  assert.ok(v3.filePath().startsWith(tmp));
  assert.ok(!fs.existsSync(path.join(dir, 'youtube-cookies.txt')) && fs.existsSync(v3.encPath));
  v3.remove();
  // без шифрования в системе: обычный файл
  const v4 = createVault({ safeStorage: mk(false), dir, tmpRoot: tmp });
  const p4 = v4.save('x\n');
  assert.equal(p4, v4.plainPath);
  assert.equal(v4.filePath(), v4.plainPath);
  v4.remove();
  fs.rmSync(root, { recursive: true, force: true });
});

test('VK: закрытое видео объясняется понятно, ссылки VK распознаются', () => {
  assert.match(explain('ERROR: [vk] -1_2: Access denied'), /VK/);
  assert.match(explain('ERROR: [vk:video] 5: This video is only available for registered users'), /VK/);
  assert.doesNotMatch(explain('ERROR: [youtube] x: Video is private'), /VK/);
  const re = /(^|\.)(vk\.com|vk\.ru|vkvideo\.ru|vk\.cc)$/;
  for (const h of ['vk.com', 'm.vk.com', 'vkvideo.ru', 'vk.ru', 'vk.cc']) assert.ok(re.test(h), h);
});

test('errors: ffmpeg не маскируется под «недоступно», 404 не повторяется, правила именованные', () => {
  const { isTransientError, isLoginError } = require('../lib/errors');
  assert.match(explain('ERROR: ffprobe and ffmpeg not found. Please install'), /ffmpeg/i);
  assert.doesNotMatch(explain('ERROR: ffprobe and ffmpeg not found. Please install'), /недоступно|unavailable/i);
  assert.equal(isTransientError('ERROR: Unable to download webpage: HTTP Error 404: Not Found'), false);
  assert.equal(isTransientError('ERROR: Unable to download webpage: HTTP Error 403: Forbidden'), false);
  assert.equal(isTransientError('ERROR: Unable to download webpage: HTTP Error 502: Bad Gateway'), true);
  assert.equal(isTransientError('ERROR: HTTP Error 429: Too Many Requests'), true);
  assert.equal(isTransientError('ERROR: Read timed out'), true);
  assert.equal(isLoginError("Sign in to confirm you’re not a bot"), true);
  assert.equal(isLoginError('HTTP Error 404'), false);
});

test('vault: sweepStale удаляет только свои остатки', () => {
  const { sweepStale } = require('../lib/vault');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-sweep-'));
  fs.mkdirSync(path.join(root, 'mediagrab-AbC123')); fs.writeFileSync(path.join(root, 'mediagrab-AbC123/cookies.txt'), 'x');
  fs.mkdirSync(path.join(root, 'other-dir')); fs.mkdirSync(path.join(root, 'mediagrab-notmine-long'));
  sweepStale([root, path.join(root, 'нет-такой')]);
  assert.deepEqual(fs.readdirSync(root).sort(), ['mediagrab-notmine-long', 'other-dir']);
  fs.rmSync(root, { recursive: true, force: true });
});
