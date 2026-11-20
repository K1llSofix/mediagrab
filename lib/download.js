'use strict';

const { renameRetry } = require('./fsx');
const fs = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

/**
 * Сохраняет тело fetch-ответа в файл (через временный .part, затем rename).
 * onProgress(downloadedBytes, totalBytes|0).
 */
async function saveResponse(res, dest, onProgress, signal) {
  if (!res.body) throw new Error('Пустой ответ сервера');
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = `${dest}.part`;
  let done = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      if (onProgress) onProgress(done, total);
      cb(null, chunk);
    },
  });
  try {
    const streams = [Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp)];
    if (signal) streams.push({ signal });
    await pipeline(...streams);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
  await renameRetry(tmp, dest);
  return done;
}

module.exports = { saveResponse };
