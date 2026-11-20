'use strict';

(() => {
  const api = window.api;
  const I18N = window.I18N;
  const $ = (sel, root = document) => root.querySelector(sel);

  // ---------- Настройки ----------
  function guessLang() {
    const code = String(navigator.language || '').toLowerCase().slice(0, 2);
    return ['ru', 'uk', 'de', 'es'].includes(code) ? code : 'en';
  }
  const DEFAULTS = {
    format: 'mp4', mp4Quality: 'best', mp3Quality: '320', webmQuality: 'best', gifQuality: '480', m4aQuality: 'best', flacQuality: 'best', outDir: '',
    cookiesBrowser: '', cookiesFile: '', appCookies: '', proxy: '',
    nameTemplate: 'title', limitRate: '', embedCover: true, subs: false, subLangs: 'ru,en', closeToTray: false, exactCut: false, parallel: 2, notify: true, watchClipboard: false, poToken: false,
    lang: guessLang(),
    theme: 'auto',
  };
  const LANGS = ['ru', 'en', 'uk', 'de', 'es'];
  const LOCALES = { ru: 'ru-RU', en: 'en-GB', uk: 'uk-UA', de: 'de-DE', es: 'es-ES' };
  const STORE_KEY = 'mediagrab.settings';
  function loadSettings() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
  }
  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* хранилище недоступно */ }
  }
  const settings = loadSettings();
  // Chrome, Edge и другие Chromium-браузеры на Windows шифруют куки так, что их не прочитать: такой выбор сбрасываем.
  if (settings.cookiesBrowser !== 'firefox') settings.cookiesBrowser = '';
  // раньше вход подставлялся во все загрузки; теперь он включается только по требованию сайта
  if (settings.appCookies && settings.cookiesFile === settings.appCookies) settings.cookiesFile = '';
  if (!['ru', 'en', 'uk', 'de', 'es'].includes(settings.lang)) settings.lang = guessLang();
  const t = (key, params) => I18N.t(settings.lang, key, params);
  const ytOpts = () => ({ cookiesBrowser: settings.cookiesBrowser, cookiesFile: settings.cookiesFile, proxy: settings.proxy, poToken: settings.poToken === true });
  const jobOpts = () => ({
    nameTemplate: settings.nameTemplate, limitRate: settings.limitRate, embedCover: settings.embedCover,
    subs: settings.subs, subLangs: settings.subLangs, exactCut: settings.exactCut === true,
  });

  /** Субтитры для карточки: пусто = как в настройках, 'none' = без них, иначе один выбранный язык. */
  function itemSubs(it) {
    if (!it.subLang) return {};
    if (it.subLang === 'none') return { subs: false };
    return { subs: true, subLangs: it.subLang };
  }

  // ---------- Помощники ----------
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const SITES = [
    { id: 'youtube', name: 'YouTube', re: /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/ },
    { id: 'tiktok', name: 'TikTok', re: /(^|\.)tiktok\.com$/ },
    { id: 'instagram', name: 'Instagram', re: /(^|\.)instagram\.com$/ },
    { id: 'vk', name: 'VK', re: /(^|\.)(vk\.com|vk\.ru|vkvideo\.ru|vk\.cc)$/ },
    { id: 'soundcloud', name: 'SoundCloud', re: /(^|\.)(soundcloud\.com|snd\.sc)$/ },
    { id: 'pinterest', name: 'Pinterest', re: /(^|\.)(pinterest\.[a-z.]+|pin\.it)$/ },
  ];
  function siteOf(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      const s = SITES.find((x) => x.re.test(host));
      if (s) return { id: s.id, name: s.id === 'vk' ? t('site.vk') : s.name };
      return { id: 'other', name: host.replace(/^www\./, '') };
    } catch {
      return { id: 'other', name: t('link.generic') };
    }
  }

  const fmtDuration = (s) => {
    if (s == null) return '';
    s = Math.round(s);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  };
  const fmtBytes = (b) => {
    if (b == null) return '';
    const units = ['u.b', 'u.kb', 'u.mb', 'u.gb'];
    let i = 0;
    while (b >= 1024 && i < units.length - 1) { b /= 1024; i += 1; }
    return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)} ${t(units[i])}`;
  };
  const fmtEta = (s) => {
    s = Math.round(s);
    if (s < 60) return `${s} ${t('u.s')}`;
    if (s < 3600) return `${Math.floor(s / 60)} ${t('u.min')} ${s % 60} ${t('u.s')}`;
    return `${Math.floor(s / 3600)} ${t('u.h')} ${Math.floor((s % 3600) / 60)} ${t('u.min')}`;
  };

  // ---------- Качество ----------
  const STD_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
  const AUDIO_FORMATS = ['mp3', 'm4a', 'flac'];
  const ALL_FORMATS = ['mp4', 'webm', 'gif', 'mp3', 'm4a', 'flac'];
  const formatLabel = (f) => t(`fmt.${f}opt`);
  function qualityOptions(format, info) {
    if (format === 'mp3') return [320, 256, 192, 128].map((v) => ({ value: String(v), label: t('q.kbps', { v }) }));
    if (format === 'm4a' || format === 'flac') return [{ value: 'best', label: t('q.original') }];
    if (format === 'gif') return [320, 480, 640].map((v) => ({ value: String(v), label: t('q.px', { v }) }));
    const hs = info && info.heights && info.heights.length ? info.heights : STD_HEIGHTS;
    const qmap = new Map(((info && info.qualities) || []).map((q) => [q.height, q]));
    return [
      { value: 'best', label: t('q.best') },
      ...hs.map((v) => {
        const q = qmap.get(v);
        const fps = q && q.fps > 30 ? q.fps : ''; // 60 кадров/с показываем, обычные 24–30 нет смысла
        const size = q && q.bytes ? ` · ≈${fmtBytes(q.bytes)}` : '';
        return { value: String(v), label: `${v}p${fps}${v >= 2160 ? ' (4K)' : v >= 1440 ? ' (2K)' : ''}${size}` };
      }),
    ];
  }
  function pickQuality(format, info, wanted) {
    const values = qualityOptions(format, info).map((o) => o.value);
    if (values.includes(String(wanted))) return String(wanted);
    if (format === 'mp3') return values[0];
    if (format === 'gif') return '480';
    if (format === 'm4a' || format === 'flac') return 'best';
    if (wanted === 'best') return 'best';
    const nums = values.filter((v) => v !== 'best').map(Number).sort((a, b) => b - a);
    const w = Number(wanted);
    const found = nums.find((n) => n <= w);
    return String(found != null ? found : nums.length ? nums[nums.length - 1] : 'best');
  }

  /** Если у видео нет качества, выбранного по умолчанию, объясняем, почему предложено меньшее. */
  function qualityNote(it) {
    if ((it.format !== 'mp4' && it.format !== 'webm') || !it.qualityAuto) return '';
    const wanted = Number(settings[`${it.format}Quality`]);
    const got = Number(it.quality);
    if (!wanted || !got || got >= wanted) return '';
    return t('card.q_capped', { w: wanted, q: got });
  }

  /** «90», «1:30», «1:02:30» -> секунды; null для пустой строки, NaN для неверного ввода. */
  function parseClock(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    const parts = s.split(':');
    if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return NaN;
    return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
  }

  // ---------- Состояние ----------
  const items = [];
  const cardEls = new Map();
  let nextId = 1;
  let ytVersion = '';
  let appVersion = '';
  let pendingUpdate = null;
  const maxParallel = () => ([1, 2, 3, 4].includes(settings.parallel) ? settings.parallel : 2);
  const MAX_PARALLEL_INFO = 3;

  const isIdle = (it) => it.status === 'ready' || (it.status === 'error' && it.phase === 'download') || it.status === 'cancelled';
  const find = (id) => items.find((i) => i.id === id);

  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  /** Делает элемент источником перетаскивания файла в другие программы. */
  function makeDraggable(el, file) {
    if (!file || !api.startDrag) return;
    el.draggable = true;
    el.title = t('drag.hint');
    el.addEventListener('dragstart', (e) => { e.preventDefault(); api.startDrag(file); });
  }

  // ---------- История, выбор из плейлиста, уведомление ----------
  const HIST_KEY = 'mediagrab.history';
  function loadHistory() {
    try { const a = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  let history = loadHistory();
  const isSeen = (url) => history.some((x) => x.url === url);
  function addHistory(it) {
    history = [
      { url: it.url, title: displayTitle(it), site: siteOf(it.url).name, format: it.format, quality: it.quality, file: it.filePath, dir: it.dir, ts: Date.now() },
      ...history.filter((x) => !(x.url === it.url && x.format === it.format)),
    ].slice(0, 200);
    try { localStorage.setItem(HIST_KEY, JSON.stringify(history)); } catch { /* хранилище недоступно */ }
  }
  function renderHistory() {
    const list = $('#historyList');
    list.replaceChildren();
    if (!history.length) { list.append(h('div', { class: 'dlg-empty', text: t('history.empty') })); return; }
    const locale = LOCALES[settings.lang] || 'en-GB';
    const q = $('#historyFind').value.trim().toLowerCase();
    const shown = q ? history.filter((x) => `${x.title} ${x.site} ${x.format}`.toLowerCase().includes(q)) : history;
    if (!shown.length) { list.append(h('div', { class: 'dlg-empty', text: t('find.none') })); return; }
    for (const x of shown) {
      const row = h('div', { class: 'hrow' },
        h('div', { class: 'row-title', text: x.title }),
        h('div', { class: 'hbtns' },
          h('button', { class: 'btn ghost sm', type: 'button', text: t('btn.show'), onclick: () => (x.file ? api.showItem(x.file) : api.openFolder(x.dir)) }),
          h('button', { class: 'btn ghost sm', type: 'button', text: t('history.again'), onclick: () => { $('#history').close(); addUrls(x.url); } })),
        h('div', { class: 'hmeta', text: `${x.site}  ${String(x.format).toUpperCase()}  ${new Date(x.ts).toLocaleString(locale)}` }));
      makeDraggable(row, x.file);
      list.append(row);
    }
  }
  $('#historyFind').addEventListener('input', renderHistory);
  $('#historyBtn').addEventListener('click', () => { $('#historyFind').value = ''; renderHistory(); $('#history').showModal(); });
  $('#historyClose').addEventListener('click', () => $('#history').close());
  $('#historyClear').addEventListener('click', () => {
    if (!confirm(t('history.confirm_clear'))) return;
    history = [];
    try { localStorage.removeItem(HIST_KEY); } catch { /* ignore */ }
    renderHistory();
  });

  let chooserState = null;
  const chooserQueue = []; // плейлисты, которые догрузились, пока открыто другое окно выбора
  function nextChooser() {
    if (chooserState || $('#chooser').open) return;
    while (chooserQueue.length) {
      const it = chooserQueue.shift();
      if (items.includes(it)) { openChooser(it); return; }
    }
  }
  function updateChooser() {
    if (!chooserState) return;
    const n = chooserState.boxes.filter((b) => b.checked).length;
    $('#chooserAdd').textContent = t('chooser.add', { n });
    $('#chooserAdd').disabled = n === 0;
  }
  /** Плейлист или канал: даём выбрать нужные видео, каждое потом добавляется как отдельная ссылка. */
  function openChooser(it) {
    const entries = it.info.entries;
    const list = $('#chooserList');
    list.replaceChildren();
    $('#chooserFind').value = '';
    const rows = [];
    const boxes = entries.map((e) => {
      const cb = h('input', { type: 'checkbox', checked: true, onchange: updateChooser });
      const row = h('label', { class: 'row' }, cb,
        h('span', { class: 'row-title', title: e.title, text: e.title || e.url }),
        e.duration ? h('span', { class: 'row-dur', text: fmtDuration(e.duration) }) : null);
      rows.push(row);
      list.append(row);
      return cb;
    });
    chooserState = { it, boxes, entries, rows };
    $('#chooserTitle').textContent = it.info.title ? `${t('chooser.title')}: ${it.info.title}` : t('chooser.title');
    updateChooser();
    $('#chooser').showModal();
  }
  // «Выбрать все» и «Снять выбор» действуют на то, что видно после поиска
  const setVisibleChecked = (v) => {
    if (!chooserState) return;
    chooserState.boxes.forEach((b, i) => { if (!chooserState.rows[i].hidden) b.checked = v; });
    updateChooser();
  };
  $('#chooserAll').addEventListener('click', () => setVisibleChecked(true));
  $('#chooserNone').addEventListener('click', () => setVisibleChecked(false));
  $('#chooserFind').addEventListener('input', (e) => {
    if (!chooserState) return;
    const q = e.target.value.trim().toLowerCase();
    chooserState.rows.forEach((row, i) => { row.hidden = !!q && !String(chooserState.entries[i].title || chooserState.entries[i].url).toLowerCase().includes(q); });
  });
  $('#chooserAdd').addEventListener('click', () => {
    if (!chooserState) return;
    const { it, boxes, entries } = chooserState;
    const urls = entries.filter((_, i) => boxes[i].checked).map((e) => e.url);
    chooserState = null;
    $('#chooser').close();
    removeItem(it);
    addUrls(urls.join('\n'));
    nextChooser();
  });
  $('#chooserCancel').addEventListener('click', () => $('#chooser').close());
  $('#chooser').addEventListener('close', () => {
    if (chooserState) { const { it } = chooserState; chooserState = null; removeItem(it); }
    nextChooser();
  });

  let batchDone = 0;
  let batchErr = 0;
  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
      setTimeout(() => ctx.close(), 700);
    } catch { /* звук недоступен */ }
  }
  /** Когда очередь опустела, а окно не в фокусе: звук и системное уведомление. */
  function maybeNotify() {
    if (items.some((i) => i.status === 'queued' || i.status === 'downloading')) return;
    if (!batchDone && !batchErr) return;
    const done = batchDone;
    const err = batchErr;
    batchDone = 0;
    batchErr = 0;
    if (done > 0) startAfter();
    if (!settings.notify || document.hasFocus()) return;
    beep();
    try {
      if ('Notification' in window) {
        new Notification('MediaGrab', { body: [t('notify.done', { n: done }), err ? t('notify.errors', { n: err }) : ''].filter(Boolean).join('. ') });
      }
    } catch { /* уведомления недоступны */ }
  }

  // ---------- Добавление ссылок ----------
  const infoWaiting = [];
  let infoRunning = 0;

  function addUrls(text, extra = null) {
    const urls = [...new Set(String(text || '').match(/https?:\/\/[^\s<>"']+/g) || [])];
    if (!urls.length) { toast(t('toast.no_links')); return 0; }
    let added = 0;
    for (const url of urls) {
      if (items.some((i) => i.url === url)) continue;
      const it = {
        id: `i${nextId++}`, url, status: 'loading', info: null, format: settings.format, quality: '',
        percent: 0, entry: 1, entries: 1, label: '', error: '', phase: 'info', filePath: null, dir: null,
        start: '', end: '', seen: false, needsLogin: false,
        ...(extra || {}),
      };
      items.push(it);
      infoWaiting.push(it);
      renderCard(it);
      added += 1;
    }
    pumpInfo();
    refreshChrome();
    if (!added) toast(t('toast.dup'));
    return added;
  }

  function pumpInfo() {
    while (infoRunning < MAX_PARALLEL_INFO && infoWaiting.length) {
      const it = infoWaiting.shift();
      if (!items.includes(it)) continue;
      infoRunning += 1;
      runInfo(it).finally(() => { infoRunning -= 1; pumpInfo(); });
    }
  }

  async function runInfo(it) {
    it.status = 'loading';
    it.phase = 'info';
    renderCard(it);
    let res;
    try {
      res = await api.fetchInfo({ id: it.id, url: it.url, opts: ytOpts() });
    } catch (e) {
      res = { ok: false, error: e.message || String(e) };
    }
    if (!items.includes(it)) return;
    if (res.ok) {
      if (res.notice) toast(res.notice);
      it.info = res.info;
      it.usedLogin = !!res.usedLogin;
      it.seen = isSeen(it.url);
      it.format = it.info.kind === 'image' ? 'image' : it.info.audioOnly ? 'mp3' : (it.autoFormat || settings.format);
      it.quality = it.format === 'image' ? 'original' : pickQuality(it.format, it.info, settings[`${it.format}Quality`]);
      it.qualityAuto = true;
      if (it.restore && it.format !== 'image' && ALL_FORMATS.includes(it.restore.format) && !(it.info.audioOnly && !AUDIO_FORMATS.includes(it.restore.format))) {
        // возвращаем выбор пользователя из прошлого запуска, если он ещё возможен для этой ссылки
        it.format = it.restore.format;
        it.quality = pickQuality(it.format, it.info, it.restore.quality);
        it.qualityAuto = false;
        if (it.info.kind === 'video' && it.info.duration) { it.start = it.restore.start; it.end = it.restore.end; }
      }
      if (it.restore) {
        if ((it.info.audioTracks || []).some((a) => a.lang === it.restore.audioLang)) it.audioLang = it.restore.audioLang;
        const codes = it.info.subs ? [...it.info.subs.manual, ...it.info.subs.auto] : [];
        if (it.restore.subLang === 'none' || codes.includes(it.restore.subLang)) it.subLang = it.restore.subLang;
      }
      it.status = 'ready';
    } else {
      it.status = 'error';
      it.error = res.error || t('card.info_failed');
      it.details = res.details || '';
      it.needsLogin = !!res.needsLogin;
    }
    renderCard(it);
    refreshChrome();
    if (it.status === 'ready' && it.autoStart && !it.info.collection) startItem(it);
    else if (it.status === 'ready' && it.info.collection) { chooserQueue.push(it); nextChooser(); }
  }

  // ---------- Сохранение очереди между запусками ----------
  const QUEUE_KEY = 'mediagrab.queue';
  let queueTimer = null;
  let queueReady = false; // пока очередь не восстановлена, сохранять нельзя: пустой список затёр бы её
  function persistQueue() {
    if (!queueReady) return;
    clearTimeout(queueTimer);
    queueTimer = setTimeout(() => {
      const keep = items.filter((i) => i.status !== 'done' && /^https?:\/\//.test(i.url)).slice(0, 100)
        .map((i) => ({ url: i.url, format: i.format, quality: i.quality, start: i.start || '', end: i.end || '', audioLang: i.audioLang || '', subLang: i.subLang || '' }));
      try {
        if (keep.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(keep));
        else localStorage.removeItem(QUEUE_KEY);
      } catch { /* хранилище недоступно */ }
    }, 300);
  }
  function restoreQueue() {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { saved = []; }
    if (!Array.isArray(saved)) return;
    for (const s of saved.slice(0, 100)) {
      if (!s || typeof s.url !== 'string' || !/^https?:\/\//.test(s.url)) continue;
      addUrls(s.url, { restore: { format: String(s.format || ''), quality: String(s.quality || ''), start: String(s.start || ''), end: String(s.end || ''), audioLang: String(s.audioLang || ''), subLang: String(s.subLang || '') } });
    }
  }

  // ---------- Подписки ----------
  const SUBS_KEY = 'mediagrab.subs';
  const SUB_FORMATS = ['mp4', 'webm', 'mp3', 'm4a', 'flac'];
  let subs = [];
  try { subs = SubsCore.sanitizeSubs(JSON.parse(localStorage.getItem(SUBS_KEY) || '[]')); } catch { subs = []; }
  const saveSubs = () => { try { localStorage.setItem(SUBS_KEY, JSON.stringify(subs)); } catch { /* хранилище недоступно */ } };
  let subsBusy = false;
  let subSeq = 0;
  const subOpts = () => ({ ...ytOpts(), playlistEnd: SubsCore.FRESH_WINDOW });

  function renderSubs() {
    const list = $('#subsList');
    list.replaceChildren();
    $('#subsCheck').disabled = subsBusy || !subs.length;
    if (!subs.length) { list.append(h('div', { class: 'dlg-empty', text: t('subs.empty') })); return; }
    const locale = LOCALES[settings.lang] || 'en-GB';
    for (const sub of subs) {
      const when = sub.lastCheck ? new Date(sub.lastCheck).toLocaleString(locale) : t('subs.never');
      list.append(h('div', { class: 'hrow' },
        h('div', { class: 'row-title', title: sub.url, text: sub.title || sub.url }),
        h('div', { class: 'hbtns' },
          h('button', { class: 'btn ghost sm', type: 'button', text: t('subs.remove'), onclick: () => { if (!confirm(t('subs.confirm_remove', { name: sub.title || sub.url }))) return; subs = subs.filter((x) => x !== sub); saveSubs(); renderSubs(); } })),
        h('div', { class: 'hmeta', text: `${sub.format.toUpperCase()}  ${t('subs.checked', { v: when })}${sub.lastError ? `  ⚠ ${sub.lastError}` : ''}` })));
    }
  }

  async function fetchFresh(url) {
    subSeq += 1;
    return api.fetchInfo({ id: `sub${subSeq}`, url, opts: subOpts() });
  }

  async function subscribe(rawUrl) {
    const url = SubsCore.normalizeSubUrl(rawUrl);
    if (!url) { toast(t('toast.no_links')); return false; }
    if (subs.some((x) => x.url === url)) { toast(t('subs.dup')); return false; }
    if (subs.length >= SubsCore.MAX_SUBS) { toast(t('subs.limit', { n: SubsCore.MAX_SUBS })); return false; }
    subsBusy = true;
    $('#subsAdd').disabled = true;
    toast(t('subs.checking'));
    try {
      const res = await fetchFresh(url);
      if (!res.ok) { toast(t('subs.fail', { e: res.error })); return false; }
      if (!res.info.collection) { toast(t('subs.not_list')); return false; }
      const format = SUB_FORMATS.includes(settings.format) ? settings.format : 'mp4';
      const sub = SubsCore.makeSub({ url, title: res.info.title, format, entries: res.info.entries });
      subs.push(sub);
      saveSubs();
      renderSubs();
      toast(t('subs.added', { name: sub.title || url }));
      return true;
    } catch (e) {
      toast(t('subs.fail', { e: e.message || String(e) }));
      return false;
    } finally {
      subsBusy = false;
      $('#subsAdd').disabled = false;
      renderSubs();
    }
  }

  /** Проверяет подписки (все или только те, чей срок пришёл) и сразу ставит новые видео на загрузку. */
  async function checkSubs(force) {
    if (subsBusy || !subs.length) return;
    subsBusy = true;
    renderSubs();
    let found = 0;
    try {
      for (const sub of [...subs]) {
        if (!subs.includes(sub) || (!force && !SubsCore.isDue(sub))) continue;
        let res;
        try { res = await fetchFresh(sub.url); } catch (e) { res = { ok: false, error: e.message || String(e) }; }
        sub.lastCheck = Date.now();
        if (!res.ok || !res.info.collection) {
          sub.lastError = String(res.ok ? t('subs.not_list') : res.error).split('\n')[0].slice(0, 200);
        } else {
          sub.lastError = '';
          const fresh = SubsCore.newEntries(sub, res.info.entries);
          SubsCore.markSeen(sub, fresh); // остальное уже в seen; не помечаем то, что не поставили в очередь
          if (fresh.length) {
            found += fresh.length;
            addUrls(fresh.map((e) => e.url).join('\n'), { autoStart: true, autoFormat: sub.format });
          }
        }
        saveSubs();
        await new Promise((r) => setTimeout(r, 3000)); // небольшая пауза между каналами
      }
    } finally {
      subsBusy = false;
      renderSubs();
    }
    if (force) toast(found ? t('subs.new', { n: found }) : t('subs.none'));
  }

  // ---------- Окно настроек ----------
  $('#settingsBtn').addEventListener('click', () => { renderSettings(); $('#settings').showModal(); });
  $('#settingsClose').addEventListener('click', () => $('#settings').close());
  for (const tab of document.querySelectorAll('#settings .tab')) {
    tab.addEventListener('click', () => {
      for (const x of document.querySelectorAll('#settings .tab')) x.classList.toggle('on', x === tab);
      for (const p of document.querySelectorAll('#settings .panel')) p.hidden = p.dataset.panel !== tab.dataset.tab;
    });
  }

  // ---------- Действие после очереди (только на этот запуск: забытое «выключить» было бы опасно) ----------
  let afterAction = 'none';
  let afterTimer = null;
  $('#afterSel').addEventListener('change', (e) => { afterAction = e.target.value; });
  function stopAfter() { api.disarmAfter(); clearInterval(afterTimer); afterTimer = null; if ($('#afterDlg').open) $('#afterDlg').close(); }
  function startAfter() {
    const kind = afterAction;
    if (kind === 'none' || afterTimer) return;
    let left = kind === 'quit' ? 10 : 60;
    $('#afterTitle').textContent = t(`after.${kind}`);
    const paint = () => { $('#afterText').textContent = t('after.countdown', { s: left }); };
    paint();
    api.armAfter(kind);
    $('#afterDlg').showModal();
    afterTimer = setInterval(() => {
      left -= 1;
      if (left > 0) { paint(); return; }
      stopAfter();
      afterAction = 'none';
      $('#afterSel').value = 'none';
      api.afterAction(kind);
    }, 1000);
  }
  $('#afterCancel').addEventListener('click', () => { stopAfter(); afterAction = 'none'; $('#afterSel').value = 'none'; });
  $('#afterDlg').addEventListener('cancel', () => { api.disarmAfter(); clearInterval(afterTimer); afterTimer = null; afterAction = 'none'; $('#afterSel').value = 'none'; });

  $('#subsBtn').addEventListener('click', () => { renderSubs(); $('#subs').showModal(); });
  $('#subsClose').addEventListener('click', () => $('#subs').close());
  $('#subsCheck').addEventListener('click', () => checkSubs(true));
  $('#subsAdd').addEventListener('click', async () => {
    const inp = $('#subsUrl');
    if (await subscribe(inp.value)) inp.value = '';
  });
  $('#subsUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#subsAdd').click(); } });
  $('#chooserSub').addEventListener('click', () => { if (chooserState) subscribe(chooserState.it.url); });
  setInterval(() => checkSubs(false), 10 * 60 * 1000);

  // ---------- Общий прогресс очереди ----------
  let batch = null; // { start } пока идёт хотя бы одна загрузка
  let lastTaskbar = -2;
  function refreshOverall() {
    const box = $('#overall');
    const running = items.some((i) => i.status === 'queued' || i.status === 'downloading');
    if (!running) {
      if (batch) { for (const i of items) i.inBatch = false; batch = null; }
      box.hidden = true;
      document.title = 'MediaGrab';
      if (lastTaskbar !== -1 && api.setProgress) { api.setProgress(-1); lastTaskbar = -1; }
      return;
    }
    const list = items.filter((i) => i.inBatch);
    const n = list.length;
    if (!n) { box.hidden = true; return; }
    const finished = (i) => i.status === 'done' || i.status === 'error';
    const done = list.filter(finished).length;
    const fraction = list.reduce((sum, i) => sum + (finished(i) ? 1 : i.status === 'downloading' ? Math.min(1, i.percent || 0) : 0), 0) / n;
    const elapsed = (Date.now() - batch.start) / 1000;
    const eta = fraction >= 0.05 && elapsed >= 5 ? (elapsed * (1 - fraction)) / fraction : null;
    const pct = Math.floor(fraction * 100);
    box.hidden = n < 2;
    $('#overallFill').style.width = `${pct}%`;
    $('#overallText').textContent = [t('overall.text', { done, n }), `${pct}%`, eta != null ? t('card.eta', { v: fmtEta(eta) }) : ''].filter(Boolean).join('  ');
    document.title = `${pct}% — MediaGrab`;
    if (api.setProgress && Math.abs(fraction - lastTaskbar) >= 0.01) { api.setProgress(fraction); lastTaskbar = fraction; }
  }

  // ---------- Скачивание ----------
  function startItem(it) {
    if (!isIdle(it) || !it.info || it.info.live) return;
    it.inBatch = true;
    if (!batch) batch = { start: Date.now() };
    it.status = 'queued';
    it.percent = 0;
    it.label = '';
    it.error = '';
    renderCard(it);
    pumpDownloads();
    refreshChrome();
  }

  function pumpDownloads() {
    let running = items.filter((i) => i.status === 'downloading').length;
    for (const it of items) {
      if (running >= maxParallel()) break;
      if (it.status !== 'queued') continue;
      it.status = 'downloading';
      it.phase = 'download';
      it.label = t('card.starting');
      running += 1;
      renderCard(it);
      api.startJob({
        id: it.id,
        url: it.url,
        kind: it.info.kind,
        format: it.format,
        quality: it.quality,
        splitStreams: !!it.info.splitStreams,
        image: it.info.image || null,
        outDir: settings.outDir,
        clipStart: it.start,
        clipEnd: it.end,
        useLogin: !!it.usedLogin,
        audioLang: it.audioLang || '',
        ...jobOpts(),
        ...itemSubs(it),
        ...ytOpts(),
      });
    }
  }

  function progressText(it) {
    const parts = [];
    if (it.entries > 1) parts.push(t('card.file_of', { i: it.entry, n: it.entries }));
    if (it.label) {
      parts.push(it.label);
    } else {
      if (it.percent != null && it.percent > 0) parts.push(`${Math.floor(it.percent * 100)}%`);
      else if (it.downloaded) parts.push(fmtBytes(it.downloaded));
      if (it.speed) parts.push(t('card.speed', { v: fmtBytes(it.speed) }));
      if (it.eta != null) parts.push(t('card.eta', { v: fmtEta(it.eta) }));
    }
    return parts.join('  ') || t('card.downloading');
  }

  api.onJobEvent((ev) => {
    const it = find(ev.id);
    if (!it) return;
    // Запоздавшие события прогресса (например, после отмены) игнорируем.
    if ((ev.type === 'progress' || ev.type === 'status' || ev.type === 'entry') && it.status !== 'downloading') return;
    switch (ev.type) {
      case 'progress':
        it.label = '';
        it.percent = ev.percent;
        it.speed = ev.speed;
        it.eta = ev.eta;
        it.downloaded = ev.downloaded;
        it.entry = ev.entry || it.entry;
        it.entries = ev.entries || it.entries;
        updateProgress(it);
        return;
      case 'status':
        it.label = ev.text;
        if (ev.percent != null) it.percent = ev.percent;
        updateProgress(it);
        return;
      case 'entry':
        it.entry = ev.entry;
        it.entries = ev.entries;
        updateProgress(it);
        return;
      case 'done':
        it.status = 'done';
        it.percent = 1;
        it.filePath = ev.path || null;
        it.dir = ev.dir || settings.outDir;
        addHistory(it);
        batchDone += 1;
        break;
      case 'error':
        it.status = 'error';
        it.phase = 'download';
        it.error = ev.message;
        it.details = ev.details || '';
        it.needsLogin = !!ev.needsLogin;
        batchErr += 1;
        break;
      case 'cancelled':
        it.status = 'ready';
        it.inBatch = false; // отменённая загрузка не должна держать общий прогресс
        break;
      default:
        return;
    }
    renderCard(it);
    pumpDownloads();
    refreshChrome();
    maybeNotify();
  });

  function cancelItem(it) {
    if (it.status === 'queued') { it.status = 'ready'; renderCard(it); refreshChrome(); return; }
    api.cancel(it.id);
  }

  function removeItem(it) {
    if (it.status === 'downloading' || it.status === 'loading') api.cancel(it.id);
    const idx = items.indexOf(it);
    if (idx >= 0) items.splice(idx, 1);
    const el = cardEls.get(it.id);
    if (el) el.remove();
    cardEls.delete(it.id);
    pumpDownloads();
    refreshChrome();
  }

  // ---------- Отрисовка ----------
  function updateProgress(it) {
    const el = cardEls.get(it.id);
    if (!el) return;
    if (!$('.tape', el)) return;
    const unknown = it.percent == null;
    $('.tape', el).classList.toggle('indeterminate', unknown);
    $('.tape-fill', el).style.width = unknown ? '' : `${Math.round(it.percent * 100)}%`;
    $('.status', el).textContent = progressText(it);
    refreshOverall();
  }

  function select(options, value, onChange, disabled) {
    return h('select', { disabled, onchange: (e) => onChange(e.target.value) },
      options.map((o) => h('option', { value: o.value, selected: o.value === value, text: o.label })));
  }

  function displayTitle(it) {
    if (!it.info) return it.url;
    if (it.info.title) return it.info.title;
    return it.info.kind === 'playlist' ? t('card.set') : t('card.untitled');
  }

  /** Фрагмент: двойной ползунок и поля времени, связанные друг с другом. */
  function buildClip(it, locked) {
    const dur = Math.max(2, Math.floor(it.info.duration));
    const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
    const s0 = parseClock(it.start);
    const e0 = parseClock(it.end);
    const startVal = Number.isFinite(s0) ? clamp(Math.floor(s0), 0, dur - 1) : 0;
    const endVal = Number.isFinite(e0) && e0 > 0 ? clamp(Math.floor(e0), startVal + 1, dur) : dur;

    const range = (cls, value, label) => h('input', {
      type: 'range', class: `rng ${cls}`, min: 0, max: dur, step: 1, value, disabled: locked, 'aria-label': label,
    });
    const a = range('rng-a', startVal, t('clip.start'));
    const b = range('rng-b', endVal, t('clip.end'));
    const track = h('div', { class: 'clip-track' }, a, b);
    const len = h('div', { class: 'clip-len' });
    const startTxt = h('input', { type: 'text', value: it.start, placeholder: '0:00', disabled: locked, 'aria-label': t('clip.start') });
    const endTxt = h('input', { type: 'text', value: it.end, placeholder: t('card.clip_end'), disabled: locked, 'aria-label': t('clip.end') });

    const paint = () => {
      const s = Number(a.value);
      const e = Number(b.value);
      track.style.setProperty('--from', `${(s / dur) * 100}%`);
      track.style.setProperty('--to', `${(e / dur) * 100}%`);
      len.textContent = t('clip.length', { v: fmtDuration(Math.max(0, e - s)) });
    };
    a.addEventListener('input', () => {
      let s = Number(a.value);
      if (s > Number(b.value) - 1) { s = Math.max(0, Number(b.value) - 1); a.value = s; }
      it.start = s > 0 ? fmtDuration(s) : '';
      startTxt.value = it.start;
      paint();
    });
    b.addEventListener('input', () => {
      let e = Number(b.value);
      if (e < Number(a.value) + 1) { e = Math.min(dur, Number(a.value) + 1); b.value = e; }
      it.end = e < dur ? fmtDuration(e) : '';
      endTxt.value = it.end;
      paint();
    });
    startTxt.addEventListener('input', () => {
      it.start = startTxt.value;
      const n = parseClock(it.start);
      if (n === null) a.value = 0;
      else if (Number.isFinite(n)) a.value = clamp(Math.floor(n), 0, Number(b.value) - 1);
      paint();
    });
    endTxt.addEventListener('input', () => {
      it.end = endTxt.value;
      const n = parseClock(it.end);
      if (n === null) b.value = dur;
      else if (Number.isFinite(n) && n > 0) b.value = clamp(Math.floor(n), Number(a.value) + 1, dur);
      paint();
    });
    paint();
    const chapters = it.info.chapters || [];
    const chapterSel = chapters.length
      ? select([{ value: '', label: t('clip.chapter') }, ...chapters.map((c, i) => ({ value: String(i), label: `${fmtDuration(c.start)}  ${c.title}` }))], '',
        (v) => {
          const c = chapters[Number(v)];
          if (!c) return;
          it.start = c.start > 0 ? fmtDuration(c.start) : '';
          it.end = c.end < dur ? fmtDuration(c.end) : '';
          renderCard(it); // ползунок и поля перерисовываются по новым значениям
        }, locked)
      : null;
    return h('details', { class: 'clip', open: !!(it.start || it.end) || it.format === 'gif' },
      h('summary', { text: t('card.clip') }),
      chapterSel,
      track,
      h('div', { class: 'clip-row' }, startTxt, h('span', { text: '—' }), endTxt, len));
  }

  function buildCard(it) {
    const info = it.info;
    const site = siteOf(it.url);
    const loading = it.status === 'loading';
    const failedInfo = it.status === 'error' && it.phase === 'info';
    const locked = !isIdle(it);

    const thumb = h('div', { class: 'thumb' });
    if (info && info.thumbnail) {
      thumb.append(h('img', { src: info.thumbnail, alt: '', referrerPolicy: 'no-referrer', loading: 'lazy' }));
      if (info.duration) thumb.append(h('span', { class: 'dur', text: fmtDuration(info.duration) }));
    }

    const metaBits = [h('span', { class: 'site' }, h('i', { class: `dot s-${site.id}` }), site.name)];
    if (info && info.uploader) metaBits.push(h('span', { text: info.uploader }));
    if (info && info.kind === 'playlist' && info.count) metaBits.push(h('span', { text: t('card.files', { n: info.count }) }));
    if (info && info.kind === 'image') metaBits.push(h('span', { text: t('card.image') }));
    if (it.seen && it.status === 'ready') metaBits.push(h('span', { class: 'seen', text: t('card.seen') }));

    const title = displayTitle(it);
    const body = h('div', { class: 'body' },
      h('h3', { class: 'title', title, text: title }),
      h('div', { class: 'meta' }, metaBits));

    if (info) {
      let formatSel;
      let qualitySel;
      if (it.format === 'image') {
        formatSel = select([{ value: 'image', label: t('fmt.image') }], 'image', () => {}, true);
        qualitySel = select([{ value: 'original', label: t('q.original') }], 'original', () => {}, true);
      } else {
        // источник без видео (например, аудио с VK или SoundCloud): только звуковые форматы
        const formats = (info.audioOnly ? AUDIO_FORMATS : ALL_FORMATS).map((v) => ({ value: v, label: formatLabel(v) }));
        formatSel = select(
          formats,
          it.format,
          (v) => {
            // GIF по умолчанию берёт первые 10 секунд; при выходе из GIF этот автофрагмент снимаем
            if (it.format === 'gif' && v !== 'gif' && it.autoEnd && it.end === it.autoEnd) it.end = '';
            if (v !== 'gif') it.autoEnd = '';
            it.format = v;
            it.quality = pickQuality(v, info, settings[`${v}Quality`]);
            it.qualityAuto = true;
            if (v === 'gif' && !it.start && !it.end && info.duration) {
              it.autoEnd = fmtDuration(Math.min(10, Math.floor(info.duration)));
              it.end = it.autoEnd;
            }
            renderCard(it);
          },
          locked);
        qualitySel = select(qualityOptions(it.format, info), it.quality, (v) => { it.quality = v; it.qualityAuto = false; renderCard(it); }, locked);
      }
      body.append(h('div', { class: 'controls' }, formatSel, qualitySel));
      const qNote = qualityNote(it);
      if (qNote) body.append(h('div', { class: 'note', text: qNote }));
      if (it.format === 'gif') body.append(h('div', { class: 'note', text: t('card.gif_note') }));
      if (info.live) body.append(h('div', { class: 'note', text: t('card.live_note') }));
      // выбор языка звука (например, оригинал вместо автодубляжа) и субтитров
      const extra = [];
      if (it.format !== 'gif' && info.audioTracks && info.audioTracks.length) {
        extra.push(h('label', { class: 'mini-sel' }, h('span', { text: t('card.audio_lang') }),
          select([{ value: '', label: t('card.audio_default') }, ...info.audioTracks.map((a) => ({ value: a.lang, label: a.original ? `${a.lang} (${t('card.original')})` : a.lang }))],
            it.audioLang || '', (v) => { it.audioLang = v; }, locked)));
      }
      const hasSubs = info.subs && (info.subs.manual.length || info.subs.auto.length);
      if ((it.format === 'mp4' || it.format === 'webm') && hasSubs) {
        extra.push(h('label', { class: 'mini-sel' }, h('span', { text: t('card.subs') }),
          select([{ value: '', label: t('card.subs_default') }, { value: 'none', label: t('card.subs_none') },
            ...[...info.subs.manual, ...info.subs.auto].map((c) => ({ value: c, label: c }))],
            it.subLang || '', (v) => { it.subLang = v; }, locked)));
      }
      if (extra.length) body.append(h('div', { class: 'controls extra' }, extra));
      if (info.kind === 'video' && info.duration) {
        body.append(buildClip(it, locked));
      }
    }

    if (loading) body.append(h('div', { class: 'status', text: t('card.loading') }));
    if (failedInfo) body.append(h('div', { class: 'status', text: it.error }));
    if (it.status === 'error' && it.details) {
      body.append(h('details', { class: 'details' }, h('summary', { text: t('card.details') }), h('pre', { text: it.details })));
    }

    const showBar = loading || it.status === 'queued' || it.status === 'downloading' || it.status === 'done' || (it.status === 'error' && it.phase === 'download');
    if (showBar) {
      const fill = h('div', { class: 'tape-fill' });
      const tape = h('div', { class: `tape${loading ? ' indeterminate' : ''}` }, fill);
      if (!loading) fill.style.width = `${Math.round((it.status === 'error' ? 1 : it.percent || 0) * 100)}%`;
      body.append(tape);
      let text = '';
      if (it.status === 'queued') text = t('card.queued');
      else if (it.status === 'downloading') text = progressText(it);
      else if (it.status === 'done') text = it.entries > 1 ? t('card.done_many') : t('card.done');
      else if (it.status === 'error') text = it.error;
      if (!loading) body.append(h('div', { class: 'status', text }));
    }

    const actions = h('div', { class: 'actions' });
    const removeBtn = h('button', { class: 'btn ghost sm', type: 'button', text: t('btn.remove'), onclick: () => removeItem(it) });
    if (it.status === 'ready') {
      actions.append(h('button', { class: 'btn primary', type: 'button', text: t('btn.download'), disabled: !!it.info.live, onclick: () => startItem(it) }), removeBtn);
    } else if (it.status === 'queued' || it.status === 'downloading') {
      actions.append(h('button', { class: 'btn ghost', type: 'button', text: t('btn.cancel'), onclick: () => cancelItem(it) }));
    } else if (it.status === 'done') {
      actions.append(
        h('button', {
          class: 'btn primary', type: 'button', text: t('btn.show'),
          onclick: () => (it.filePath && it.entries <= 1 ? api.showItem(it.filePath) : api.openFolder(it.dir)),
        }),
        removeBtn);
    } else if (it.status === 'error') {
      if (it.needsLogin) actions.append(h('button', { class: 'btn primary', type: 'button', text: t('btn.login'), onclick: doLogin }));
      actions.append(
        h('button', {
          class: it.needsLogin ? 'btn ghost' : 'btn primary', type: 'button', text: t('btn.retry'),
          onclick: () => { it.needsLogin = false; if (it.phase === 'info') { infoWaiting.push(it); pumpInfo(); } else startItem(it); },
        }),
        removeBtn);
    } else {
      actions.append(removeBtn);
    }

    return h('article', { class: `card st-${it.status}`, dataset: { id: it.id } }, thumb, body, actions);
  }

  function renderCard(it) {
    const el = buildCard(it);
    if (it.status === 'done' && it.filePath && it.entries <= 1) makeDraggable(el, it.filePath);
    const old = cardEls.get(it.id);
    if (old) old.replaceWith(el);
    else $('#list').append(el);
    cardEls.set(it.id, el);
  }

  function refreshChrome() {
    const n = items.length;
    $('#count').textContent = n ? `(${n})` : '';
    $('#empty').hidden = n > 0;
    $('#startAllBtn').disabled = !items.some((i) => isIdle(i) && i.info && !i.info.live);
    $('#clearBtn').disabled = !items.some((i) => i.status === 'done');
    $('#cancelAllBtn').hidden = !items.some((i) => i.status === 'queued' || i.status === 'downloading');
    $('#retryErrBtn').hidden = !items.some((i) => i.status === 'error' && i.phase === 'download');
    refreshOverall();
    persistQueue();
  }

  // ---------- Язык, тема, боковая панель ----------
  function applyStatic() {
    document.documentElement.lang = settings.lang;
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
    if (!$('#overlay').hidden && !overlayFailed) {
      $('#overlayTitle').textContent = t('overlay.preparing');
      $('#overlayText').textContent = t('overlay.text');
    }
    updateVersionLabel();
    renderUpdateBar();
  }

  function applyTheme() {
    document.documentElement.dataset.theme = settings.theme === 'auto' ? '' : settings.theme;
  }

  function updateVersionLabel() {
    $('#verLabel').textContent = [appVersion ? `MediaGrab ${appVersion}` : '', ytVersion ? t('ver.label', { v: ytVersion }) : ''].filter(Boolean).join('\n');
  }

  let updatePercent = null; // идёт скачивание обновления программы
  function renderUpdateBar() {
    const bar = $('#updateBar');
    bar.hidden = !pendingUpdate && updatePercent == null;
    $('#updateInstallBtn').hidden = !pendingUpdate;
    if (pendingUpdate) $('#updateText').textContent = t('upd.text', { v: pendingUpdate });
    else if (updatePercent != null) $('#updateText').textContent = t('upd.downloading', { p: updatePercent });
  }

  function renderSettings() {
    for (const b of document.querySelectorAll('#formatSeg button')) b.classList.toggle('on', b.dataset.v === settings.format);
    const sel = $('#qualitySel');
    const current = settings[`${settings.format}Quality`];
    sel.replaceChildren(...qualityOptions(settings.format, null).map((o) => h('option', { value: o.value, text: o.label, selected: o.value === current })));
    $('#folderPath').textContent = settings.outDir || '…';
    $('#cookiesSel').value = settings.cookiesFile ? 'file' : settings.cookiesBrowser;
    const cf = $('#cookiesFile');
    cf.hidden = !settings.cookiesFile;
    cf.textContent = settings.cookiesFile;
    $('#proxyInput').value = settings.proxy;
    $('#nameSel').value = settings.nameTemplate;
    $('#limitSel').value = settings.limitRate;
    $('#coverChk').checked = !!settings.embedCover;
    $('#subsChk').checked = !!settings.subs;
    $('#subLangs').value = settings.subLangs;
    $('#notifyChk').checked = !!settings.notify;
    $('#watchChk').checked = !!settings.watchClipboard;
    $('#trayChk').checked = !!settings.closeToTray;
    $('#exactChk').checked = settings.exactCut === true;
    $('#parSel').value = String(maxParallel());
    $('#poChk').checked = settings.poToken === true;
    $('#logoutBtn').hidden = !settings.appCookies;
    $('#themeSel').value = settings.theme;
    $('#langSel').value = settings.lang;
  }

  /** Новые глобальные значения применяются ко всем ещё не запущенным ссылкам. */
  function applyDefaultsToIdle() {
    for (const it of items) {
      if (!isIdle(it) || !it.info || it.format === 'image' || it.info.audioOnly) continue;
      it.format = settings.format;
      it.quality = pickQuality(it.format, it.info, settings[`${it.format}Quality`]);
      it.qualityAuto = true;
      renderCard(it);
    }
  }

  for (const b of document.querySelectorAll('#formatSeg button')) {
    b.addEventListener('click', () => {
      settings.format = b.dataset.v;
      saveSettings();
      renderSettings();
      applyDefaultsToIdle();
    });
  }
  $('#qualitySel').addEventListener('change', (e) => {
    settings[`${settings.format}Quality`] = e.target.value;
    saveSettings();
    applyDefaultsToIdle();
  });
  $('#folderBtn').addEventListener('click', async () => {
    const dir = await api.pickFolder(settings.outDir);
    if (dir) { settings.outDir = dir; saveSettings(); renderSettings(); }
  });
  $('#cookiesSel').addEventListener('change', async (e) => {
    const v = e.target.value;
    if (v === 'file') {
      const file = await api.pickCookies();
      settings.cookiesFile = file || '';
      if (!file) settings.cookiesBrowser = '';
    } else {
      settings.cookiesFile = '';
      settings.cookiesBrowser = v;
    }
    saveSettings();
    renderSettings();
  });
  /** Вход в YouTube в окне приложения; после успеха заново пробуем ссылки, которые упёрлись в проверку «не бот». */
  let loginInProgress = false;
  async function doLogin() {
    if (loginInProgress) return;
    loginInProgress = true;
    try {
      const r = await api.login(settings.lang);
      if (r.ok) {
        // вход только сохраняется: приложение само подставит его, когда сайт потребует аккаунт
        settings.appCookies = r.file;
        saveSettings();
        renderSettings();
        toast(t('toast.login_ok'));
        for (const it of items) {
          if (it.status !== 'error' || !it.needsLogin) continue;
          it.needsLogin = false;
          if (it.phase === 'info') infoWaiting.push(it);
          else startItem(it);
        }
        pumpInfo();
      } else if (r.cancelled) {
        toast(t('toast.login_cancel'));
      } else if (r.error) {
        toast(r.error);
      }
    } finally {
      loginInProgress = false;
    }
  }
  $('#loginBtn').addEventListener('click', doLogin);
  $('#logoutBtn').addEventListener('click', async () => {
    await api.logout();
    settings.appCookies = '';
    saveSettings();
    renderSettings();
    toast(t('toast.logout_ok'));
  });
  const bindSetting = (sel, key, read) => $(sel).addEventListener('change', (e) => { settings[key] = read(e.target); saveSettings(); });
  bindSetting('#nameSel', 'nameTemplate', (el) => el.value);
  bindSetting('#limitSel', 'limitRate', (el) => el.value);
  bindSetting('#coverChk', 'embedCover', (el) => el.checked);
  bindSetting('#subsChk', 'subs', (el) => el.checked);
  bindSetting('#subLangs', 'subLangs', (el) => el.value.trim());
  bindSetting('#notifyChk', 'notify', (el) => el.checked);
  bindSetting('#watchChk', 'watchClipboard', (el) => el.checked);
  bindSetting('#exactChk', 'exactCut', (el) => el.checked);
  $('#parSel').addEventListener('change', (e) => { settings.parallel = Number(e.target.value); saveSettings(); pumpDownloads(); });
  $('#reportBtn').addEventListener('click', async () => {
    const r = await api.exportReport();
    if (r && r.ok) toast(t('toast.report_saved'));
    else if (r && r.error) toast(r.error);
  });
  $('#trayChk').addEventListener('change', async (e) => {
    settings.closeToTray = e.target.checked;
    saveSettings();
    if (api.setTray) {
      const ok = await api.setTray(settings.closeToTray);
      if (settings.closeToTray && !ok) { settings.closeToTray = false; saveSettings(); e.target.checked = false; toast(t('toast.tray_failed')); }
    }
  });

  // Эксперимент: токен подтверждения. Включение скачивает компоненты и запускает локальный сервер; при сбое флажок откатывается.
  $('#poChk').addEventListener('change', async (e) => {
    const box = e.target;
    if (!box.checked) {
      settings.poToken = false;
      saveSettings();
      api.disablePo();
      return;
    }
    box.disabled = true;
    $('#poStatus').textContent = t('adv.po_busy');
    let res;
    try { res = await api.enablePo(); } catch (err) { res = { ok: false, error: err.message || String(err) }; }
    box.disabled = false;
    $('#poStatus').textContent = '';
    settings.poToken = !!res.ok;
    box.checked = !!res.ok;
    saveSettings();
    toast(res.ok ? t('toast.po_on') : t('toast.po_failed', { e: res.error }));
  });
  $('#proxyInput').addEventListener('change', (e) => { settings.proxy = e.target.value.trim(); saveSettings(); });
  $('#themeSel').addEventListener('change', (e) => { settings.theme = e.target.value; saveSettings(); applyTheme(); });
  $('#langSel').addEventListener('change', async (e) => {
    settings.lang = e.target.value;
    saveSettings();
    await api.setLang(settings.lang);
    applyStatic();
    renderSettings();
    for (const it of items) renderCard(it);
    refreshChrome();
  });
  $('#updateBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = t('adv.updating');
    const r = await api.updateYtDlp();
    btn.disabled = false;
    btn.textContent = t('adv.update');
    if (r.ok) { ytVersion = r.version; updateVersionLabel(); toast(t('toast.updated')); }
    else toast(t('toast.update_failed', { e: r.error }));
  });
  $('#updateInstallBtn').addEventListener('click', () => api.installAppUpdate());
  api.onAppUpdate((ev) => {
    if (ev.state === 'downloading') { updatePercent = ev.percent; renderUpdateBar(); return; }
    updatePercent = null;
    pendingUpdate = ev.version || '·';
    renderUpdateBar();
  });
  $('#appUpdateBtn').addEventListener('click', async () => {
    const r = await api.checkAppUpdate();
    toast(t(`upd.check_${r.state}`, { e: r.error || '' }));
  });

  // ---------- Ввод ссылок ----------
  const input = $('#urlInput');
  const submitInput = () => { if (addUrls(input.value)) input.value = ''; };
  $('#addBtn').addEventListener('click', submitInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitInput(); }
  });
  input.addEventListener('paste', () => setTimeout(() => { if (/https?:\/\//.test(input.value)) submitInput(); }, 0));
  document.addEventListener('paste', (e) => {
    // в полях ввода (прокси, подписка…) и при открытых окнах вставка ссылки не должна уходить в очередь
    const tag = e.target && e.target.tagName;
    if (e.target === input || tag === 'INPUT' || tag === 'TEXTAREA' || document.querySelector('dialog[open]')) return;
    const text = e.clipboardData && e.clipboardData.getData('text');
    if (text && /https?:\/\//.test(text)) addUrls(text);
  });
  $('#pasteBtn').addEventListener('click', async () => {
    const text = await api.readClipboard();
    if (text) addUrls(text);
    else toast(t('toast.empty_clip'));
  });
  let dragDepth = 0;
  const dragHasPayload = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].some((x) => x === 'Files' || x === 'text/uri-list' || x === 'text/plain');
  document.addEventListener('dragenter', (e) => { if (dragHasPayload(e)) { dragDepth += 1; $('#dropHint').hidden = false; } });
  document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropHint').hidden = true; });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#dropHint').hidden = true;
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])].filter((f) => /\.(txt|url|md)$/i.test(f.name) && f.size < 512 * 1024);
    if (files.length) {
      // список ссылок в текстовом файле
      const texts = await Promise.all(files.map((f) => f.text().catch(() => '')));
      addUrls(texts.join('\n'));
      return;
    }
    const text = e.dataTransfer && (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text'));
    if (text) addUrls(text);
  });

  // Подхват ссылок из буфера при возвращении в окно (только ссылки на поддерживаемые сайты).
  let lastClip = '';
  window.addEventListener('focus', async () => {
    if (!settings.watchClipboard) return;
    let text = '';
    try { text = (await api.readClipboard()) || ''; } catch { return; }
    if (!text || text === lastClip) return;
    lastClip = text;
    const urls = (text.match(/https?:\/\/[^\s<>"']+/g) || []).filter((u) => siteOf(u).id !== 'other');
    if (urls.length) addUrls(urls.join('\n'));
  });

  $('#startAllBtn').addEventListener('click', () => { for (const it of items) startItem(it); });

  // ---------- Горячие клавиши ----------
  // Ctrl+V (вставка ссылки) обрабатывается событием paste выше.
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || document.querySelector('dialog[open]')) return;
    const key = e.key.toLowerCase();
    if (key === 'enter') {
      e.preventDefault();
      if (input.value.trim()) submitInput();
      else for (const it of items) startItem(it);
    } else if (key === 'h') {
      e.preventDefault();
      renderHistory();
      $('#history').showModal();
    } else if (key === 'l') {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
  $('#cancelAllBtn').addEventListener('click', () => { for (const it of [...items]) if (it.status === 'queued' || it.status === 'downloading') cancelItem(it); });
  $('#retryErrBtn').addEventListener('click', () => { for (const it of items) if (it.status === 'error' && it.phase === 'download') startItem(it); });
  $('#clearBtn').addEventListener('click', () => { for (const it of items.filter((i) => i.status === 'done')) removeItem(it); });

  // ---------- Запуск ----------
  const overlay = $('#overlay');
  let overlayFailed = false;
  api.onStatus(({ text, percent }) => {
    $('#overlayTitle').textContent = text;
    const bar = $('#overlayBar');
    bar.parentElement.classList.toggle('indeterminate', percent == null);
    bar.style.width = percent == null ? '' : `${Math.round(percent * 100)}%`;
  });

  async function boot() {
    overlayFailed = false;
    overlay.hidden = false;
    $('#retryBtn').hidden = true;
    $('#overlayProxyBox').hidden = true;
    $('#overlayBar').parentElement.hidden = false;
    $('#overlayTitle').textContent = t('overlay.preparing');
    $('#overlayText').textContent = t('overlay.text');
    $('#overlayBar').classList.add('moving');
    await api.setLang(settings.lang);
    const res = await api.init({ proxy: settings.proxy });
    if (!res.ok) {
      overlayFailed = true;
      $('#overlayTitle').textContent = t('overlay.failed');
      $('#overlayText').textContent = res.error;
      $('#overlayBar').parentElement.hidden = true;
      $('#retryBtn').hidden = false;
      $('#overlayProxyBox').hidden = false;
      $('#overlayProxy').value = settings.proxy || '';
      return;
    }
    if (!settings.outDir) { settings.outDir = res.downloadsDir; saveSettings(); }
    // состояние входа берём из главного процесса: файл мог быть удалён или повреждён
    settings.appCookies = res.loggedIn ? 'saved' : '';
    ytVersion = res.version || '';
    appVersion = res.appVersion || '';
    updateVersionLabel();
    renderSettings();
    overlay.hidden = true;
    input.focus();
    restoreQueue();
    queueReady = true;
    persistQueue();
    setTimeout(() => checkSubs(false), 20_000);
    if (settings.closeToTray && api.setTray) api.setTray(true).then((ok) => { if (!ok) { settings.closeToTray = false; saveSettings(); renderSettings(); } }).catch(() => {});
    if (settings.poToken) {
      // эксперимент включён: в фоне проверяем компоненты и запускаем сервер токенов
      api.enablePo().then((p) => {
        if (p.ok) return;
        settings.poToken = false;
        saveSettings();
        renderSettings();
        toast(t('toast.po_failed', { e: p.error }));
      }).catch(() => {});
    }
  }
  $('#retryBtn').addEventListener('click', () => {
    // прокси, указанный на экране ошибки, сохраняется в настройках
    if (!$('#overlayProxyBox').hidden) { settings.proxy = $('#overlayProxy').value.trim(); saveSettings(); renderSettings(); }
    boot();
  });

  applyTheme();
  applyStatic();
  renderSettings();
  refreshChrome();
  boot();
})();
