'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Убирает из текста всё, что нельзя отдавать в отчёт: пароль прокси, куки, токены. */
function mask(text) {
  return String(text == null ? '' : text)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1***@')                 // user:pass@host
    .replace(/\b(Cookie|Set-Cookie|Authorization|Proxy-Authorization)\s*:\s*[^\r\n]+/gi, '$1: ***')
    .replace(/\b(SAPISID|APISID|HSID|SSID|SID|__Secure-[\w-]+|LOGIN_INFO|VISITOR_INFO1_LIVE|PO_TOKEN|po_token)\b(\s*[=\t]\s*)[^\s;]+/g, '$1$2***')
    .replace(/(--proxy\s+)\S+/g, '$1***')
    .replace(/((?:access|refresh|id)_token|api[_-]?key|password)(["'\s:=]+)[^\s"',;]+/gi, '$1$2***');
}

/**
 * Простой журнал в файл с ротацией: app.log, затем app.log.1 … app.log.N.
 * Запись синхронная: событий мало, зато ничего не теряется при аварийном выходе.
 */
function createLogger(dir, { maxBytes = 400 * 1024, keep = 3, now = () => new Date() } = {}) {
  const file = path.join(dir, 'app.log');
  let ready = false;
  const ensure = () => {
    if (ready) return true;
    try { fs.mkdirSync(dir, { recursive: true }); ready = true; } catch { /* журнал недоступен — не страшно */ }
    return ready;
  };
  function rotate() {
    try {
      if (fs.statSync(file).size < maxBytes) return;
    } catch { return; }
    for (let i = keep - 1; i >= 1; i -= 1) {
      try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* нет такого файла */ }
    }
    try { fs.renameSync(file, `${file}.1`); } catch { /* ignore */ }
    try { fs.rmSync(`${file}.${keep + 1}`, { force: true }); } catch { /* ignore */ }
  }
  function write(level, msg) {
    if (!ensure()) return;
    try {
      rotate();
      fs.appendFileSync(file, `${now().toISOString()} ${level} ${mask(msg).slice(0, 4000)}\n`);
    } catch { /* ignore */ }
  }
  /** Все журналы от старых к новым одним текстом (для отчёта). */
  function readAll() {
    const parts = [];
    for (let i = keep; i >= 1; i -= 1) {
      try { parts.push(fs.readFileSync(`${file}.${i}`, 'utf8')); } catch { /* нет */ }
    }
    try { parts.push(fs.readFileSync(file, 'utf8')); } catch { /* нет */ }
    return parts.join('');
  }
  return { file, info: (m) => write('INFO', m), warn: (m) => write('WARN', m), error: (m) => write('ERROR', m), readAll };
}

module.exports = { createLogger, mask };
