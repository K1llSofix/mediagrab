'use strict';

const { renameRetry } = require('./fsx');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { saveResponse } = require('./download');
const { extractAll } = require('./unzip');
const { t } = require('./messages');

/**
 * Эксперимент: токен подтверждения (PO Token) для YouTube.
 *
 * YouTube всё чаще требует от клиента «токен происхождения». Его умеет выдавать программа bgutil-pot
 * (один исполняемый файл, без Node и Python), а плагин для yt-dlp забирает токены у неё по HTTP.
 * Всё работает только на этом компьютере: сервер слушает 127.0.0.1 на случайном порту.
 *
 * Компоненты: https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs
 */

const RELEASE_BASE = 'https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/latest/download/';
const PLUGIN_ZIP = 'bgutil-ytdlp-pot-provider-rs.zip';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000; // раз в неделю подтягиваем свежую версию: YouTube меняется, провайдер вслед за ним

/** Имя готового бинарника для платформы или null, если сборки нет. На Windows ARM работает x64 через эмуляцию. */
function serverAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'bgutil-pot-windows-x86_64.exe';
  if (platform === 'darwin') return arch === 'arm64' ? 'bgutil-pot-macos-aarch64' : 'bgutil-pot-macos-x86_64';
  if (platform === 'linux' && arch === 'x64') return 'bgutil-pot-linux-x86_64';
  return null;
}

const potDir = (binDir) => path.join(binDir, 'pot');
const serverPath = (binDir, platform = process.platform) => path.join(potDir(binDir), platform === 'win32' ? 'bgutil-pot.exe' : 'bgutil-pot');
const pluginsRoot = (binDir) => path.join(potDir(binDir), 'plugins');
const pluginPackage = (binDir) => path.join(pluginsRoot(binDir), 'bgutil-pot');

const isFresh = (file, maxAgeMs) => {
  try { const st = fs.statSync(file); return st.size > 0 && Date.now() - st.mtimeMs < maxAgeMs; } catch { return false; }
};

/** Все ли компоненты на месте (быстрая проверка без сети). */
function isInstalled(binDir) {
  return fs.existsSync(serverPath(binDir)) && fs.existsSync(path.join(pluginPackage(binDir), 'yt_dlp_plugins'));
}

/** Ищет папку yt_dlp_plugins в распакованном архиве (на случай, если всё лежит внутри корневой папки). */
function findPluginDir(root, depth = 3) {
  if (depth < 0) return null;
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  if (names.some((d) => d.isDirectory() && d.name === 'yt_dlp_plugins')) return path.join(root, 'yt_dlp_plugins');
  for (const d of names) {
    if (!d.isDirectory()) continue;
    const found = findPluginDir(path.join(root, d.name), depth - 1);
    if (found) return found;
  }
  return null;
}

async function download(fetchFn, url, dest, what, onProgress) {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(t('yt.download_failed', { what, status: res.status }));
  await saveResponse(res, dest, onProgress);
}

/**
 * Скачивает (или обновляет раз в неделю) сервер токенов и плагин для yt-dlp.
 * Если обновить не вышло, а старые файлы есть, остаются они.
 */
async function ensureComponents({ binDir, fetchFn, onProgress, base = RELEASE_BASE, platform = process.platform, arch = process.arch, maxAgeMs = MAX_AGE_MS }) {
  const asset = serverAsset(platform, arch);
  if (!asset) throw new Error(t('pot.unsupported'));
  fs.mkdirSync(pluginsRoot(binDir), { recursive: true });

  const exe = serverPath(binDir, platform);
  if (!isFresh(exe, maxAgeMs)) {
    try {
      await download(fetchFn, base + asset, exe, 'bgutil-pot', onProgress);
      if (platform !== 'win32') fs.chmodSync(exe, 0o755);
    } catch (e) {
      if (!fs.existsSync(exe)) throw e;
    }
  }

  const pkg = pluginPackage(binDir);
  const marker = path.join(pkg, 'yt_dlp_plugins');
  if (!isFresh(marker, maxAgeMs)) {
    const zip = path.join(potDir(binDir), PLUGIN_ZIP);
    const tmp = path.join(potDir(binDir), 'plugin-tmp');
    try {
      await download(fetchFn, base + PLUGIN_ZIP, zip, 'yt-dlp plugin', onProgress);
      await fs.promises.rm(tmp, { recursive: true, force: true });
      await extractAll(zip, tmp);
      const found = findPluginDir(tmp);
      if (!found) throw new Error(t('pot.bad_plugin'));
      await fs.promises.rm(pkg, { recursive: true, force: true });
      await fs.promises.mkdir(pkg, { recursive: true });
      await renameRetry(found, marker);
    } catch (e) {
      if (!fs.existsSync(marker)) throw e;
    } finally {
      await fs.promises.rm(zip, { force: true });
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  }
  return { server: exe, pluginsRoot: pluginsRoot(binDir) };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/ping', timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Локальный сервер токенов: запускается по требованию, слушает только 127.0.0.1. */
class PotServer {
  constructor({ exe, argsPrefix = [], startTimeoutMs = 15000 }) {
    this.exe = exe;
    this.argsPrefix = argsPrefix;
    this.startTimeoutMs = startTimeoutMs;
    this.child = null;
    this.port = 0;
    this.pending = null;
  }

  get baseUrl() { return this.child && this.port ? `http://127.0.0.1:${this.port}` : null; }

  get running() { return !!this.child; }

  /** Возвращает базовый адрес, запуская сервер, если он не работает. */
  start() {
    if (this.baseUrl) return Promise.resolve(this.baseUrl);
    if (!this.pending) this.pending = this._start().finally(() => { this.pending = null; });
    return this.pending;
  }

  async _start() {
    const port = await freePort();
    const child = spawn(this.exe, [...this.argsPrefix, 'server', '--host', '127.0.0.1', '--port', String(port)], { stdio: 'ignore', windowsHide: true });
    let failed = null;
    child.once('error', (e) => { failed = e; });
    child.once('exit', () => { failed = failed || new Error('exited'); if (this.child === child) { this.child = null; this.port = 0; } });

    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (failed) break;
      if (await ping(port)) { this.child = child; this.port = port; return this.baseUrl; }
      await sleep(250);
    }
    try { child.kill(); } catch { /* уже завершился */ }
    throw new Error(`${t('pot.server_failed')}${failed ? ` (${failed.message})` : ''}`);
  }

  stop() {
    const c = this.child;
    this.child = null;
    this.port = 0;
    if (c) { try { c.kill(); } catch { /* ignore */ } }
  }
}

/** Аргументы yt-dlp: где искать плагин и по какому адресу ходить за токеном. */
function potArgs({ pluginsRoot: root, baseUrl }) {
  return ['--plugin-dirs', root, '--extractor-args', `youtubepot-bgutilhttp:base_url=${baseUrl}`];
}

module.exports = { serverAsset, ensureComponents, isInstalled, findPluginDir, PotServer, potArgs, potDir, serverPath, pluginsRoot, RELEASE_BASE, PLUGIN_ZIP };
