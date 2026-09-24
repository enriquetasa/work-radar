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

  // Sync/auth (see docs/supabase-sync-plan.md → "Sign-in flow"). Always
  // present — main.js's handlers report { configured: false } when sync
  // isn't set up, and the renderer hides all sign-in UI in that case.
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authSignIn: (email) => ipcRenderer.invoke('auth:signIn', email),
  authSignOut: () => ipcRenderer.invoke('auth:signOut'),
  onAuthStateChanged: (cb) => ipcRenderer.on('auth:stateChanged', (_e, status) => cb(status)),

  // Sync engine (Phases 4-5, see docs/supabase-sync-plan.md). Mostly
  // push-only from main, but syncStatus() lets the renderer ask for the
  // current status once on load/reload — the push alone can otherwise
  // reach nobody (main can push before the renderer has registered its
  // listener) and leave the indicator stuck hidden for the whole session.
  syncStatus: () => ipcRenderer.invoke('sync:status'),
  onSyncStateChanged: (cb) => ipcRenderer.on('sync:stateChanged', (_e, status) => cb(status)),
  // Told to reload after main has merged in a pull — the renderer's own
  // Store is not the source of truth for that merge, the data file is.
  onSyncReload: (cb) => ipcRenderer.on('sync:reload', () => cb()),
});
