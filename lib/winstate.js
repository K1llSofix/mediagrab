'use strict';

const DEFAULT = { width: 1080, height: 780 };
const MIN = { width: 900, height: 600 };

/** Хватает ли пересечения окна с каким-нибудь монитором, чтобы его можно было схватить мышью. */
function visibleEnough(b, displays) {
  return displays.some((d) => {
    const w = Math.min(b.x + b.width, d.x + d.width) - Math.max(b.x, d.x);
    const h = Math.min(b.y + b.height, d.y + d.height) - Math.max(b.y, d.y);
    return w >= 200 && h >= 100;
  });
}

/**
 * Приводит сохранённое состояние окна к безопасному виду.
 * displays — рабочие области мониторов [{x,y,width,height}]. Если окно уехало за пределы (монитор отключили), позицию сбрасываем.
 */
function sanitizeState(saved, displays) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const num = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  const width = Math.max(MIN.width, num(s.width) || DEFAULT.width);
  const height = Math.max(MIN.height, num(s.height) || DEFAULT.height);
  const out = { width, height, maximized: s.maximized === true };
  const x = num(s.x);
  const y = num(s.y);
  if (x !== null && y !== null && Array.isArray(displays) && visibleEnough({ x, y, width, height }, displays)) {
    out.x = x;
    out.y = y;
  }
  return out;
}

module.exports = { sanitizeState, DEFAULT, MIN };
