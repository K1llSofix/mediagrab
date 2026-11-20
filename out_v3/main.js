'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, net, clipboard, session, Tray, Menu, nativeImage, screen, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ytdlp = require('./lib/ytdlp');
const deno = require('./lib/deno');
const pinterest = require('./lib/pinterest');
const sniffer = require('./lib/sniffer');
const { ProgressTracker } = require('./lib/progress');
const { explain, isCookieError, isTransientError, isBotError, isLoginError, isSubtitleError, isUnsupportedError } = require('./lib/errors');
const { toNetscape, hasLogin } = require('./lib/cookies');
const { findBrowser, startBrowserLogin } = require('./lib/browserLogin');
const { Throttle, isRateLimit, siteKey } = require('./lib/throttle');
const pot = require('./lib/potoken');
const { makeGif } = require('./lib/gif');
const { spawnTool, killTree } = require('./lib/proc');
const { saveResponse } = require('./lib/download');
const { isDraggableFile } = require('./lib/paths');
const { isDirectory } = require('./lib/fsx');
const { createLogger, mask } = require('./lib/logger');
const { sanitizeState } = require('./lib/winstate');
const { createVault } = require('./lib/vault');
const { t, setLang } = require('./lib/messages');

const RETRY_DELAYS_MS = [5000, 20000]; // автоповтор при сбоях сети: две дополнительные попытки

app.setAppUserModelId('com.mediagrab.app'); // без этого уведомления Windows приходят «от Electron»
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap() {
  let win = null;
  let bin = null; // путь к yt-dlp
  let denoBin = null; // путь к Deno (может не загрузиться — тогда запасной вариант)
  let initPromise = null;
  let appUpdater = null;
  const active = new Map(); // id -> { cancel() }
  const throttle = new Throttle(); // паузы для аккаунта и паузы по сайтам после 429
  const log = createLogger(path.join(app.getPath('userData'), 'logs'));
  log.info(`start MediaGrab ${app.getVersion()} electron ${process.versions.electron} ${process.platform}/${process.arch}`);

  // ---------- Кэш перехваченных потоков (HLS/DASH/MP4) ----------
  const sniffedById = new Map();
  const sniffedByUrl = new Map();
  const SNIFF_TTL_MS = 2 * 3600 * 1000;
  const snifferCookiesPath = () => path.join(app.getPath('userData'), 'sniffer-cookies.txt');

  function writeSnifferCookies(cookiesText) {
    if (!cookiesText || !cookiesText.trim()) return '';
    try {
      const p = snifferCookiesPath();
      fs.writeFileSync(p, cookiesText, { mode: 0o600 });
      return p;
    } catch {
      return '';
    }
  }
  app.on('before-quit', () => {
    try { fs.rmSync(snifferCookiesPath(), { force: true }); } catch { /* ignore */ }
  });

  function saveSniffed(id, pageUrl, entry) {
    const now = Date.now();
    const record = { ...entry, ts: now };
    if (id != null) sniffedById.set(id, record);
    sniffedByUrl.set(pageUrl, record);
    for (const map of [sniffedById, sniffedByUrl]) {
      for (const [k, v] of map) {
        if (now - v.ts > SNIFF_TTL_MS) map.delete(k);
      }
    }
  }

  function getSniffed(id, pageUrl) {
    const item = (id != null && sniffedById.get(id)) || sniffedByUrl.get(pageUrl) || null;
    if (!item || Date.now() - item.ts > SNIFF_TTL_MS) return null;
    return item;
  }

  // ---------- Эксперимент: токен подтверждения (PO Token) ----------
  let potServer = null;
  let poCurrent = null; // { pluginsRoot, baseUrl } пока сервер токенов работает

  /** Перед запросом: если эксперимент включён, убеждаемся, что сервер токенов жив (при необходимости запускаем заново). */
  async function getPo(opts) {
    if (!opts || opts.poToken !== true) return null;
    if (!pot.isInstalled(binDir())) { poCurrent = null; return null; }
    try {
      if (!potServer) potServer = new pot.PotServer({ exe: pot.serverPath(binDir()) });
      const baseUrl = await potServer.start();
      poCurrent = { pluginsRoot: pot.pluginsRoot(binDir()), baseUrl };
    } catch {
      poCurrent = null; // без токена продолжаем как обычно
    }
    return poCurrent;
  }

  ipcMain.handle('po:enable', async () => {
    try {
      // сначала останавливаем сервер: на Windows его запущенный .exe нельзя обновить
      if (potServer) { potServer.stop(); potServer = null; }
      await pot.ensureComponents({ binDir: binDir(), fetchFn });
      potServer = new pot.PotServer({ exe: pot.serverPath(binDir()) });
      const baseUrl = await potServer.start();
      poCurrent = { pluginsRoot: pot.pluginsRoot(binDir()), baseUrl };
      return { ok: true };
    } catch (e) {
      poCurrent = null;
      if (potServer) { potServer.stop(); potServer = null; }
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('po:disable', () => {
    if (potServer) { potServer.stop(); potServer = null; }
    poCurrent = null;
    return true;
  });
  app.on('before-quit', () => { if (potServer) potServer.stop(); });

  const isYoutubeUrl = (u) => { try { return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(new URL(u).hostname); } catch { return false; } };

  /** Сохранённый вход (куки из окна входа) или null. Подставляется только когда сайт сам потребовал вход. */
  const vault = createVault({ safeStorage, dir: app.getPath('userData') });
  const loginCookies = () => vault.filePath();
  app.on('before-quit', () => vault.cleanup()); // сохраняем обновлённые куки и удаляем временную расшифрованную копию

  const binDir = () => path.join(app.getPath('userData'), 'bin');
  const fetchFn = (url, opts) => net.fetch(url, opts);

  function ffmpegPath() {
    try {
      const p = require('ffmpeg-static');
      if (p) return p.replace('app.asar', 'app.asar.unpacked');
    } catch { /* возьмём ffmpeg из PATH */ }
    return null;
  }

  /** Контекст запуска yt-dlp: ffmpeg, JS-рантаймы для YouTube и пользовательские настройки. */
  function makeCtx(opts = {}) {
    const usePo = opts.poToken === true && !opts.sniffed && (!opts.url || isYoutubeUrl(opts.url));
    return {
      ffmpegPath: ffmpegPath(),
      denoPath: denoBin,
      jsRuntimePath: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: '1' }, // чтобы бинарник Electron вёл себя как Node для yt-dlp
      proxy: typeof opts.proxy === 'string' ? opts.proxy.trim() : '',
      cookiesBrowser: typeof opts.cookiesBrowser === 'string' ? opts.cookiesBrowser : '',
      cookiesFile: typeof opts.cookiesFile === 'string' && opts.cookiesFile ? opts.cookiesFile : '',
      headers: opts.headers && typeof opts.headers === 'object' ? opts.headers : null,
      impersonate: opts.impersonate === true,
      po: usePo ? poCurrent : null, // эксперимент: токен подтверждения (только для YouTube)
      playlistEnd: Number.isInteger(opts.playlistEnd) ? opts.playlistEnd : 0, // для подписок: смотрим только свежие видео
    };
  }

  /** Какие куки реально переданы в yt-dlp (для технических подробностей ошибки). */
  function cookieNote(ctx) {
    const po = ctx.po ? ' [po-token: on]' : '';
    if (ctx.cookiesFile) return `[cookies: file ${ctx.cookiesFile}]${po}`;
    if (ctx.cookiesBrowser) return `[cookies: browser ${ctx.cookiesBrowser}]${po}`;
    return `[cookies: none]${po}`;
  }

  const send = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const sendStatus = (payload) => send('app:status', payload);

  async function maybeAutoUpdate(binPath) {
    const stamp = path.join(binDir(), '.last-update-check');
    let last = 0;
    try { last = Number(fs.readFileSync(stamp, 'utf8')) || 0; } catch { /* первый запуск */ }
    if (Date.now() - last < 2 * 24 * 3600 * 1000) return;
    if (active.size) return; // на Windows запущенный yt-dlp.exe не перезаписать
    try {
      await ytdlp.updateBinary(binPath);
      fs.writeFileSync(stamp, String(Date.now()));
    } catch { /* нет сети или нет прав — не критично */ }
  }

  async function init() {
    const binPath = await ytdlp.ensureBinary({
      binDir: binDir(),
      fetchFn,
      onProgress: (done, total) => sendStatus({ text: t('main.dl_ytdlp'), percent: total ? done / total : null }),
    });
    try {
      // Свежая установка уже последняя версия — отмечаем проверку.
      const stamp = path.join(binDir(), '.last-update-check');
      if (!fs.existsSync(stamp)) fs.writeFileSync(stamp, String(Date.now()));
    } catch { /* ignore */ }

    try {
      denoBin = await deno.ensureDeno({
        binDir: binDir(),
        fetchFn,
        onProgress: (done, total) => sendStatus({ text: t('main.dl_deno'), percent: total ? done / total : null }),
      });
    } catch {
      denoBin = null; // без Deno работаем через Electron в режиме Node
    }

    const version = await ytdlp.getVersion(binPath).catch(() => '');
    bin = binPath;
    return { version };
  }

  const isHttpUrl = (u) => {
    try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; }
  };

  function openExternal(url) {
    if (isHttpUrl(url)) shell.openExternal(url);
  }

  /** Автообновление самого MediaGrab (только в установленной версии с настроенным publish). */
  function setupAppUpdater() {
    if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return;
    let autoUpdater;
    try {
      ({ autoUpdater } = require('electron-updater'));
    } catch {
      return;
    }
    appUpdater = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.on('download-progress', (p) => send('app:update', { state: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => send('app:update', { state: 'ready', version: info && info.version }));
    autoUpdater.on('error', (e) => log.warn(`app updater: ${e && e.message}`)); // нет сети или не настроен репозиторий
    autoUpdater.checkForUpdates().catch(() => {});
  }

  // ---------- IPC ----------

  ipcMain.handle('app:progress', (_e, fraction) => {
    // значок прогресса на кнопке панели задач; -1 убирает его
    if (win && !win.isDestroyed()) win.setProgressBar(typeof fraction === 'number' && fraction >= 0 ? Math.min(1, fraction) : -1);
    if (tray) tray.setToolTip(typeof fraction === 'number' && fraction >= 0 ? `MediaGrab — ${Math.floor(Math.min(1, fraction) * 100)}%` : 'MediaGrab');
    return true;
  });

  // ---------- Трей ----------
  let tray = null;
  let closeToTray = false;
  let quitting = false;
  /** Значок трея под систему: .ico с несколькими размерами в Windows, монохромный «template» в macOS, PNG в Linux. */
  const trayIcon = () => {
    const dir = path.join(__dirname, 'build');
    if (process.platform === 'darwin') {
      const img = nativeImage.createFromPath(path.join(dir, 'trayTemplate.png')); // @2x подхватывается по имени
      if (!img.isEmpty()) { img.setTemplateImage(true); return img; }
    } else if (process.platform === 'win32') {
      const img = nativeImage.createFromPath(path.join(dir, 'tray.ico'));
      if (!img.isEmpty()) return img;
    }
    const img = nativeImage.createFromPath(path.join(dir, 'tray.png'));
    return img.isEmpty() ? nativeImage.createFromPath(path.join(dir, 'icon.png')).resize({ width: 32, height: 32 }) : img;
  };
  /** Значок для перетаскивания файла (нужен цветной, а не template). */
  const dragIcon = () => {
    const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png'));
    return img.isEmpty() ? trayIcon() : img;
  };
  function showWindow() {
    if (!win || win.isDestroyed()) { createWindow(); return; }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  function buildTrayMenu() {
    return Menu.buildFromTemplate([
      { label: t('main.tray_open'), click: showWindow },
      { type: 'separator' },
      { label: t('main.tray_quit'), click: () => { quitting = true; app.quit(); } },
    ]);
  }
  function ensureTray() {
    if (tray) { tray.setContextMenu(buildTrayMenu()); return; }
    try {
      tray = new Tray(trayIcon());
      tray.setToolTip('MediaGrab');
      tray.setContextMenu(buildTrayMenu());
      tray.on('click', showWindow);
    } catch { tray = null; }
  }
  ipcMain.handle('app:setTray', (_e, on) => {
    closeToTray = on === true;
    if (closeToTray) ensureTray();
    else if (tray) { tray.destroy(); tray = null; }
    return closeToTray && !!tray;
  });

  // Перетаскивание готового файла из окна в проводник, мессенджер, редактор и т.п.
  ipcMain.on('drag:start', (e, file) => {
    if (!isDraggableFile(file)) return;
    try { e.sender.startDrag({ file, icon: dragIcon() }); } catch { /* перетаскивание недоступно */ }
  });

  ipcMain.handle('app:setLang', (_e, lang) => {
    setLang(lang);
    if (tray) tray.setContextMenu(buildTrayMenu());
    return true;
  });

  ipcMain.handle('app:init', async (_e, opts) => {
    try {
      // прокси для первой загрузки yt-dlp и Deno (GitHub может быть недоступен напрямую)
      const proxy = opts && typeof opts.proxy === 'string' ? opts.proxy.trim() : '';
      if (/^(https?|socks[45]?):\/\/\S+$/i.test(proxy)) await session.defaultSession.setProxy({ proxyRules: proxy });
      else await session.defaultSession.setProxy({ mode: 'system' });
      initPromise = initPromise || init();
      const r = await initPromise;
      setTimeout(() => { if (bin) maybeAutoUpdate(bin).catch(() => {}); }, 15_000); // обновление yt-dlp в фоне, запуск не задерживается
      return { ok: true, appVersion: app.getVersion(), version: r.version, downloadsDir: app.getPath('downloads'), platform: process.platform, loggedIn: !!loginCookies() };
    } catch (e) {
      initPromise = null;
      log.error(`init failed: ${e.message || e}`);
      return { ok: false, error: e.message || String(e) };
    }
  });

  // ---------- Вход в YouTube через окно приложения ----------

  const LOGIN_PARTITION = 'persist:youtube-login';
  let loginWin = null;

  /**
   * Открывает окно входа в Google. Как только вход выполнен и открылся youtube.com,
   * куки сохраняются в cookies.txt и окно закрывается (куки не успевают «протухнуть»).
   */
  const windowLogin = (lang) => new Promise((resolve) => {
    if (loginWin && !loginWin.isDestroyed()) {
      loginWin.focus();
      return resolve({ ok: false, busy: true });
    }
    const ses = session.fromPartition(LOGIN_PARTITION);
    // Google отказывает во входе во встроенных браузерах: убираем из User-Agent приписки Electron и приложения.
    ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|MediaGrab|mediagrab)\/\S+/gi, ''));

    loginWin = new BrowserWindow({
      width: 520,
      height: 740,
      parent: win || undefined,
      modal: !!win,
      title: t('main.login_title'),
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: { partition: LOGIN_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    loginWin.removeMenu();

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      const w = loginWin;
      loginWin = null;
      if (w && !w.isDestroyed()) w.destroy();
      resolve(result);
    };

    const check = async () => {
      if (done || !loginWin || loginWin.isDestroyed()) return;
      let host = '';
      try { host = new URL(loginWin.webContents.getURL()).hostname; } catch { return; }
      if (!/(^|\.)youtube\.com$/.test(host)) return;
      try {
        const all = await ses.cookies.get({});
        if (!hasLogin(all)) return;
        const file = vault.save(toNetscape(all));
        finish({ ok: true, file });
      } catch (err) {
        finish({ ok: false, error: err.message });
      }
    };

    const wc = loginWin.webContents;
    wc.on('did-navigate', check);
    wc.on('did-navigate-in-page', check);
    wc.on('did-finish-load', check);
    wc.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) wc.loadURL(url);
      return { action: 'deny' };
    });
    loginWin.on('closed', () => finish({ ok: false, cancelled: true }));

    const hl = lang === 'en' ? 'en' : 'ru';
    loginWin.loadURL(`https://accounts.google.com/ServiceLogin?service=youtube&hl=${hl}&continue=${encodeURIComponent('https://www.youtube.com/')}`)
      .catch(() => finish({ ok: false, error: 'load failed' }));
    return undefined;
  });

  let browserLogin = null;

  /** Основной путь: настоящий Chrome/Edge в отдельном профиле, куки забираются через DevTools. */
  async function loginViaBrowser(lang, exe) {
    if (browserLogin) return { ok: false, busy: true };
    const hl = lang === 'en' ? 'en' : 'ru';
    const url = `https://accounts.google.com/ServiceLogin?service=youtube&hl=${hl}&continue=${encodeURIComponent('https://www.youtube.com/')}`;
    browserLogin = startBrowserLogin({ exe, profileDir: path.join(app.getPath('userData'), 'login-profile'), url });
    try {
      const r = await browserLogin.done;
      if (!r.ok) return r;
      const file = vault.save(toNetscape(r.cookies));
      return { ok: true, file };
    } finally {
      browserLogin = null;
      if (win && !win.isDestroyed()) win.focus();
    }
  }

  ipcMain.handle('auth:login', async (_e, lang) => {
    const exe = findBrowser();
    if (exe) {
      const r = await loginViaBrowser(lang, exe);
      // если браузер не запустился технически — пробуем окно приложения; если пользователь сам закрыл, повторять не надо
      if (r.ok || r.cancelled || r.busy) return r;
    }
    return windowLogin(lang);
  });

  app.on('before-quit', () => { if (browserLogin) browserLogin.cancel(); });

  ipcMain.handle('auth:logout', async () => {
    try {
      await session.fromPartition(LOGIN_PARTITION).clearStorageData();
      vault.remove();
      fs.rmSync(path.join(app.getPath('userData'), 'login-profile'), { recursive: true, force: true });
    } catch { /* ignore */ }
    return true;
  });

  ipcMain.handle('app:checkUpdate', async () => {
    if (!appUpdater) return { state: 'unavailable' };
    try {
      const r = await appUpdater.checkForUpdates();
      return { state: r && r.isUpdateAvailable ? 'available' : 'none' };
    } catch (e) {
      log.warn(`manual update check: ${e && e.message}`);
      return { state: 'error', error: e && e.message };
    }
  });

  ipcMain.handle('app:installUpdate', () => {
    if (appUpdater) appUpdater.quitAndInstall();
  });

  ipcMain.handle('ytdlp:update', async () => {
    try {
      if (!bin) throw new Error(t('main.not_ready'));
      if (active.size) throw new Error(t('main.update_busy'));
      const r = await ytdlp.updateBinary(bin);
      return { ok: true, version: r.version, output: r.output };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  /** Ожидание с возможностью отмены; false, если отменили. Статус показывается на карточке. */
  function pause(sender, id, ms, text) {
    return new Promise((resolve) => {
      emit(sender, id, { type: 'status', text });
      const timer = setTimeout(() => { active.delete(id); resolve(true); }, ms);
      active.set(id, { cancel: () => { clearTimeout(timer); active.delete(id); resolve(false); } });
    });
  }

  const abortError = () => Object.assign(new Error('aborted'), { code: 'ABORTED' });
  function sleepAbortable(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      const timer = setTimeout(resolve, ms);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
      return undefined;
    });
  }

  /** Перед запросом информации: общая пауза после 429 и «шаги» для запросов с аккаунтом. */
  async function gateInfo(o, signal, url) {
    const cool = throttle.cooldownLeft(siteKey(url));
    if (cool > 0) await sleepAbortable(cool, signal);
    if (o.cookiesFile && o.cookiesFile === loginCookies()) {
      const r = throttle.reserveLogin();
      if (r.blocked) throw new Error(t('main.login_cap', { min: Math.ceil(r.retryInMs / 60000) }));
      try {
        if (r.waitMs > 0) await sleepAbortable(r.waitMs, signal);
      } catch (e) {
        throttle.releaseLogin(r.slot); // отменили до старта: слот не сгорает
        throw e;
      }
    }
  }

  /**
   * Получение информации с последовательными запасными попытками:
   * 1) куки браузера не читаются -> без них; 2) «вы не бот» -> другие клиенты YouTube.
   * При неудаче бросает ошибку с полем meta для технических подробностей.
   */
  async function fetchInfoSmart(url, opts, signal) {
    const meta = { cookieFallback: false, cookieErr: '', altClients: false, loginUsed: false, finalOpts: opts };
    let o = { ...opts };
    for (let i = 0; i < 4; i += 1) {
      try {
        meta.finalOpts = o;
        await gateInfo(o, signal, url);
        if (isYoutubeUrl(url)) await getPo(o);
        const raw = await ytdlp.fetchInfo({ bin, url, ctx: { ...makeCtx({ ...o, url }), altClients: meta.altClients }, signal });
        return { raw, meta };
      } catch (e) {
        if (e.code === 'ABORTED') throw e;
        if (isRateLimit(e.message)) throttle.noteRateLimit(siteKey(url));
        if (!meta.cookieFallback && o.cookiesBrowser && !o.cookiesFile && isCookieError(e.message)) {
          meta.cookieFallback = true;
          meta.cookieErr = e.message;
          o = { ...o, cookiesBrowser: '' };
        } else if (!meta.altClients && isBotError(e.message)) {
          meta.altClients = true;
        } else if (!meta.loginUsed && !o.cookiesFile && isYoutubeUrl(url) && isLoginError(e.message) && loginCookies()) {
          // без входа не вышло, а сайт требует аккаунт: только теперь подставляем сохранённый вход
          meta.loginUsed = true;
          o = { ...o, cookiesFile: loginCookies(), cookiesBrowser: '' };
        } else {
          throw Object.assign(e, { meta });
        }
      }
    }
    throw Object.assign(new Error('retry limit'), { meta });
  }

  ipcMain.handle('info:fetch', async (_e, { id, url, opts } = {}) => {
    if (!isHttpUrl(url)) return { ok: false, error: t('main.not_link') };
    const ac = new AbortController();
    active.set(id, { cancel: () => ac.abort() });
    try {
      if (!bin) await initPromise;
      try {
        const { raw, meta } = await fetchInfoSmart(url, opts || {}, ac.signal);
        return { ok: true, info: ytdlp.normalizeInfo(raw), notice: meta.cookieFallback ? t('main.cookies_notice') : null, usedLogin: meta.loginUsed };
      } catch (err) {
        if (err.code === 'ABORTED') return { ok: false, aborted: true, error: t('main.cancelled') };
        if (pinterest.isPinterestUrl(url)) {
          try {
            const pin = await pinterest.scrapePin(url, fetchFn, ac.signal);
            if (pin) return { ok: true, info: pin };
          } catch { /* покажем ошибку yt-dlp */ }
        }
        if (isUnsupportedError(err.message) && !isYoutubeUrl(url) && !pinterest.isPinterestUrl(url)) {
          try {
            const cap = await sniffer.captureStream({
              url,
              parent: win,
              proxy: (opts || {}).proxy,
              profileDir: path.join(app.getPath('userData'), 'sniffer-browser-profile'),
              fetchFn,
              signal: ac.signal,
              title: t('main.sniffer_title'),
            });
            if (cap.aborted || cap.cancelled) {
              return { ok: false, aborted: true, error: t('main.cancelled') };
            }
            if (cap.ok) {
              const cookiesFile = writeSnifferCookies(cap.cookiesText);
              const baseSniffOpts = {
                ...(opts || {}),
                url: cap.streamUrl,
                sniffed: true,
                headers: cap.headers,
                cookiesFile: cookiesFile || (opts || {}).cookiesFile || '',
                cookiesBrowser: '',
              };
              let impersonate = false;
              let raw;
              try {
                raw = await ytdlp.fetchInfo({ bin, url: cap.streamUrl, ctx: makeCtx(baseSniffOpts), signal: ac.signal });
              } catch (firstErr) {
                if (firstErr && firstErr.code === 'ABORTED') throw firstErr;
                if (/403|Cloudflare|impersonate|forbidden/i.test(String((firstErr && firstErr.message) || ''))) {
                  impersonate = true;
                  raw = await ytdlp.fetchInfo({
                    bin,
                    url: cap.streamUrl,
                    ctx: makeCtx({ ...baseSniffOpts, impersonate: true }),
                    signal: ac.signal,
                  });
                } else {
                  throw firstErr;
                }
              }
              const info = ytdlp.normalizeInfo(raw);
              if (cap.title) info.title = cap.title;
              if (!info.thumbnail && cap.thumbnail) info.thumbnail = cap.thumbnail;
              try { info.site = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
              saveSniffed(id, url, {
                streamUrl: cap.streamUrl,
                headers: cap.headers,
                cookiesFile,
                impersonate,
                title: info.title,
              });
              return { ok: true, info, sniffed: true };
            }
          } catch (sniffErr) {
            if (sniffErr && sniffErr.code === 'ABORTED') {
              return { ok: false, aborted: true, error: t('main.cancelled') };
            }
            const details = String((sniffErr && sniffErr.message) || sniffErr || '').slice(-1800);
            log.warn(`sniffer failed ${url}: ${details}`);
            return { ok: false, error: explain(details), details };
          }
        }
        const meta = err.meta || {};
        const prefix = meta.cookieFallback ? t('main.cookies_unreadable', { browser: (opts || {}).cookiesBrowser }) : '';
        const details = [
          cookieNote(makeCtx({ ...(meta.finalOpts || opts || {}), url })),
          meta.altClients && '[alternative YouTube clients tried]',
          meta.cookieErr && `first attempt: ${meta.cookieErr}`,
          err.message,
        ].filter(Boolean).join('\n').slice(-1800);
        log.warn(`info failed ${url}: ${details}`);
        return { ok: false, error: prefix + explain(err.message), details, needsLogin: isBotError(err.message) };
      }
    } finally {
      active.delete(id);
    }
  });

  function emit(sender, id, payload) {
    if (payload && payload.type === 'error') log.error(`job ${id}: ${payload.message}${payload.details ? `\n${payload.details}` : ''}`);
    if (sender && !sender.isDestroyed()) sender.send('job:event', { id, ...payload });
  }

  function uniquePath(dir, base, ext) {
    let candidate = path.join(dir, `${base}.${ext}`);
    for (let i = 1; fs.existsSync(candidate); i += 1) candidate = path.join(dir, `${base} (${i}).${ext}`);
    return candidate;
  }

  async function runImageJob(sender, job, ac) {
    const img = job.image || {};
    const candidates = [img.originalUrl, img.url].filter((u, i, a) => u && pinterest.isPinImageHost(u) && a.indexOf(u) === i);
    if (!candidates.length) throw new Error(t('main.image_no_url'));
    let lastError = null;
    for (const u of candidates) {
      try {
        const res = await net.fetch(u, {
          headers: { 'User-Agent': pinterest.USER_AGENT, Referer: 'https://www.pinterest.com/' },
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ext = pinterest.extFromContentType(res.headers.get('content-type') || '') || 'jpg';
        const dest = uniquePath(job.outDir, pinterest.safeName(img.basename), ext);
        let lastTick = 0;
        await saveResponse(res, dest, (done, total) => {
          const now = Date.now();
          if (now - lastTick < 150) return;
          lastTick = now;
          emit(sender, job.id, { type: 'progress', percent: total ? done / total : null, downloaded: done, total, speed: null, eta: null });
        }, ac.signal);
        return dest;
      } catch (err) {
        if (ac.signal.aborted) throw err;
        lastError = err;
      }
    }
    throw lastError || new Error('download failed');
  }

  /**
   * Запуск yt-dlp для одной ссылки.
   * state.cookiesRetried — уже пробовали без кук; state.attempt — номер автоповтора при сбое сети.
   */
  async function runYtDlpJob(sender, job, state = { cookiesRetried: false, attempt: 0 }) {
    if (!job.headers) {
      const sniffed = getSniffed(job.id, job.url);
      if (sniffed) {
        job = {
          ...job,
          url: sniffed.streamUrl,
          headers: sniffed.headers,
          cookiesFile: sniffed.cookiesFile || job.cookiesFile || '',
          cookiesBrowser: '',
          impersonate: !!sniffed.impersonate,
          customTitle: sniffed.title,
          sniffed: true,
        };
      }
    }
    if (job.useLogin && !job.cookiesFile && isYoutubeUrl(job.url) && loginCookies()) {
      job = { ...job, cookiesFile: loginCookies(), cookiesBrowser: '' };
      state = { ...state, loginUsed: true };
    }
    const id = job.id;
    // общая пауза после 429: ждут все загрузки
    const cool = throttle.cooldownLeft(siteKey(job.url));
    if (cool > 0 && !(await pause(sender, id, cool, t('main.cooldown', { s: Math.ceil(cool / 1000) })))) {
      emit(sender, id, { type: 'cancelled' });
      return undefined;
    }
    // загрузки с аккаунтом: интервал 5–10 с между стартами и лимит за час
    if (job.cookiesFile && job.cookiesFile === loginCookies()) {
      const r = throttle.reserveLogin();
      if (r.blocked) {
        emit(sender, id, { type: 'error', message: t('main.login_cap', { min: Math.ceil(r.retryInMs / 60000) }) });
        return undefined;
      }
      if (r.waitMs > 800 && !(await pause(sender, id, r.waitMs, t('main.login_pause', { s: Math.ceil(r.waitMs / 1000) })))) {
        throttle.releaseLogin(r.slot);
        emit(sender, id, { type: 'cancelled' });
        return undefined;
      }
    }
    if (!job.sniffed && isYoutubeUrl(job.url)) await getPo(job);
    return spawnJob(sender, job, state);
  }

  function spawnJob(sender, job, state) {
    return new Promise((resolve) => {
      const id = job.id;
      let args;
      try {
        args = ytdlp.buildDownloadArgs(job, { ...makeCtx(job), altClients: !!state.altClients });
      } catch (e) {
        emit(sender, id, { type: 'error', message: e.message });
        return resolve();
      }
      const tracker = new ProgressTracker({ expectedStreams: (job.format === 'mp4' || job.format === 'webm') && job.splitStreams ? 2 : 1 });
      const errorLines = [];
      const tail = [];
      let lastEmit = 0;
      let cancelled = false;
      let finished = false;

      const proc = spawnTool(bin, args, {
        env: makeCtx(job).env,
        onLine: (line, src) => {
          if (src === 'err' && line.trim()) {
            tail.push(line);
            if (tail.length > 12) tail.shift();
          }
          const ev = tracker.handleLine(line);
          if (!ev) return;
          if (ev.type === 'error-line') {
            errorLines.push(`ERROR: ${ev.message}`);
          } else if (ev.type === 'progress') {
            const now = Date.now();
            if (now - lastEmit < 150) return;
            lastEmit = now;
            emit(sender, id, ev);
          } else if (ev.type === 'status' || ev.type === 'entry') {
            emit(sender, id, ev);
          }
        },
      });

      active.set(id, { cancel: () => { cancelled = true; killTree(proc); } });

      const finish = (payload) => {
        if (finished) return;
        finished = true;
        active.delete(id);
        emit(sender, id, payload);
        resolve();
      };

      proc.on('error', (err) => finish({ type: 'error', message: t('main.start_failed', { msg: err.message }) }));
      proc.on('close', (code) => {
        if (finished) return;
        if (cancelled) return finish({ type: 'cancelled' });
        if (code === 0 && job.format === 'gif') {
          // yt-dlp скачал короткое видео, превращаем его в GIF
          const src = tracker.lastFile;
          if (!src) return finish({ type: 'error', message: t('main.gif_failed', { msg: 'no file' }) });
          finished = true;
          emit(sender, id, { type: 'status', text: t('main.gif_making') });
          const out = `${src.replace(/\.[^.\\/]+$/, '')}.gif`;
          active.set(id, { cancel: () => { cancelled = true; } });
          makeGif({
            ffmpeg: makeCtx(job).ffmpegPath || 'ffmpeg',
            input: src,
            output: out,
            width: job.quality,
            onProc: (p) => { active.set(id, { cancel: () => { cancelled = true; killTree(p); } }); },
          }).then(async (r) => {
            active.delete(id);
            if (cancelled) { await fs.promises.rm(out, { force: true }); await fs.promises.rm(src, { force: true }); emit(sender, id, { type: 'cancelled' }); return resolve(); }
            if (r.ok) {
              await fs.promises.rm(src, { force: true }); // видео-исходник больше не нужен
              emit(sender, id, { type: 'done', path: out, dir: job.outDir });
            } else {
              emit(sender, id, { type: 'error', message: t('main.gif_failed', { msg: String(r.error).split('\n').pop() }), details: r.error });
            }
            return resolve();
          });
          return undefined;
        }
        if (code === 0) return finish({ type: 'done', path: tracker.lastFile, dir: job.outDir });

        const text = errorLines.length ? errorLines.join('\n') : tail.join('\n');
        if (isRateLimit(text)) throttle.noteRateLimit(siteKey(job.url));

        // 1) Куки браузера не читаются: повторяем без них.
        if (!state.cookiesRetried && job.cookiesBrowser && isCookieError(text)) {
          finished = true;
          active.delete(id);
          return resolve(runYtDlpJob(sender, { ...job, cookiesBrowser: '' }, { ...state, cookiesRetried: true, browser: job.cookiesBrowser, cookieErr: text }));
        }

        // 1b) «Вы не бот»: одна запасная попытка с другими клиентами YouTube.
        if (!state.altClients && isBotError(text)) {
          finished = true;
          active.delete(id);
          return resolve(runYtDlpJob(sender, job, { ...state, altClients: true }));
        }

        // 1c) Сайт требует аккаунт: подставляем сохранённый вход (если он есть) и пробуем ещё раз.
        if (!state.loginUsed && !job.cookiesFile && isYoutubeUrl(job.url) && isLoginError(text) && loginCookies()) {
          finished = true;
          active.delete(id);
          return resolve(runYtDlpJob(sender, { ...job, cookiesFile: loginCookies(), cookiesBrowser: '' }, { ...state, loginUsed: true }));
        }

        // 1d) Не скачались субтитры (часто лимит запросов): качаем видео без них, а не теряем всё.
        if (!state.noSubs && job.subs && isSubtitleError(text)) {
          finished = true;
          active.delete(id);
          emit(sender, id, { type: 'status', text: t('main.subs_skipped') });
          return resolve(runYtDlpJob(sender, { ...job, subs: false }, { ...state, noSubs: true }));
        }

        // 2) Временный сбой сети или лимит: ждём и повторяем (частично скачанное yt-dlp докачивает).
        if (state.attempt < RETRY_DELAYS_MS.length && isTransientError(text)) {
          const delay = RETRY_DELAYS_MS[state.attempt];
          finished = true;
          let timer = null;
          active.set(id, {
            cancel: () => {
              clearTimeout(timer);
              active.delete(id);
              emit(sender, id, { type: 'cancelled' });
              resolve();
            },
          });
          emit(sender, id, {
            type: 'status',
            text: t('main.retry_in', { s: delay / 1000, n: state.attempt + 1, max: RETRY_DELAYS_MS.length }),
          });
          timer = setTimeout(() => {
            resolve(runYtDlpJob(sender, job, { ...state, attempt: state.attempt + 1 }));
          }, delay);
          return undefined;
        }

        const prefix = state.cookiesRetried ? t('main.cookies_unreadable', { browser: state.browser }) : '';
        const details = [
          cookieNote(makeCtx(job)),
          state.cookieErr && `first attempt: ${state.cookieErr}`,
          text,
        ].filter(Boolean).join('\n').slice(-1800);
        return finish({ type: 'error', message: prefix + explain(text), details, needsLogin: isBotError(text) });
      });
    });
  }

  async function runJob(sender, job) {
    const id = job.id;
    try {
      if (!bin) await initPromise;
      if (!isHttpUrl(job.url)) throw new Error(t('main.bad_link'));
      if (typeof job.outDir !== 'string' || !job.outDir) throw new Error(t('main.no_folder'));
      fs.mkdirSync(job.outDir, { recursive: true });

      if (job.kind === 'image') {
        const ac = new AbortController();
        active.set(id, { cancel: () => ac.abort() });
        try {
          const dest = await runImageJob(sender, job, ac);
          emit(sender, id, { type: 'done', path: dest, dir: job.outDir });
        } catch (err) {
          if (ac.signal.aborted) emit(sender, id, { type: 'cancelled' });
          else emit(sender, id, { type: 'error', message: t('main.image_failed', { msg: err.message }) });
        } finally {
          active.delete(id);
        }
        return;
      }
      await runYtDlpJob(sender, job);
    } catch (err) {
      emit(sender, id, { type: 'error', message: err.message || String(err) });
    }
  }

  ipcMain.handle('job:start', (e, job) => {
    runJob(e.sender, job);
    return true;
  });

  ipcMain.handle('job:cancel', (_e, id) => {
    const j = active.get(id);
    if (j) j.cancel();
    return !!j;
  });

  ipcMain.handle('dialog:folder', async (_e, current) => {
    const r = await dialog.showOpenDialog(win, {
      title: t('main.dlg_folder'),
      defaultPath: typeof current === 'string' && current ? current : app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:cookies', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: t('main.dlg_cookies'),
      properties: ['openFile'],
      filters: [{ name: t('main.dlg_text'), extensions: ['txt'] }, { name: t('main.dlg_all'), extensions: ['*'] }],
    });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });

  ipcMain.handle('shell:show', (_e, p) => {
    if (typeof p === 'string' && p && fs.existsSync(p)) shell.showItemInFolder(p);
    else if (typeof p === 'string' && p && isDirectory(path.dirname(p))) shell.openPath(path.dirname(p));
  });

  ipcMain.handle('shell:open', (_e, dir) => {
    if (isDirectory(dir)) shell.openPath(dir);
  });

  // Действие после очереди. Только из белого списка; выключение и сон выполняет сама система.
  ipcMain.handle('app:after', (_e, kind) => {
    if (kind === 'quit') { quitting = true; app.quit(); return true; }
    const cmds = {
      win32: { shutdown: ['shutdown', ['/s', '/t', '0']], sleep: ['rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']] },
      darwin: { shutdown: ['osascript', ['-e', 'tell application "System Events" to shut down']], sleep: ['pmset', ['sleepnow']] },
      linux: { shutdown: ['systemctl', ['poweroff']], sleep: ['systemctl', ['suspend']] },
    };
    const c = (cmds[process.platform] || cmds.linux)[kind];
    if (!c) return false;
    log.info(`after-queue action: ${kind}`);
    try { require('node:child_process').execFile(c[0], c[1], () => {}); return true; } catch { return false; }
  });

  ipcMain.handle('log:export', async () => {
    const r = await dialog.showSaveDialog(win, {
      title: t('main.dlg_report'),
      defaultPath: path.join(app.getPath('documents'), 'mediagrab-report.txt'),
      filters: [{ name: t('main.dlg_text'), extensions: ['txt'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
    const head = [
      `MediaGrab ${app.getVersion()}`,
      `Electron ${process.versions.electron}, ${process.platform}/${process.arch}`,
      `yt-dlp: ${bin ? path.basename(bin) : 'not ready'}`,
      `Date: ${new Date().toISOString()}`,
      '',
    ].join('\n');
    try {
      await fs.promises.writeFile(r.filePath, mask(head + log.readAll()));
      return { ok: true, file: r.filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('clipboard:read', () => clipboard.readText());

  // ---------- Окно ----------

  const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
  function loadWinState() {
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { /* первый запуск */ }
    return sanitizeState(saved, screen.getAllDisplays().map((d) => d.workArea));
  }
  function saveWinState() {
    if (!win || win.isDestroyed()) return;
    const b = win.isMaximized() || win.isMinimized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
    try { fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() })); } catch { /* не критично */ }
  }

  function createWindow() {
    const iconPath = path.join(__dirname, 'build', 'icon.png');
    const ws = loadWinState();
    win = new BrowserWindow({
      width: ws.width,
      height: ws.height,
      ...(ws.x !== undefined ? { x: ws.x, y: ws.y } : {}),
      minWidth: 900,
      minHeight: 600,
      backgroundColor: '#0f1b33',
      title: 'MediaGrab',
      autoHideMenuBar: true,
      ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false, // подписки и загрузки должны идти и в свёрнутом окне
      },
    });
    if (process.platform !== 'darwin') win.removeMenu();
    if (ws.maximized) win.maximize();
    let saveTimer = null;
    const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveWinState, 600); };
    win.on('resize', saveSoon);
    win.on('move', saveSoon);
    win.on('close', saveWinState);
    win.on('close', (e) => {
      if (closeToTray && !quitting && tray) { e.preventDefault(); win.hide(); }
    });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    win.webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('file://')) {
        e.preventDefault();
        openExternal(url);
      }
    });
    win.webContents.once('did-finish-load', () => setTimeout(setupAppUpdater, 5000));
    win.on('closed', () => { win = null; });
  }

  app.on('second-instance', () => showWindow());
  app.whenReady().then(createWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    quitting = true;
    for (const j of active.values()) j.cancel();
  });
}
