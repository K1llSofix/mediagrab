'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snifferApi', {
  onState: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('sniffer:state', handler);
    return () => ipcRenderer.removeListener('sniffer:state', handler);
  },
  ready: () => ipcRenderer.send('sniffer:action', { type: 'ready' }),
  pick: (id) => ipcRenderer.send('sniffer:action', { type: 'pick', id }),
  clear: () => ipcRenderer.send('sniffer:action', { type: 'clear' }),
  back: () => ipcRenderer.send('sniffer:action', { type: 'back' }),
  reload: () => ipcRenderer.send('sniffer:action', { type: 'reload' }),
  cancel: () => ipcRenderer.send('sniffer:action', { type: 'cancel' }),
});
