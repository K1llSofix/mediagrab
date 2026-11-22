'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel) => (cb) => {
  const handler = (_event, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  enablePo: () => ipcRenderer.invoke('po:enable'),
  disablePo: () => ipcRenderer.invoke('po:disable'),
  notify: (title, body) => ipcRenderer.invoke('app:notify', { title, body }),
  armAfter: (kind) => ipcRenderer.invoke('app:afterArm', kind),
  disarmAfter: () => ipcRenderer.invoke('app:afterDisarm'),
  afterAction: (kind) => ipcRenderer.invoke('app:after', kind),
  checkAppUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  exportReport: () => ipcRenderer.invoke('log:export'),
  setTray: (on) => ipcRenderer.invoke('app:setTray', !!on),
  startDrag: (file) => ipcRenderer.send('drag:start', file),
  setProgress: (fraction) => ipcRenderer.invoke('app:progress', fraction),
  setLang: (lang) => ipcRenderer.invoke('app:setLang', lang),
  init: (opts) => ipcRenderer.invoke('app:init', opts),
  updateYtDlp: () => ipcRenderer.invoke('ytdlp:update'),
  login: (lang) => ipcRenderer.invoke('auth:login', lang),
  logout: () => ipcRenderer.invoke('auth:logout'),
  installAppUpdate: () => ipcRenderer.invoke('app:installUpdate'),
  fetchInfo: (payload) => ipcRenderer.invoke('info:fetch', payload),
  startJob: (job) => ipcRenderer.invoke('job:start', job),
  cancel: (id) => ipcRenderer.invoke('job:cancel', id),
  pickFolder: (current) => ipcRenderer.invoke('dialog:folder', current),
  pickCookies: () => ipcRenderer.invoke('dialog:cookies'),
  showItem: (filePath) => ipcRenderer.invoke('shell:show', filePath),
  openFolder: (dir) => ipcRenderer.invoke('shell:open', dir),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  onJobEvent: subscribe('job:event'),
  onStatus: subscribe('app:status'),
  onAppUpdate: subscribe('app:update'),
});
