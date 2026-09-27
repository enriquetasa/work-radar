'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The ONLY surface the renderer can see. No Node, no ipcRenderer directly.
contextBridge.exposeInMainWorld('radarAPI', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (data) => ipcRenderer.invoke('data:save', data),
  export: (data) => ipcRenderer.invoke('data:export', data),
  exportPDF: (html) => ipcRenderer.invoke('data:exportPDF', html),
  exportFull: (data) => ipcRenderer.invoke('data:exportFull', data),
  import: () => ipcRenderer.invoke('data:import'),
  importFull: () => ipcRenderer.invoke('data:importFull'),
  revealBackups: () => ipcRenderer.invoke('data:revealBackups'),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),

  onboardingGet: () => ipcRenderer.invoke('onboarding:get'),
  onboardingUpdate: (patch) => ipcRenderer.invoke('onboarding:update', patch),
  onboardingChooseLocal: () => ipcRenderer.invoke('onboarding:chooseLocal'),
  onboardingMarkSignedIn: () => ipcRenderer.invoke('onboarding:markSignedIn'),
  briefingPreferences: () => ipcRenderer.invoke('briefing:preferences'),
  briefingSetPreferences: (preferences) =>
    ipcRenderer.invoke('briefing:setPreferences', preferences),
  briefingPreview: (payload) => ipcRenderer.invoke('briefing:preview', payload),
  briefingTest: () => ipcRenderer.invoke('briefing:test'),
  profileStatus: () => ipcRenderer.invoke('profile:status'),
  profileAssociate: () => ipcRenderer.invoke('profile:associate'),
  profileUseSeparate: () => ipcRenderer.invoke('profile:useSeparate'),
  attachmentsPickAdd: (itemId) => ipcRenderer.invoke('attachments:pickAdd', itemId),
  attachmentsList: (itemId) => ipcRenderer.invoke('attachments:list', itemId),
  attachmentsRemove: (id) => ipcRenderer.invoke('attachments:remove', id),
  attachmentsRemoveForItem: (itemId) => ipcRenderer.invoke('attachments:removeForItem', itemId),
  attachmentsOpen: (id) => ipcRenderer.invoke('attachments:open', id),
  attachmentsProcessQueue: () => ipcRenderer.invoke('attachments:processQueue'),
  attachmentsRefresh: () => ipcRenderer.invoke('attachments:refresh'),

  // Sync/auth (see docs/supabase-sync-plan.md → "Sign-in flow"). Always
  // present — main.js's handlers report { configured: false } when sync
  // isn't set up, and the renderer hides all sign-in UI in that case.
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authSignIn: (email) => ipcRenderer.invoke('auth:signIn', email),
  authSignOut: () => ipcRenderer.invoke('auth:signOut'),
  onAuthStateChanged: (cb) => ipcRenderer.on('auth:stateChanged', (_e, status) => cb(status)),

  // Startup "add your key" prompt (see docs/supabase-sync-plan.md's notes
  // on the built-in default project URL + first-run publishable-key
  // prompt). needsKey() reports whether main found no publishable key at
  // startup from any source — always false when env vars fully configure
  // sync. saveKey() is the only way the renderer can ever write to
  // sync-config.json: the key is validated in main (sync/key-validation.js)
  // before anything is written or a service built, and main never sends
  // the key itself back to the renderer.
  syncConfigNeedsKey: () => ipcRenderer.invoke('syncConfig:needsKey'),
  syncConfigSaveKey: (key) => ipcRenderer.invoke('syncConfig:saveKey', key),

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
