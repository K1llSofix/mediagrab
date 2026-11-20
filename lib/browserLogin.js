'use strict';

const { killTree } = require('./proc');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

/**
 * Вход в Google через настоящий Chrome/Edge. Google не пускает во встроенные окна Electron,
 * а куки Chrome нельзя прочитать из файла (шифрование). Поэтому приложение запускает обычный браузер
 * в отдельном профиле с отладочным портом, ждёт входа и забирает куки через DevTools Protocol.
 */

/** Возможные пути к браузерам по платформам (первый существующий побеждает). */
function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    const rel = [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
      ['Chromium', 'Application', 'chrome.exe'],
    ];
    return rel.flatMap((r) => roots.map((root) => path.join(root, ...r)));
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
    '/usr/bin/brave-browser', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  ];
}

function findBrowser(exists = fs.existsSync, platform, env) {
  return browserCandidates(platform, env).find((p) => { try { return exists(p); } catch { return false; } }) || null;
}

/** Куки DevTools Protocol -> форма, которую ждёт toNetscape. */
function fromCdpCookies(list) {
  return (list || []).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    hostOnly: !String(c.domain || '').startsWith('.'),
    session: c.session === true || !(c.expires > 0),
    expirationDate: c.expires > 0 ? c.expires : undefined,
  }));
}

/** Для yt-dlp нужен вход именно на youtube.com, а не только на accounts.google.com. */
function hasYoutubeLogin(cookies) {
  return cookies.some((c) => c.name === 'SAPISID' && /(^|\.)youtube\.com$/i.test(String(c.domain || '').replace(/^\./, '')));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Запускает браузер и ждёт входа.
 * Возвращает объект управления: { done: Promise<{ok, cookies?|cancelled?|error?}>, cancel() }.
 */
function startBrowserLogin({ exe, profileDir, url, timeoutMs = 10 * 60 * 1000, pollMs = 1500, extraArgs = [] }) {
  let child = null;
  let ws = null;
  let finished = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  const finish = (result) => {
    if (finished) return;
    finished = true;
    try { ws && ws.close(); } catch { /* ignore */ }
    try { killTree(child); } catch { /* ignore */ }
    resolveDone(result);
  };

  (async () => {
    try {
      fs.mkdirSync(profileDir, { recursive: true });
      const port = await freePort();
      child = spawn(exe, [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-allow-origins=*',
        '--no-first-run', '--no-default-browser-check',
        ...extraArgs,
        '--new-window', url,
      ], { stdio: 'ignore', windowsHide: false });
      child.on('error', (e) => finish({ ok: false, error: e.message }));
      child.on('exit', () => setTimeout(() => finish({ ok: false, cancelled: true }), 1500));

      let wsUrl = null;
      for (let i = 0; i < 40 && !finished && !wsUrl; i += 1) {
        try { wsUrl = (await getJson(`http://127.0.0.1:${port}/json/version`)).webSocketDebuggerUrl; } catch { await sleep(500); }
      }
      if (finished) return;
      if (!wsUrl) { finish({ ok: false, error: 'devtools unavailable' }); return; }

      ws = new WebSocket(wsUrl);
      let nextId = 1;
      const pending = new Map();
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p(msg); }
      };
      ws.onclose = () => { if (!finished) finish({ ok: false, cancelled: true }); };
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
      const call = (method, params = {}) => new Promise((res) => {
        const id = nextId; nextId += 1;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
      });

      const deadline = Date.now() + timeoutMs;
      while (!finished && Date.now() < deadline) {
        await sleep(pollMs);
        if (finished) return;
        const r = await call('Storage.getCookies');
        const cookies = fromCdpCookies(r.result && r.result.cookies);
        if (hasYoutubeLogin(cookies)) {
          // закрываем браузер сразу: пока он открыт, YouTube может обновить куки, и сохранённые «протухнут»
          await call('Browser.close').catch(() => {});
          finish({ ok: true, cookies });
          return;
        }
      }
      finish({ ok: false, error: 'timeout' });
    } catch (e) {
      finish({ ok: false, error: e.message });
    }
  })();

  return { done, cancel: () => finish({ ok: false, cancelled: true }) };
}

module.exports = { browserCandidates, findBrowser, fromCdpCookies, hasYoutubeLogin, startBrowserLogin };
