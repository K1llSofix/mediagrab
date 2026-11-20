'use strict';

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { t } = require('./messages');

/** Окружение для yt-dlp: принудительно UTF-8, чтобы кириллица в названиях не ломалась на Windows. */
function toolEnv(extra = {}) {
  return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...extra };
}

/** Убивает процесс вместе с дочерними (yt-dlp запускает ffmpeg, а onefile-exe — ещё и распакованный процесс). */
function killTree(proc) {
  if (!proc || !proc.pid || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    const k = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => {});
  } else {
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      try { proc.kill('SIGTERM'); } catch { /* уже завершён */ }
    }
  }
}

/** Запускает процесс и строчно отдаёт stdout/stderr в onLine(line, 'out' | 'err'). */
function spawnTool(bin, args, { env, onLine } = {}) {
  const proc = spawn(bin, args, {
    env: toolEnv(env),
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (onLine) {
    readline.createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (l) => onLine(l, 'out'));
    readline.createInterface({ input: proc.stderr, crlfDelay: Infinity }).on('line', (l) => onLine(l, 'err'));
  }
  return proc;
}

/** Запускает процесс, собирает весь вывод. Поддерживает отмену (AbortSignal) и таймаут. */
function runCapture(bin, args, { env, timeoutMs = 0, signal } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      env: toolEnv(env),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let timedOut = false;
    let timer = null;

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    const onAbort = () => { aborted = true; killTree(proc); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (timeoutMs) timer = setTimeout(() => { timedOut = true; killTree(proc); }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (aborted) return reject(Object.assign(new Error(t('proc.aborted')), { code: 'ABORTED' }));
      if (timedOut) return reject(Object.assign(new Error(t('proc.timeout')), { code: 'TIMEOUT' }));
      return resolve({ code, stdout, stderr });
    });
  });
}

module.exports = { toolEnv, killTree, spawnTool, runCapture };
