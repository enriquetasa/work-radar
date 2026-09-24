'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const log = require('./logger');
const { resolveSyncConfig } = require('./sync/config');
const { createSessionStorage } = require('./sync/session-storage');
const { createAuthClient } = require('./sync/auth-client');
const { createAuthService } = require('./sync/auth-service');
const { waitForCallback, REDIRECT_TO } = require('./sync/callback-server');
const { isValidEmail } = require('./sync/validate');
const { validatePublishableKey } = require('./sync/key-validation');
const { saveSyncConfigKey } = require('./sync/sync-config-store');
const { createSaveKeyHandler } = require('./sync/save-key-handler');
const { disposeFailedAuthAttempt } = require('./sync/dispose-auth-attempt');
const { createSyncEngine } = require('./sync/sync-engine');
const { createRealtimeSync } = require('./sync/realtime');
const { createSyncLifecycle } = require('./sync/sync-lifecycle');
const { readJsonFile, writeJsonFileAtomic } = require('./sync/atomic-json-file');

// Keep the data directory stable if the Electron product name changes.
app.setPath('userData', path.join(app.getPath('appData'), 'work-radar'));
log.info('userData path resolved', { userData: app.getPath('userData') });

const DATA_FILE = () => path.join(app.getPath('userData'), 'work-radar-data.json');
const SYNC_STATE_FILE = () => path.join(app.getPath('userData'), 'sync-state.json');
const BACKUP_DIR = () => path.join(app.getPath('userData'), 'backups');
const WINSTATE = () => path.join(app.getPath('userData'), 'window-state.json');
const ICON_PNG = path.join(__dirname, 'build', 'icon.png');
const MAX_BACKUPS = 30;

let win = null;
let authService = null;
let syncEngine = null;
let syncLifecycle = null;

const readJSON = (file) => readJsonFile(file, { log });
const atomicWrite = (file, data) => writeJsonFileAtomic(file, data, { log });

// Backups are best-effort and must never block startup.
async function dailyBackup() {
  if (!fs.existsSync(DATA_FILE())) return;
  try {
    await fsp.mkdir(BACKUP_DIR(), { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const target = path.join(BACKUP_DIR(), `work-radar-${stamp}.json`);
    if (!fs.existsSync(target)) {
      await fsp.copyFile(DATA_FILE(), target);
      log.info('daily backup written', { target });
    }
    const files = (await fsp.readdir(BACKUP_DIR()))
      .filter((f) => f.startsWith('work-radar-') && f.endsWith('.json'))
      .sort();
    while (files.length > MAX_BACKUPS) {
      const f = files.shift();
      await fsp.unlink(path.join(BACKUP_DIR(), f));
      log.debug('pruned old backup', { file: f });
    }
  } catch (err) {
    log.error('daily backup failed', { err });
  }
}

async function loadWinState() {
  const s = await readJSON(WINSTATE());
  return s && s.width ? s : { width: 1100, height: 720 };
}
async function saveWinState() {
  if (!win || win.isDestroyed()) return;
  try {
    await atomicWrite(WINSTATE(), win.getBounds());
  } catch (err) {
    log.warn('failed to persist window state', { err });
  }
}

ipcMain.handle('data:load', () => readJSON(DATA_FILE()));

ipcMain.handle('data:save', async (_e, data) => {
  if (!data || typeof data !== 'object') {
    log.warn('rejected save with invalid payload', { type: typeof data });
    return { ok: false, error: 'invalid payload' };
  }
  try {
    // The engine serializes saves with any pull already in flight.
    if (syncEngine) {
      await syncEngine.recordLocalSave(data);
    } else {
      await atomicWrite(DATA_FILE(), data);
    }
    return { ok: true };
  } catch (err) {
    log.error('failed to save data file', { file: DATA_FILE(), err });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('data:export', async (_e, data) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Work Radar backup',
    defaultPath: `work-radar-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false };
  try {
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    log.info('exported backup', { path: filePath });
    return { ok: true, path: filePath };
  } catch (err) {
    log.error('failed to export backup', { path: filePath, err });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('data:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import Work Radar backup',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePaths[0]) return null;
  return readJSON(filePaths[0]);
});

ipcMain.handle('data:exportPDF', async (_e, html) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export PDF Report',
    defaultPath: `work-radar-report-${new Date().toISOString().slice(0, 10)}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { ok: false };
  const tmpPath = path.join(app.getPath('temp'), `wr-report-${Date.now()}.html`);
  const pw = new BrowserWindow({ show: false });
  try {
    await fsp.writeFile(tmpPath, html, 'utf8');
    await pw.loadFile(tmpPath);
    const pdfBuffer = await pw.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: false,
      margins: { marginType: 'default' },
    });
    await fsp.writeFile(filePath, pdfBuffer);
    log.info('exported PDF report', { path: filePath });
    return { ok: true, path: filePath };
  } catch (err) {
    log.error('PDF export failed', { err });
    return { ok: false, error: err.message };
  } finally {
    pw.close();
    await fsp.unlink(tmpPath).catch(() => {});
  }
});

ipcMain.handle('data:revealBackups', async () => {
  try {
    await fsp.mkdir(BACKUP_DIR(), { recursive: true });
    await shell.openPath(BACKUP_DIR());
    return { ok: true };
  } catch (err) {
    log.error('failed to reveal backups folder', { dir: BACKUP_DIR(), err });
    return { ok: false, error: err.message };
  }
});

const SESSION_FILE = () => path.join(app.getPath('userData'), 'sync-session.enc');

function buildAuthService() {
  const syncConfig = resolveSyncConfig({ userDataDir: app.getPath('userData') });
  if (!syncConfig.configured) {
    log.debug('sync not configured — auth disabled');
    return null;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    log.error(
      'sync is configured but this system has no secret store for safeStorage — auth disabled'
    );
    return null;
  }
  // Linux can report encryption support while using an obfuscation-only backend.
  if (
    process.platform === 'linux' &&
    typeof safeStorage.getSelectedStorageBackend === 'function' &&
    safeStorage.getSelectedStorageBackend() === 'basic_text'
  ) {
    log.warn(
      'safeStorage is using the basic_text backend (no OS keyring/D-Bus secret service) — ' +
        'the persisted session is obfuscated, not meaningfully encrypted, on this system'
    );
  }
  try {
    const storage = createSessionStorage({
      filePath: SESSION_FILE(),
      encrypt: (buf) => safeStorage.encryptString(buf.toString('utf8')),
      decrypt: (buf) => Buffer.from(safeStorage.decryptString(buf), 'utf8'),
    });
    const client = createAuthClient({
      url: syncConfig.url,
      publishableKey: syncConfig.publishableKey,
      storage,
    });
    const service = createAuthService({ client, waitForCallback, redirectTo: REDIRECT_TO });
    log.info('sync configured', { source: syncConfig.source });
    return { service, client };
  } catch (err) {
    log.error('failed to build auth service — auth disabled', { err });
    return null;
  }
}

function buildSyncEngine(client) {
  return createSyncEngine({
    client,
    dataFilePath: DATA_FILE(),
    syncStateFilePath: SYNC_STATE_FILE(),
    onStatus: (status) => {
      if (win) win.webContents.send('sync:stateChanged', { state: status });
    },
    onReload: () => {
      if (win) win.webContents.send('sync:reload');
    },
  });
}

function buildRealtimeSync(client, engine) {
  return createRealtimeSync({ client, onChange: () => engine.triggerNow() });
}

function initSyncAndAuth() {
  if (authService) return false;
  const built = buildAuthService();
  if (!built) return false;
  // Publish module state only after every collaborator has been built.
  try {
    const engine = buildSyncEngine(built.client);
    const realtime = buildRealtimeSync(built.client, engine);
    const lifecycle = createSyncLifecycle({ engine, realtime });
    built.service.onChange((status) => {
      if (win) win.webContents.send('auth:stateChanged', status);
      const wasRunning = lifecycle.isRunning();
      lifecycle.handleAuthStatus(status);
      if (wasRunning && !lifecycle.isRunning()) {
        if (win) win.webContents.send('sync:stateChanged', { state: null });
      }
    });
    authService = built.service;
    syncEngine = engine;
    syncLifecycle = lifecycle;
    return true;
  } catch (err) {
    // Avoid leaving a second auth client refreshing the same session.
    disposeFailedAuthAttempt({ service: built.service, client: built.client });
    throw err;
  }
}

// The renderer requests an initial snapshot in case it missed an early status event.
ipcMain.handle('sync:status', async () => {
  return syncLifecycle && syncLifecycle.isRunning() ? syncEngine.getStatus() : null;
});

ipcMain.handle('auth:status', async () => {
  if (!authService) return { configured: false };
  const status = await authService.getStatus();
  return { configured: true, ...status };
});

ipcMain.handle('auth:signIn', async (_e, email) => {
  if (!authService) return { ok: false, error: 'sync is not configured' };
  if (!isValidEmail(email)) {
    log.warn('rejected sign-in request with invalid email', { type: typeof email });
    return { ok: false, error: 'enter a valid email address' };
  }
  try {
    await authService.signIn(email.trim());
    return { ok: true };
  } catch (err) {
    log.error('sign-in failed', { err });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('auth:signOut', async () => {
  if (!authService) return { ok: false, error: 'sync is not configured' };
  try {
    await authService.signOut();
    return { ok: true };
  } catch (err) {
    log.error('sign-out failed', { err });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('syncConfig:needsKey', async () => {
  const syncConfig = resolveSyncConfig({ userDataDir: app.getPath('userData') });
  return !syncConfig.configured;
});

const saveKeyHandler = createSaveKeyHandler({
  validateKey: validatePublishableKey,
  isAlreadyConfigured: () => !!authService,
  saveKey: (key) =>
    saveSyncConfigKey({ userDataDir: app.getPath('userData'), publishableKey: key }),
  initSyncAndAuth: () => {
    const started = initSyncAndAuth();
    if (started) buildMenu();
    return started;
  },
});

ipcMain.handle('syncConfig:saveKey', async (_e, rawKey) => saveKeyHandler.handleSaveKey(rawKey));

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (action) => () => {
    if (win) win.webContents.send('menu', action);
  };
  const signOut = () => {
    authService.signOut().catch((err) => log.error('menu sign-out failed', { err }));
  };

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'Radar',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: 'Search', accelerator: 'CmdOrCtrl+F', click: send('search') },
        { type: 'separator' },
        { label: 'Export JSON Backup…', accelerator: 'CmdOrCtrl+E', click: send('export') },
        { label: 'Export PDF Report…', accelerator: 'CmdOrCtrl+Shift+E', click: send('exportPDF') },
        { label: 'Import Backup…', accelerator: 'CmdOrCtrl+I', click: send('import') },
        { label: 'Reveal Auto-Backups', click: send('reveal') },
        ...(authService ? [{ type: 'separator' }, { label: 'Sign Out', click: signOut }] : []),
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  const state = await loadWinState();
  win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 480,
    minHeight: 420,
    backgroundColor: '#010805',
    title: 'Work Radar',
    ...(fs.existsSync(ICON_PNG) ? { icon: ICON_PNG } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // renderer cannot touch Node directly
      nodeIntegration: false, // no Node in the renderer
      sandbox: true, // renderer runs sandboxed
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  let saveTimer = null;
  const queueSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWinState, 400);
  };
  win.on('resize', queueSave);
  win.on('move', queueSave);
  win.on('close', saveWinState);
  win.on('closed', () => {
    win = null;
  });
  win.on('focus', () => {
    if (syncLifecycle && syncLifecycle.isRunning()) {
      syncEngine.triggerNow().catch((err) => log.error('sync focus trigger failed', { err }));
    }
  });
  log.info('window created', { width: state.width, height: state.height });
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock && fs.existsSync(ICON_PNG)) {
    app.dock.setIcon(ICON_PNG);
  }

  await dailyBackup();
  try {
    initSyncAndAuth();
  } catch (err) {
    log.error('initSyncAndAuth failed at startup — continuing fully local', { err });
  }
  buildMenu();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
