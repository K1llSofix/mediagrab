'use strict';

const { spawnTool } = require('./proc');

/** Допустимая ширина GIF и частота кадров: больше нет смысла, файл станет огромным. */
const GIF_WIDTHS = ['320', '480', '640'];
const GIF_FPS = 12;

/**
 * Аргументы ffmpeg для качественного GIF: палитра строится по самому ролику (palettegen),
 * затем применяется с разностью по кадрам. Без этого цвета в GIF получаются грязными.
 */
function gifArgs({ input, output, width, fps = GIF_FPS }) {
  const w = GIF_WIDTHS.includes(String(width)) ? String(width) : '480';
  const filter = `fps=${fps},scale=${w}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`;
  return ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vf', filter, '-loop', '0', output];
}

/** Запускает ffmpeg. Возвращает { ok, error }. onProc получает процесс (для отмены). */
function makeGif({ ffmpeg, input, output, width, fps, onProc }) {
  return new Promise((resolve) => {
    const tail = [];
    let proc;
    try {
      proc = spawnTool(ffmpeg, gifArgs({ input, output, width, fps }), {
        onLine: (line) => { if (line.trim()) { tail.push(line); if (tail.length > 6) tail.shift(); } },
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }
    if (onProc) onProc(proc);
    proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    proc.on('close', (code, signal) => resolve(code === 0 ? { ok: true } : { ok: false, error: tail.join('\n') || `ffmpeg exit ${code ?? signal}` }));
  });
}

module.exports = { GIF_WIDTHS, GIF_FPS, gifArgs, makeGif };
