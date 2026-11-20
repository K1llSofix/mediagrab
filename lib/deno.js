'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { saveResponse } = require('./download');
const { extractFile } = require('./unzip');
const { t } = require('./messages');
const { fetchExpected, verifyFile } = require('./checksum');

const RELEASE_BASE = 'https://github.com/denoland/deno/releases/latest/download/';

/** Имя архива Deno для платформы. На Windows ARM работает x64-сборка через эмуляцию. */
function denoAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'deno-x86_64-pc-windows-msvc.zip';
  if (platform === 'darwin') return arch === 'arm64' ? 'deno-aarch64-apple-darwin.zip' : 'deno-x86_64-apple-darwin.zip';
  return arch === 'arm64' ? 'deno-aarch64-unknown-linux-gnu.zip' : 'deno-x86_64-unknown-linux-gnu.zip';
}

const denoPath = (binDir, platform = process.platform) => path.join(binDir, platform === 'win32' ? 'deno.exe' : 'deno');

/**
 * Скачивает Deno рядом с yt-dlp. YouTube требует JS-рантайм для расшифровки ссылок,
 * и собственный Deno надёжнее, чем запуск Electron в режиме Node.
 */
async function ensureDeno({ binDir, fetchFn, onProgress }) {
  const dest = denoPath(binDir);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) return dest;
  fs.mkdirSync(binDir, { recursive: true });
  const res = await fetchFn(RELEASE_BASE + denoAsset());
  if (!res.ok) throw new Error(t('yt.download_failed', { what: 'Deno', status: res.status }));
  const zipPath = path.join(binDir, 'deno.zip');
  try {
    await saveResponse(res, zipPath, onProgress);
    const expected = await fetchExpected({ fetchFn, url: `${RELEASE_BASE}${denoAsset()}.sha256sum`, name: denoAsset() });
    const v = await verifyFile(zipPath, expected);
    if (!v.ok) throw new Error(t('yt.checksum_failed', { what: 'Deno' }));
    await extractFile(zipPath, path.basename(dest), dest);
  } finally {
    await fs.promises.rm(zipPath, { force: true });
  }
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  return dest;
}

module.exports = { denoAsset, denoPath, ensureDeno };
