const test = require('node:test');
const assert = require('node:assert');
const { sanitizeFilename } = require('../lib/ytdlp');
const { explain } = require('../lib/errors');

test('зарезервированные имена Windows получают префикс', () => {
  assert.strictEqual(sanitizeFilename('CON'), '_CON');
  assert.strictEqual(sanitizeFilename('aux.'), '_aux');
  assert.strictEqual(sanitizeFilename('nul.mp4'), '_nul.mp4');
  assert.strictEqual(sanitizeFilename('console'), 'console');
});

test('HTTP 403 даёт понятное сообщение, SSL ищется по границе слова', () => {
  assert.match(explain('ERROR: HTTP Error 403: Forbidden'), /403/);
  assert.doesNotMatch(explain('unknown error: classSSLfoo'), /сет|network/i);
});

test('GIF качается во временный файл, фрагмент получает суффикс, субтитры с пробелами проходят', () => {
  const { buildDownloadArgs, normalizeSubLangs } = require('../lib/ytdlp');
  const base = { url: 'https://youtu.be/x', outDir: '/tmp', nameTemplate: 'title' };
  const gif = buildDownloadArgs({ ...base, format: 'gif', quality: '480', clipStart: '0', clipEnd: '5' }, {});
  assert.ok(gif.some((a) => a.includes('.gif-src.%(ext)s')));
  const clip = buildDownloadArgs({ ...base, format: 'mp4', quality: 'best', clipStart: '10', clipEnd: '20' }, {});
  assert.ok(clip.some((a) => a.includes('[clip ')));
  const fo = buildDownloadArgs({ ...base, format: 'mp4', quality: 'best', forceOverwrite: true }, {});
  assert.ok(fo.includes('--force-overwrites'));
  assert.strictEqual(normalizeSubLangs('ru, en;de'), 'ru,en,de');
});
