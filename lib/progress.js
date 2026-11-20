'use strict';

/**
 * Разбор вывода yt-dlp. Приложение запускает yt-dlp с --progress-template, поэтому строки выглядят так:
 *   [PROGRESS]|downloading|<скачано>|<всего>|<оценка всего>|<скорость>|<eta>|<фрагмент>|<фрагментов>
 *   [POST]|started|Merger
 *   [FILE]<путь к готовому файлу>
 */

const num = (v) => {
  if (v == null || v === '' || v === 'NA' || v === 'None') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const { t } = require('./messages');

const KNOWN_POST = new Set(['Merger', 'ExtractAudio', 'VideoRemuxer', 'VideoConvertor', 'Metadata', 'FFmpegMetadata', 'EmbedThumbnail', 'MoveFiles']);
const postLabel = (name) => t(KNOWN_POST.has(name) ? `post.${name}` : 'post.default');

const FALLBACK_FILE_PATTERNS = [
  /^\[download\] Destination: (.+)$/,
  /^\[Merger\] Merging formats into "(.+)"$/,
  /^\[ExtractAudio\] Destination: (.+)$/,
  /^\[VideoRemuxer\] Remuxing video from \w+ to \w+; Destination: (.+)$/,
  /^\[download\] (.+) has already been downloaded$/,
];

class ProgressTracker {
  /** expectedStreams = 2, если видео и звук качаются отдельными потоками (YouTube, VK и т. п.). */
  constructor({ expectedStreams = 1 } = {}) {
    this.expected = Math.max(1, expectedStreams);
    this.entry = 1;
    this.entries = 1;
    this.stream = 0;
    this.last = 0;
    this.lastFile = null;
    this.fileIsFinal = false;
  }

  _overall(streamFraction) {
    let f = Math.min(1, Math.max(0, streamFraction));
    if (this.expected === 2) {
      f = this.stream === 0 ? f * 0.9 : 0.9 + f * 0.1;
    }
    return (this.entry - 1 + f) / this.entries;
  }

  _bump(frac) {
    this.last = Math.max(this.last, frac);
    return this.last;
  }

  /** Возвращает событие для интерфейса или null. */
  handleLine(raw) {
    const line = String(raw).trim();
    if (!line) return null;

    if (line.startsWith('[PROGRESS]|')) {
      const [, status, dl, total, est, speed, eta, fi, fc] = line.split('|');
      if (status === 'finished') {
        this.stream += 1;
        return null;
      }
      const downloaded = num(dl);
      const totalBytes = num(total) ?? num(est);
      const frag = num(fi);
      const fragCount = num(fc);
      let fraction = null;
      if (totalBytes && downloaded != null) fraction = downloaded / totalBytes;
      else if (frag != null && fragCount) fraction = frag / fragCount;

      // Пошёл второй файл, хотя ждали один (видео и звук отдельно): пересчитываем шкалу как для двух потоков.
      if (this.expected === 1 && this.stream >= 1) {
        this.expected = 2;
        this.last = Math.min(this.last, this._overall(0));
      }
      // Оценка размера бывает занижена: пока yt-dlp сам говорит, что осталось несколько секунд, до 100% не доходим.
      if (fraction != null && fraction >= 0.99 && num(eta) != null && num(eta) > 3) fraction = 0.99;
      return {
        type: 'progress',
        percent: fraction == null ? null : this._bump(this._overall(fraction)),
        speed: num(speed),
        eta: num(eta),
        downloaded,
        total: totalBytes,
        entry: this.entry,
        entries: this.entries,
      };
    }

    if (line.startsWith('[POST]|')) {
      const [, status, name] = line.split('|');
      if (status !== 'started') return null;
      const cap = (this.entry - 0.01) / this.entries;
      return {
        type: 'status',
        text: postLabel(name),
        percent: this._bump(Math.min(this._overall(1), cap)),
      };
    }

    if (line.startsWith('[FILE]')) {
      this.lastFile = line.slice(6);
      this.fileIsFinal = true;
      return { type: 'file', path: this.lastFile };
    }

    const entryMatch = /^\[download\] Downloading (?:item|video) (\d+) of (\d+)/.exec(line);
    if (entryMatch) {
      this.entry = Number(entryMatch[1]);
      this.entries = Math.max(1, Number(entryMatch[2]));
      this.stream = 0;
      return { type: 'entry', entry: this.entry, entries: this.entries };
    }

    if (line.startsWith('ERROR:')) {
      return { type: 'error-line', message: line.replace(/^ERROR:\s*/, '') };
    }

    if (!this.fileIsFinal) {
      for (const re of FALLBACK_FILE_PATTERNS) {
        const m = re.exec(line);
        if (m) {
          this.lastFile = m[1];
          break;
        }
      }
    }
    return null;
  }
}

module.exports = { ProgressTracker, num };
