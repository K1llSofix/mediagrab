'use strict';

const { renameRetry } = require('./fsx');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { t } = require('./messages');

const inflateRaw = promisify(zlib.inflateRaw);

const fail = (why) => Object.assign(new Error(t('zip.failed', { why })), { code: 'ZIP' });

/** Читает центральный каталог: [{ name, method, compSize, size, localOffset }]. */
function listEntries(buf) {
  // Конец центрального каталога (EOCD) ищем с конца файла.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw fail('no EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw fail('ZIP64');

  const entries = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw fail('bad central directory');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      method: buf.readUInt16LE(p + 10),
      compSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function entryData(buf, e) {
  if (buf.readUInt32LE(e.localOffset) !== 0x04034b50) throw fail('bad local header');
  const start = e.localOffset + 30 + buf.readUInt16LE(e.localOffset + 26) + buf.readUInt16LE(e.localOffset + 28);
  const raw = buf.subarray(start, start + e.compSize);
  let data;
  if (e.method === 0) data = raw;
  else if (e.method === 8) data = await inflateRaw(raw);
  else throw fail(`method ${e.method}`);
  if (data.length !== e.size) throw fail('size mismatch');
  return data;
}

/**
 * Достаёт один файл из ZIP без сторонних зависимостей.
 * Поддерживает методы «stored» и «deflate», ZIP64 не нужен (архив Deno меньше 4 ГБ).
 */
async function extractFile(zipPath, entryName, destPath) {
  const buf = await fs.promises.readFile(zipPath);
  const e = listEntries(buf).find((x) => x.name === entryName || x.name.endsWith(`/${entryName}`));
  if (!e) throw fail(`${entryName} not found`);
  const data = await entryData(buf, e);
  const tmp = `${destPath}.tmp`;
  await fs.promises.writeFile(tmp, data);
  await renameRetry(tmp, destPath);
  return data.length;
}

/** Распаковывает весь архив в папку. Пути, выходящие за её пределы («zip slip»), отвергаются. */
async function extractAll(zipPath, destDir) {
  const buf = await fs.promises.readFile(zipPath);
  const root = path.resolve(destDir);
  let files = 0;
  for (const e of listEntries(buf)) {
    const target = path.resolve(root, e.name);
    if (target !== root && !target.startsWith(root + path.sep)) throw fail(`unsafe path ${e.name}`);
    if (e.name.endsWith('/')) {
      await fs.promises.mkdir(target, { recursive: true });
      continue;
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, await entryData(buf, e));
    files += 1;
  }
  return files;
}

module.exports = { extractFile, extractAll };
