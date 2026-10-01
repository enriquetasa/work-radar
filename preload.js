'use strict';

const { contextBridge, ipcRenderer } = require('electron');

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

  authStatus: () => ipcRenderer.invoke('auth:status'),
  authSignIn: (email) => ipcRenderer.invoke('auth:signIn', email),
  authSignOut: () => ipcRenderer.invoke('auth:signOut'),
  onAuthStateChanged: (cb) => ipcRenderer.on('auth:stateChanged', (_e, status) => cb(status)),

  syncConfigNeedsKey: () => ipcRenderer.invoke('syncConfig:needsKey'),
  syncConfigSaveKey: (key) => ipcRenderer.invoke('syncConfig:saveKey', key),

  syncStatus: () => ipcRenderer.invoke('sync:status'),
  onSyncStateChanged: (cb) => ipcRenderer.on('sync:stateChanged', (_e, status) => cb(status)),
  onSyncReload: (cb) => ipcRenderer.on('sync:reload', () => cb()),
});
