'use strict';

const { BrowserWindow, WebContentsView, session, ipcMain, screen } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { toNetscape } = require('./cookies');
const { findBrowser } = require('./browserLogin');
const { killTree } = require('./proc');
const { t } = require('./messages');

const SNIFFER_PARTITION = 'persist:stream-sniffer';
const BAR_HEIGHT = 56;

// Отсеиваем очевидные рекламные трекеры, прероллы и отдельные сегменты HLS/DASH
const AD_URL_RE = /(?:vast|vpaid|preroll|midroll|doubleclick|googlesyndication|adfox|yastatic\.net\/pcode|an\.yandex\.ru|adriver|betweendigital|\/ads\/|\/adv\/)/i;
const SEGMENT_RE = /\.(?:ts|m4s|aac|vtt|srt|jpg|jpeg|png|webp|gif|svg|ico|css|js|woff2?|ttf|otf|json|webm)(?:$|\?)/i;
const HLS_URL_RE = /(?:\.m3u8|%2Em3u8)(?:$|[?&#:/])/i;
const DASH_URL_RE = /(?:\.mpd|%2Empd)(?:$|[?&#:/])/i;
const MP4_URL_RE = /\.mp4(?:$|\?)/i;
const MIN_MP4_BYTES = 10 * 1024 * 1024; // отсекает короткие рекламные ролики .mp4
const MIN_HLS_SECONDS = 25;             // отсекает короткие рекламные HLS-прероллы

const PAGE_META_SCRIPT = `(() => {
  const text = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
  const meta = (sel) => document.querySelector(sel)?.getAttribute('content')?.trim() || '';
  const rawTitle = text('h1') || meta('meta[property="og:title"]') || document.title || '';
  const cleanTitle = rawTitle
    .replace(/\\s*(?:смотреть онлайн|онлайн бесплатно|в хорошем качестве|hd\\s*720|hd\\s*1080|hdrezka).*$/i, '')
    .replace(/\\s*[|–—-]\\s*$/, '')
    .trim();
  const season = text('.b-simple_season__item.active, [data-season].active');
  const episode = text('.b-simple_episode__item.active, [data-episode].active');
  const translator = text('.b-translator__item.active');
  const extra = [season, episode].filter(Boolean).join(', ');
  let title = cleanTitle;
  if (extra) title = title ? title + ' — ' + extra : extra;
  if (translator && translator.length <= 40) title += ' (' + translator + ')';
  const thumbnail = meta('meta[property="og:image"]') || document.querySelector('.b-sidecover img')?.src || null;
  return { title, thumbnail };
})()`;

let activeWin = null;

function getHeader(headers, name) {
  if (!headers) return '';
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      return Array.isArray(v) ? String(v[0] || '') : String(v || '');
    }
  }
  return '';
}

function parseTotalBytes(respHeaders) {
  const range = getHeader(respHeaders, 'content-range');
  const m = /\/(\d+)\s*$/.exec(range);
  if (m) return Number(m[1]);
  const len = Number(getHeader(respHeaders, 'content-length'));
  return Number.isFinite(len) ? len : 0;
}

function shortHost(u) {
  try {
    const parsed = new URL(u);
    const tail = parsed.pathname.split('/').filter(Boolean).slice(-1)[0] || '';
    return tail ? `${parsed.hostname}/…/${tail.slice(0, 32)}` : parsed.hostname;
  } catch {
    return String(u || '').slice(0, 48);
  }
}

function formatDuration(sec) {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
  return `${Math.round(bytes / (1024 ** 2))} MB`;
}

/** Разбор текста HLS-манифеста: master с разрешениями или длительность (отсеиваем короткие прероллы). */
function parseHlsText(text) {
  const body = String(text || '').slice(0, 262_144);
  if (/#EXT-X-STREAM-INF/i.test(body)) {
    const heights = [];
    for (const m of body.matchAll(/RESOLUTION=\d+x(\d+)/gi)) {
      const h = Number(m[1]);
      if (h > 0) heights.push(h);
    }
    const variants = (body.match(/#EXT-X-STREAM-INF/gi) || []).length;
    const maxH = heights.length ? Math.max(...heights) : 0;
    const info = maxH ? `master, ≤${maxH}p (${variants})` : `master (${variants})`;
    return { ok: true, isMaster: true, info };
  }
  let total = 0;
  for (const m of body.matchAll(/#EXTINF:\s*([\d.]+)/gi)) {
    total += Number(m[1]) || 0;
  }
  if (total > 0 && total < MIN_HLS_SECONDS) return { ok: false };
  return { ok: true, isMaster: false, duration: total, info: total ? formatDuration(total) : '' };
}

/** Разбор текста DASH-манифеста (.mpd): максимальное разрешение видео. */
function parseDashText(text) {
  const body = String(text || '').slice(0, 262_144);
  if (!/<MPD\b/i.test(body)) return { ok: false };
  const heights = [];
  for (const m of body.matchAll(/height="(\d+)"/gi)) {
    const h = Number(m[1]);
    if (h >= 144 && h <= 4320) heights.push(h);
  }
  const maxH = heights.length ? Math.max(...heights) : 0;
  return { ok: true, info: maxH ? `≤${maxH}p` : '' };
}

// ---------- Минимальный RFC 6455 WebSocket-клиент для localhost CDP (без зависимости от прокси) ----------

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    let settled = false;
    let socket = null;
    let buf = Buffer.alloc(0);
    let fragments = [];
    let nextId = 1;
    const pending = new Map();
    const listeners = new Set();

    const sendFrame = (opcode, payloadBuf) => {
      if (!socket || socket.destroyed) return;
      const len = payloadBuf.length;
      let hdr;
      if (len < 126) {
        hdr = Buffer.from([0x80 | opcode, 0x80 | len]);
      } else if (len < 65536) {
        hdr = Buffer.alloc(4);
        hdr[0] = 0x80 | opcode;
        hdr[1] = 0x80 | 126;
        hdr.writeUInt16BE(len, 2);
      } else {
        hdr = Buffer.alloc(10);
        hdr[0] = 0x80 | opcode;
        hdr[1] = 0x80 | 127;
        hdr.writeBigUInt64BE(BigInt(len), 2);
      }
      const mask = crypto.randomBytes(4);
      const masked = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i += 1) masked[i] = payloadBuf[i] ^ mask[i & 3];
      socket.write(Buffer.concat([hdr, mask, masked]));
    };

    const handleMessage = (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.id != null) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
          else p.resolve(msg.result || {});
        }
      } else if (msg.method) {
        for (const fn of listeners) {
          try { fn(msg.method, msg.params || {}, msg.sessionId || ''); } catch { /* ignore */ }
        }
      }
    };

    const pump = () => {
      while (buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const maskStart = off;
        if (masked) off += 4;
        if (buf.length < off + len) return;

        let payload = buf.subarray(off, off + len);
        if (masked) {
          const out = Buffer.allocUnsafe(len);
          for (let i = 0; i < len; i += 1) out[i] = payload[i] ^ buf[maskStart + (i & 3)];
          payload = out;
        }
        buf = buf.subarray(off + len);

        if (opcode === 0x8) { // close
          if (socket && !socket.destroyed) socket.end();
          return;
        }
        if (opcode === 0x9) { // ping
          sendFrame(0x0a, payload);
          continue;
        }
        if (opcode === 0x0a) continue; // pong
        if (opcode === 0x1 || opcode === 0x2) {
          fragments = [payload];
          if (fin) {
            const full = Buffer.concat(fragments).toString('utf8');
            fragments = [];
            handleMessage(full);
          }
        } else if (opcode === 0x0) {
          fragments.push(payload);
          if (fin) {
            const full = Buffer.concat(fragments).toString('utf8');
            fragments = [];
            handleMessage(full);
          }
        }
      }
    };

    const failAll = (err) => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      pending.clear();
    };

    const client = {
      send(method, params = {}, sessionId = '') {
        if (!socket || socket.destroyed) return Promise.reject(new Error('CDP closed'));
        return new Promise((res, rej) => {
          const id = nextId;
          nextId += 1;
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`CDP timeout: ${method}`));
          }, 15_000);
          pending.set(id, { resolve: res, reject: rej, timer });
          const body = sessionId ? { id, sessionId, method, params } : { id, method, params };
          sendFrame(0x1, Buffer.from(JSON.stringify(body), 'utf8'));
        });
      },
      onEvent(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      close() {
        failAll(new Error('CDP closed'));
        if (socket && !socket.destroyed) {
          try { sendFrame(0x8, Buffer.alloc(0)); } catch { /* ignore */ }
          socket.destroy();
        }
      },
    };

    const req = http.request({
      hostname: u.hostname,
      port: Number(u.port),
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });

    req.on('upgrade', (_res, sock, head) => {
      socket = sock;
      socket.setNoDelay(true);
      socket.on('data', (chunk) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        pump();
      });
      socket.on('close', () => failAll(new Error('CDP disconnected')));
      socket.on('error', (e) => failAll(e));
      if (head && head.length) {
        buf = head;
        pump();
      }
      if (!settled) {
        settled = true;
        resolve(client);
      }
    });

    req.on('response', (res) => {
      if (!settled) {
        settled = true;
        reject(new Error(`CDP HTTP ${res.statusCode}`));
      }
    });
    req.on('error', (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    req.end();
  });
}

/** Ищет системный Chrome/Edge (сначала через browserLogin, затем запасные пути). */
function resolveBrowserExe() {
  try {
    const found = findBrowser();
    if (found && fs.existsSync(found)) return found;
  } catch { /* fallback */ }
  const candidates = [];
  if (process.platform === 'win32') {
    const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    candidates.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    );
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser');
  }
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

/** Ждёт адрес DevTools WebSocket (из stderr браузера или файла DevToolsActivePort). */
function waitDevToolsWs(proc, profileDir, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderrBuf = '';
    const portFile = path.join(profileDir, 'DevToolsActivePort');

    const finish = (err, wsUrl) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(wsUrl);
    };

    const onStderr = (chunk) => {
      stderrBuf += chunk.toString('utf8');
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderrBuf);
      if (m) finish(null, m[1].trim());
    };
    if (proc.stderr) proc.stderr.on('data', onStderr);

    const poller = setInterval(() => {
      try {
        if (!fs.existsSync(portFile)) return;
        const lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
        if (lines.length >= 2 && /^\d+$/.test(lines[0].trim())) {
          finish(null, `ws://127.0.0.1:${lines[0].trim()}${lines[1].trim()}`);
        }
      } catch { /* ещё не записан */ }
    }, 150);

    proc.once('exit', (code) => finish(new Error(`browser exited (${code})`)));
    proc.once('error', (e) => finish(e));
    const timer = setTimeout(() => finish(new Error('DevTools timeout')), timeoutMs);
  });
}

// ---------- Режим 1 (основной): настоящий Chrome/Edge через CDP + компактная панель сверху ----------

async function captureViaBrowser({ exe, url, parent, proxy, profileDir, signal, title }) {
  fs.mkdirSync(profileDir, { recursive: true });
  try { fs.rmSync(path.join(profileDir, 'DevToolsActivePort'), { force: true }); } catch { /* ignore */ }

  const p = typeof proxy === 'string' ? proxy.trim() : '';
  const launchArgs = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--new-window',
  ];
  if (/^(https?|socks[45]?):\/\/\S+$/i.test(p)) launchArgs.push(`--proxy-server=${p}`);
  launchArgs.push(url);

  const proc = spawn(exe, launchArgs, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false });

  let cdp = null;
  try {
    const wsUrl = await waitDevToolsWs(proc, profileDir);
    cdp = await connectCdp(wsUrl);
  } catch (e) {
    killTree(proc);
    throw e;
  }

  let browserUa = '';
  try {
    const ver = await cdp.send('Browser.getVersion');
    if (ver && ver.userAgent) browserUa = ver.userAgent;
  } catch { /* ignore */ }

  return new Promise((resolve) => {
    let done = false;
    let picking = false;
    let seq = 0;
    const streams = []; // [{ id, url, headers, label, sessionId, ts }]
    const sessions = new Map(); // sessionId -> { type, targetId, url, parentSession }
    const reqInfo = new Map(); // `${sessionId}:${requestId}` -> { url, headers }
    const pendingInspect = new Map(); // `${sessionId}:${requestId}` -> { kind, url, headers, sessionId, requestId, timer }

    // Компактная плавающая панель управления поверх всех окон вверху экрана
    const wa = (parent && !parent.isDestroyed()
      ? screen.getDisplayMatching(parent.getBounds()).workArea
      : screen.getPrimaryDisplay().workArea);
    const barW = Math.min(860, Math.max(640, wa.width - 120));
    const barX = Math.round(wa.x + (wa.width - barW) / 2);
    const barY = wa.y + 10;

    const barWin = new BrowserWindow({
      width: barW,
      height: BAR_HEIGHT,
      useContentSize: true,
      x: barX,
      y: barY,
      minWidth: 520,
      minHeight: BAR_HEIGHT,
      maxHeight: BAR_HEIGHT,
      alwaysOnTop: true,
      minimizable: false,
      maximizable: false,
      title: title || t('main.sniffer_title'),
      autoHideMenuBar: true,
      backgroundColor: '#0f1b33',
      webPreferences: {
        preload: path.join(__dirname, 'sniffer-preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    barWin.removeMenu();
    activeWin = barWin;

    const labels = () => ({
      back: t('sniffer.back'),
      reload: t('sniffer.reload'),
      clear: t('sniffer.clear'),
      pick: t('sniffer.pick'),
    });

    const pushState = () => {
      if (done || barWin.isDestroyed()) return;
      barWin.webContents.send('sniffer:state', {
        externalBrowser: true,
        hint: t('sniffer.hint_browser'),
        labels: labels(),
        busy: picking,
        streams: streams.map((s) => ({ id: s.id, label: s.label })),
      });
    };

    const addStream = (streamUrl, headers, kindLabel, detail, sessionId) => {
      if (done) return;
      const idx = streams.findIndex((s) => s.url === streamUrl);
      const label = [kindLabel, detail, shortHost(streamUrl)].filter(Boolean).join(' • ');
      if (idx >= 0) {
        const [existing] = streams.splice(idx, 1);
        existing.headers = headers;
        existing.label = label;
        existing.sessionId = sessionId;
        existing.ts = Date.now();
        streams.unshift(existing);
      } else {
        seq += 1;
        streams.unshift({ id: `s${seq}`, url: streamUrl, headers, label, sessionId, ts: Date.now() });
        if (streams.length > 25) streams.pop();
      }
      pushState();
    };

    const buildCleanHeaders = (rawHeaders) => {
      const out = {};
      const ua = getHeader(rawHeaders, 'user-agent') || browserUa;
      const referer = getHeader(rawHeaders, 'referer');
      const origin = getHeader(rawHeaders, 'origin');
      if (ua) out['User-Agent'] = ua;
      if (referer) out.Referer = referer;
      if (origin) out.Origin = origin;
      return out;
    };

    const findPageSession = (startSessionId) => {
      let cur = startSessionId;
      for (let i = 0; i < 8 && cur; i += 1) {
        const info = sessions.get(cur);
        if (!info) break;
        if (info.type === 'page') return cur;
        cur = info.parentSession;
      }
      // Иначе берём первую открытую http(s) страницу
      for (const [sid, info] of sessions) {
        if (info.type === 'page' && /^https?:/i.test(info.url || '')) return sid;
      }
      for (const [sid, info] of sessions) {
        if (info.type === 'page') return sid;
      }
      return '';
    };

    const readCdpMeta = async (sessionId) => {
      const pageSid = findPageSession(sessionId);
      if (!pageSid) return { title: '', thumbnail: null };
      try {
        const res = await cdp.send('Runtime.evaluate', {
          expression: PAGE_META_SCRIPT,
          returnByValue: true,
        }, pageSid);
        const val = res && res.result && res.result.value;
        if (val && typeof val === 'object') return { title: val.title || '', thumbnail: val.thumbnail || null };
      } catch { /* ignore */ }
      return { title: '', thumbnail: null };
    };

    const readCdpCookies = async (sessionId) => {
      let cookies = [];
      try {
        const res = await cdp.send('Storage.getCookies');
        if (res && Array.isArray(res.cookies)) cookies = res.cookies;
      } catch { /* fallback */ }
      if (!cookies.length) {
        const pageSid = findPageSession(sessionId);
        if (pageSid) {
          try {
            const res = await cdp.send('Network.getAllCookies', {}, pageSid);
            if (res && Array.isArray(res.cookies)) cookies = res.cookies;
          } catch { /* ignore */ }
        }
      }
      if (!cookies.length) return '';
      const normalized = cookies.map((c) => ({
        domain: c.domain,
        name: c.name,
        value: c.value,
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        expires: c.expires,
        expirationDate: typeof c.expires === 'number' && c.expires > 0 ? c.expires : undefined,
      }));
      return toNetscape(normalized);
    };

    const attachSession = (sessionId, targetInfo, parentSession) => {
      if (done || !sessionId || !targetInfo) return;
      if (targetInfo.type !== 'page' && targetInfo.type !== 'iframe') return;
      sessions.set(sessionId, {
        type: targetInfo.type,
        targetId: targetInfo.targetId,
        url: targetInfo.url || '',
        parentSession: parentSession || '',
      });
      cdp.send('Network.enable', {}, sessionId).catch(() => {});
      cdp.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      }, sessionId).catch(() => {});
    };

    const finalizeInspect = async (key) => {
      const item = pendingInspect.get(key);
      if (!item) return;
      pendingInspect.delete(key);
      clearTimeout(item.timer);
      if (done) return;

      let text = '';
      try {
        const body = await cdp.send('Network.getResponseBody', { requestId: item.requestId }, item.sessionId);
        if (body && typeof body.body === 'string') {
          text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        }
      } catch { /* если тело недоступно — всё равно добавим поток */ }

      if (item.kind === 'hls') {
        if (text) {
          const parsed = parseHlsText(text);
          if (!parsed.ok) return; // короткий рекламный преролл
          addStream(item.url, item.headers, 'HLS', parsed.info || '', item.sessionId);
        } else {
          addStream(item.url, item.headers, 'HLS', '', item.sessionId);
        }
      } else if (item.kind === 'dash') {
        if (text) {
          const parsed = parseDashText(text);
          if (item.strictXml && !parsed.ok) return;
          addStream(item.url, item.headers, 'DASH', parsed.info || '', item.sessionId);
        } else if (!item.strictXml) {
          addStream(item.url, item.headers, 'DASH', '', item.sessionId);
        }
      }
    };

    const unsubCdp = cdp.onEvent((method, params, sessionId) => {
      if (done) return;
      if (method === 'Target.attachedToTarget') {
        attachSession(params.sessionId, params.targetInfo, sessionId);
        return;
      }
      if (method === 'Target.detachedFromTarget') {
        sessions.delete(params.sessionId);
        return;
      }
      if (method === 'Target.targetInfoChanged' && params.targetInfo) {
        for (const info of sessions.values()) {
          if (info.targetId === params.targetInfo.targetId) {
            info.url = params.targetInfo.url || info.url;
          }
        }
        return;
      }

      const key = `${sessionId}:${params.requestId}`;

      if (method === 'Network.requestWillBeSent' && params.request) {
        const u = params.request.url || '';
        if (!/^https?:/i.test(u) || SEGMENT_RE.test(u)) return;
        const prev = reqInfo.get(key) || { url: u, headers: {} };
        prev.url = u;
        prev.headers = { ...prev.headers, ...(params.request.headers || {}) };
        reqInfo.set(key, prev);
        if (reqInfo.size > 600) {
          const oldest = reqInfo.keys().next().value;
          reqInfo.delete(oldest);
        }
        return;
      }

      if (method === 'Network.requestWillBeSentExtraInfo' && params.headers) {
        const prev = reqInfo.get(key);
        if (prev) prev.headers = { ...prev.headers, ...params.headers };
        return;
      }

      if (method === 'Network.responseReceived' && params.response) {
        const resp = params.response;
        const saved = reqInfo.get(key);
        reqInfo.delete(key);

        if (resp.status < 200 || resp.status >= 300) return;
        const u = resp.url || (saved && saved.url) || '';
        if (!/^https?:/i.test(u) || AD_URL_RE.test(u) || SEGMENT_RE.test(u)) return;

        const ct = `${resp.mimeType || ''} ${getHeader(resp.headers, 'content-type')}`.toLowerCase();
        const isHls = HLS_URL_RE.test(u) || ct.includes('mpegurl');
        const isDash = DASH_URL_RE.test(u) || ct.includes('dash+xml');
        const isMaybeDashXml = !isDash && ct.includes('xml') && /(?:mpd|dash|manifest|stream)/i.test(u);
        const isMp4 = MP4_URL_RE.test(u) || ct.includes('video/mp4');
        if (!isHls && !isDash && !isMaybeDashXml && !isMp4) return;

        const headers = buildCleanHeaders(saved ? saved.headers : {});

        if (isHls || isDash || isMaybeDashXml) {
          const kind = isHls ? 'hls' : 'dash';
          const timer = setTimeout(() => finalizeInspect(key), 2000);
          pendingInspect.set(key, {
            kind,
            strictXml: isMaybeDashXml,
            url: u,
            headers,
            sessionId,
            requestId: params.requestId,
            timer,
          });
          return;
        }

        const bytes = parseTotalBytes(resp.headers);
        if (isMp4 && bytes >= MIN_MP4_BYTES) {
          addStream(u, headers, 'MP4', formatBytes(bytes), sessionId);
        }
        return;
      }

      if (method === 'Network.loadingFinished') {
        if (pendingInspect.has(key)) finalizeInspect(key);
        return;
      }

      if (method === 'Network.loadingFailed') {
        reqInfo.delete(key);
        const item = pendingInspect.get(key);
        if (item) {
          clearTimeout(item.timer);
          pendingInspect.delete(key);
        }
      }
    });

    const cleanup = () => {
      for (const item of pendingInspect.values()) clearTimeout(item.timer);
      pendingInspect.clear();
      reqInfo.clear();
      unsubCdp();
      ipcMain.removeListener('sniffer:action', onAction);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (activeWin === barWin) activeWin = null;
      if (!barWin.isDestroyed()) barWin.destroy();

      if (cdp) {
        cdp.send('Browser.close').catch(() => {}).finally(() => {
          try { cdp.close(); } catch { /* ignore */ }
        });
      }
      setTimeout(() => {
        try { if (proc.exitCode === null) killTree(proc); } catch { /* ignore */ }
      }, 600);
    };

    const finish = (result) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    };

    const onAbort = () => finish({ ok: false, aborted: true });
    if (signal) {
      if (signal.aborted) return finish({ ok: false, aborted: true });
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const pickStream = async (id) => {
      if (done || picking) return;
      const item = streams.find((s) => s.id === id) || streams[0];
      if (!item) return;
      picking = true;
      pushState();
      try {
        const [meta, cookiesText] = await Promise.all([
          readCdpMeta(item.sessionId),
          readCdpCookies(item.sessionId),
        ]);
        finish({
          ok: true,
          streamUrl: item.url,
          headers: item.headers,
          cookiesText,
          title: meta.title || '',
          thumbnail: meta.thumbnail || null,
        });
      } catch (e) {
        finish({ ok: false, error: (e && e.message) || 'capture failed' });
      }
    };

    const onAction = (e, msg) => {
      if (done || barWin.isDestroyed() || e.sender.id !== barWin.webContents.id) return;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') pushState();
      else if (msg.type === 'pick') pickStream(msg.id);
      else if (msg.type === 'clear') { streams.length = 0; pushState(); }
      else if (msg.type === 'cancel') finish({ ok: false, cancelled: true });
    };
    ipcMain.on('sniffer:action', onAction);

    barWin.on('closed', () => finish({ ok: false, cancelled: true }));
    proc.on('exit', () => finish({ ok: false, cancelled: true }));

    // Подключаемся к уже открытой и всем будущим вкладкам/фреймам
    cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    }).catch(() => {});

    barWin.loadFile(path.join(__dirname, 'sniffer-bar.html')).catch(() => {});
    return undefined;
  });
}

// ---------- Режим 2 (запасной): встроенное окно Electron, если Chrome/Edge не найден ----------

async function inspectHlsFetch(url, headers, fetchFn, signal) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    const onAbort = () => ac.abort();
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); return { ok: true, info: '' }; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await fetchFn(url, { headers, signal: ac.signal });
      if (!res.ok) return { ok: true, info: '' };
      return parseHlsText(await res.text());
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  } catch {
    return { ok: true, info: '' };
  }
}

async function captureViaElectron({ url, parent, proxy, fetchFn, signal, title }) {
  const ses = session.fromPartition(SNIFFER_PARTITION);
  ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|MediaGrab|mediagrab)\/\S+/gi, ''));

  const p = typeof proxy === 'string' ? proxy.trim() : '';
  if (/^(https?|socks[45]?):\/\/\S+$/i.test(p)) await ses.setProxy({ proxyRules: p });
  else await ses.setProxy({ mode: 'system' });

  return new Promise((resolve) => {
    let done = false;
    let picking = false;
    let seq = 0;
    const reqHeadersById = new Map();
    const streams = [];
    const internalAc = new AbortController();

    const win = new BrowserWindow({
      width: 1120,
      height: 780,
      minWidth: 760,
      minHeight: 520,
      parent: parent || undefined,
      title: title || t('main.sniffer_title'),
      autoHideMenuBar: true,
      backgroundColor: '#0f1b33',
      webPreferences: {
        preload: path.join(__dirname, 'sniffer-preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.removeMenu();
    activeWin = win;

    const view = new WebContentsView({
      webPreferences: {
        partition: SNIFFER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.contentView.addChildView(view);

    const layout = () => {
      if (win.isDestroyed()) return;
      const [w, h] = win.getContentSize();
      view.setBounds({ x: 0, y: BAR_HEIGHT, width: Math.max(0, w), height: Math.max(0, h - BAR_HEIGHT) });
    };
    layout();
    win.on('resize', layout);
    win.on('maximize', layout);
    win.on('unmaximize', layout);

    const wc = view.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));

    const labels = () => ({
      back: t('sniffer.back'),
      reload: t('sniffer.reload'),
      clear: t('sniffer.clear'),
      pick: t('sniffer.pick'),
    });

    const pushState = () => {
      if (done || win.isDestroyed()) return;
      win.webContents.send('sniffer:state', {
        externalBrowser: false,
        hint: t('sniffer.hint'),
        labels: labels(),
        busy: picking,
        streams: streams.map((s) => ({ id: s.id, label: s.label })),
      });
    };

    const addStream = (streamUrl, headers, kindLabel, detail) => {
      if (done) return;
      const idx = streams.findIndex((s) => s.url === streamUrl);
      const label = [kindLabel, detail, shortHost(streamUrl)].filter(Boolean).join(' • ');
      if (idx >= 0) {
        const [existing] = streams.splice(idx, 1);
        existing.headers = headers;
        existing.label = label;
        existing.ts = Date.now();
        streams.unshift(existing);
      } else {
        seq += 1;
        streams.unshift({ id: `s${seq}`, url: streamUrl, headers, label, ts: Date.now() });
        if (streams.length > 25) streams.pop();
      }
      pushState();
    };

    const buildHeaders = (rawHeaders, fallbackReferer) => {
      const out = {};
      const ua = getHeader(rawHeaders, 'user-agent') || ses.getUserAgent();
      const referer = getHeader(rawHeaders, 'referer') || fallbackReferer || '';
      const origin = getHeader(rawHeaders, 'origin');
      if (ua) out['User-Agent'] = ua;
      if (referer) out.Referer = referer;
      if (origin) out.Origin = origin;
      return out;
    };

    const cleanup = () => {
      internalAc.abort();
      ipcMain.removeListener('sniffer:action', onAction);
      ses.webRequest.onSendHeaders(null);
      ses.webRequest.onHeadersReceived(null);
      ses.webRequest.onErrorOccurred(null);
      reqHeadersById.clear();
      if (signal) signal.removeEventListener('abort', onAbort);
      if (activeWin === win) activeWin = null;
      try { if (!wc.isDestroyed()) wc.setAudioMuted(true); } catch { /* ignore */ }
      if (!win.isDestroyed()) win.destroy();
    };

    const finish = (result) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    };

    const onAbort = () => finish({ ok: false, aborted: true });
    if (signal) {
      if (signal.aborted) return finish({ ok: false, aborted: true });
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const pickStream = async (id) => {
      if (done || picking) return;
      const item = streams.find((s) => s.id === id) || streams[0];
      if (!item) return;
      picking = true;
      pushState();
      try {
        const [meta, allCookies] = await Promise.all([
          wc.isDestroyed() ? { title: '', thumbnail: null } : wc.executeJavaScript(PAGE_META_SCRIPT, true).catch(() => ({ title: '', thumbnail: null })),
          ses.cookies.get({}).catch(() => []),
        ]);
        finish({
          ok: true,
          streamUrl: item.url,
          headers: item.headers,
          cookiesText: allCookies.length ? toNetscape(allCookies) : '',
          title: (meta && meta.title) || '',
          thumbnail: (meta && meta.thumbnail) || null,
        });
      } catch (e) {
        finish({ ok: false, error: (e && e.message) || 'capture failed' });
      }
    };

    const onAction = (e, msg) => {
      if (done || win.isDestroyed() || e.sender.id !== win.webContents.id) return;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') pushState();
      else if (msg.type === 'pick') pickStream(msg.id);
      else if (msg.type === 'clear') { streams.length = 0; pushState(); }
      else if (msg.type === 'back' && !wc.isDestroyed() && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      else if (msg.type === 'reload' && !wc.isDestroyed()) wc.reload();
      else if (msg.type === 'cancel') finish({ ok: false, cancelled: true });
    };
    ipcMain.on('sniffer:action', onAction);

    const filter = { urls: ['http://*/*', 'https://*/*'] };
    ses.webRequest.onSendHeaders(filter, (details) => {
      if (!SEGMENT_RE.test(details.url)) {
        reqHeadersById.set(details.id, details.requestHeaders || {});
        if (reqHeadersById.size > 400) reqHeadersById.delete(reqHeadersById.keys().next().value);
      }
    });
    ses.webRequest.onErrorOccurred(filter, (details) => { reqHeadersById.delete(details.id); });
    ses.webRequest.onHeadersReceived(filter, (details, cb) => {
      cb({});
      if (done) return;
      const reqHeaders = reqHeadersById.get(details.id);
      reqHeadersById.delete(details.id);
      if (details.statusCode < 200 || details.statusCode >= 300) return;
      const u = details.url;
      if (AD_URL_RE.test(u) || SEGMENT_RE.test(u)) return;
      const ct = getHeader(details.responseHeaders, 'content-type').toLowerCase();
      const isHls = HLS_URL_RE.test(u) || ct.includes('mpegurl');
      const isDash = DASH_URL_RE.test(u) || ct.includes('dash+xml');
      const isMp4 = MP4_URL_RE.test(u) || ct.startsWith('video/mp4');
      if (!isHls && !isDash && !isMp4) return;

      const headers = buildHeaders(reqHeaders, details.referrer);
      if (isHls) {
        ses.cookies.get({ url: u }).catch(() => []).then(async (list) => {
          if (done) return;
          const h = { ...headers };
          if (list.length) h.Cookie = list.map((c) => `${c.name}=${c.value}`).join('; ');
          const res = await inspectHlsFetch(u, h, fetchFn, internalAc.signal);
          if (done || !res.ok) return;
          addStream(u, headers, 'HLS', res.info || '');
        });
        return;
      }
      if (isDash) { addStream(u, headers, 'DASH', ''); return; }
      const bytes = parseTotalBytes(details.responseHeaders);
      if (isMp4 && bytes >= MIN_MP4_BYTES) addStream(u, headers, 'MP4', formatBytes(bytes));
    });

    win.on('closed', () => finish({ ok: false, cancelled: true }));
    win.loadFile(path.join(__dirname, 'sniffer-bar.html')).catch(() => {});
    wc.loadURL(url).catch((e) => {
      if (e && e.code === 'ERR_ABORTED') return;
      finish({ ok: false, error: (e && e.message) || 'load failed' });
    });
    return undefined;
  });
}

/**
 * Основная точка входа: сначала запускает настоящий Chrome/Edge через DevTools (полные кодеки H.264/AAC),
 * а если браузер не найден или не запустился — падает на встроенное окно Electron.
 */
async function captureStream(opts) {
  if (activeWin && !activeWin.isDestroyed()) {
    activeWin.focus();
    return { ok: false, busy: true };
  }
  const exe = resolveBrowserExe();
  if (exe && opts && opts.profileDir) {
    try {
      return await captureViaBrowser({ ...opts, exe });
    } catch {
      // если системный браузер не запустился — пробуем встроенное окно Electron
    }
  }
  return captureViaElectron(opts);
}

module.exports = { captureStream };
