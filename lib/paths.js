'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Можно ли отдать этот путь для перетаскивания: абсолютный путь к существующему обычному файлу. */
function isDraggableFile(p) {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0')) return false;
  if (!path.isAbsolute(p)) return false;
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

module.exports = { isDraggableFile };
