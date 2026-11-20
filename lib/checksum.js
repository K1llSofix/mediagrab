'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

/** SHA-256 файла (потоком, без загрузки в память). */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Разбор файла контрольных сумм: строки «хэш  имя» или «хэш *имя», либо просто один хэш.
 * Возвращает Map имя -> хэш; для одиночного хэша ключ '*'.
 */
function parseSums(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([A-Fa-f0-9]{64})(?:\s+\*?(.+?))?\s*$/.exec(line);
    if (m) map.set(m[2] || '*', m[1].toLowerCase());
  }
  return map;
}

/** Ожидаемый хэш из URL или null, если файла сумм нет или он недоступен (тогда проверку пропускаем). */
async function fetchExpected({ fetchFn, url, name }) {
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    const map = parseSums(await res.text());
    return map.get(name) || map.get('*') || null;
  } catch {
    return null;
  }
}

/** Сверяет файл с ожидаемым хэшем. expected = null — проверять нечего, считаем успехом. */
async function verifyFile(file, expected) {
  if (!expected) return { checked: false, ok: true };
  const actual = await sha256File(file);
  return { checked: true, ok: actual === String(expected).toLowerCase(), actual };
}

module.exports = { sha256File, parseSums, fetchExpected, verifyFile };
