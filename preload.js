'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The ONLY surface the renderer can see. No Node, no ipcRenderer directly.
contextBridge.exposeInMainWorld('radarAPI', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (data) => ipcRenderer.invoke('data:save', data),
  export: (data) => ipcRenderer.invoke('data:export', data),
  exportPDF: (html) => ipcRenderer.invoke('data:exportPDF', html),
  import: () => ipcRenderer.invoke('data:import'),
  revealBackups: () => ipcRenderer.invoke('data:revealBackups'),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
});
