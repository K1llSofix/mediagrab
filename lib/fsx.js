'use strict';

const fs = require('node:fs');

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * rename с короткими повторами: на Windows антивирус на мгновение держит только что записанный файл.
 * delays — паузы между попытками в мс (по умолчанию 4 повтора).
 */
async function renameRetry(from, to, delays = [100, 200, 300, 500]) {
  for (let i = 0; ; i += 1) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (e) {
      if (i >= delays.length || !RETRYABLE.has(e && e.code)) throw e;
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}

/** Путь существует и это папка (для shell.openPath: на файле .exe он бы его запустил). */
function isDirectory(p) {
  if (typeof p !== 'string' || !p || p.includes('\0')) return false;
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

module.exports = { renameRetry, isDirectory };
