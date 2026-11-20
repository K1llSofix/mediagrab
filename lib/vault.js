'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Хранилище сохранённого входа. Куки в файле на диске шифруются средствами ОС (Electron safeStorage:
 * DPAPI в Windows, Keychain в macOS, libsecret в Linux). yt-dlp нужен обычный файл, поэтому на время работы
 * приложения создаётся временная расшифрованная копия (папка с правами только для владельца), которая удаляется при выходе.
 * Если шифрование в системе недоступно, куки лежат как раньше: в файле с правами 0600.
 */
function createVault({ safeStorage, dir, tmpRoot = os.tmpdir() }) {
  const encPath = path.join(dir, 'youtube-cookies.enc');
  const plainPath = path.join(dir, 'youtube-cookies.txt');
  let tmpDir = null;
  let tmpFile = null;
  let lastText = '';

  const canEncrypt = () => { try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; } };

  function writeTmp(text) {
    if (!tmpDir) {
      tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'mediagrab-'));
      tmpFile = path.join(tmpDir, 'cookies.txt');
    }
    fs.writeFileSync(tmpFile, text, { mode: 0o600 });
    lastText = text;
    return tmpFile;
  }

  function save(text) {
    fs.mkdirSync(dir, { recursive: true });
    if (canEncrypt()) {
      fs.writeFileSync(encPath, safeStorage.encryptString(text), { mode: 0o600 });
      fs.rmSync(plainPath, { force: true });
      return writeTmp(text);
    }
    fs.writeFileSync(plainPath, text, { mode: 0o600 });
    return plainPath;
  }

  /** Путь к файлу кук, который можно отдать yt-dlp, или null, если входа нет. */
  function filePath() {
    try {
      if (tmpFile && fs.existsSync(tmpFile)) return tmpFile;
      if (fs.existsSync(encPath) && canEncrypt()) {
        return writeTmp(safeStorage.decryptString(fs.readFileSync(encPath)));
      }
      if (fs.existsSync(plainPath)) {
        // старый открытый файл: переносим в шифрованный вид, если система это умеет
        return canEncrypt() ? save(fs.readFileSync(plainPath, 'utf8')) : plainPath;
      }
    } catch { /* повреждённый или чужой файл: считаем, что входа нет */ }
    return null;
  }

  /** yt-dlp обновляет куки в файле при работе: сохраняем изменения обратно в шифрованное хранилище. */
  function flush() {
    try {
      if (!tmpFile || !fs.existsSync(tmpFile) || !canEncrypt() || !fs.existsSync(encPath)) return;
      const text = fs.readFileSync(tmpFile, 'utf8');
      if (text.trim() && text !== lastText) {
        fs.writeFileSync(encPath, safeStorage.encryptString(text), { mode: 0o600 });
        lastText = text;
      }
    } catch { /* не критично */ }
  }

  function dropTmp() {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    tmpFile = null;
  }

  function cleanup() { flush(); dropTmp(); }
  function remove() {
    dropTmp();
    fs.rmSync(encPath, { force: true });
    fs.rmSync(plainPath, { force: true });
  }

  return { save, filePath, flush, cleanup, remove, canEncrypt, encPath, plainPath };
}

/** Удаляет оставшиеся после аварийного завершения папки mediagrab-* с расшифрованными куками. Вызывать при старте (приложение одно). */
function sweepStale(roots) {
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) {
      if (/^mediagrab-[A-Za-z0-9]{6}$/.test(n)) {
        try { fs.rmSync(path.join(root, n), { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }
}

module.exports = { createVault, sweepStale };
