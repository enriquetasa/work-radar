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
const { createSyncEngine } = require('./sync/sync-engine');
const { createRealtimeSync } = require('./sync/realtime');
const { createSyncLifecycle } = require('./sync/sync-lifecycle');

// Pins the userData folder explicitly. This already matches Electron's own
// default in both a plain `electron .` dev run and a packaged build (
// electron-builder 26 keeps `name: "work-radar"` in the packaged app's own
// package.json, with no top-level `productName` — the `build` block is
// stripped), so this is a no-op today — but setting it explicitly means a
// future top-level `productName` (or any other change to how Electron
// derives app.name) can never silently move users' data to a different
// folder.
app.setPath('userData', path.join(app.getPath('appData'), 'work-radar'));
log.info('userData path resolved', { userData: app.getPath('userData') });

const DATA_FILE = () => path.join(app.getPath('userData'), 'work-radar-data.json');
const SYNC_STATE_FILE = () => path.join(app.getPath('userData'), 'sync-state.json');
const BACKUP_DIR = () => path.join(app.getPath('userData'), 'backups');
const WINSTATE = () => path.join(app.getPath('userData'), 'window-state.json');
const ICON_PNG = path.join(__dirname, 'build', 'icon.png');
const MAX_BACKUPS = 30;

let win = null;
// Set during startup if (and only if) sync is configured AND the
// platform's secret store (Electron safeStorage) is actually available —
// see buildAuthService() below. Every auth IPC handler treats a null
// authService as "sync disabled", which is exactly how the app behaved
// before Phase 3 (see docs/supabase-sync-plan.md).
let authService = null;
// The sync engine (Phases 4-5 — push/pull/merge, see sync/sync-engine.js).
// Built once alongside authService, sharing its supabase-js client, but
// only ever start()ed while a session is actually signed in — see
// authService.onChange() below. data:save (below) routes through the
// engine's save-race-safe recordLocalSave whenever `syncEngine` exists at
// all, not only while it's actively running — the merge needs no signed-in
// user, only recordLocalSave's own outbox bookkeeping does, and that
// already degrades gracefully without one. `syncLifecycle.isRunning()` is
// read directly (no separate module-level flag — found in review: two
// copies of "is sync running" can silently drift) to gate calls that
// really do need the engine to be actively cycling (triggerNow() on
// focus, sync:status).
let syncEngine = null;
// Realtime sync trigger (Phase 6 — see sync/realtime.js and
// docs/supabase-sync-plan.md's Phase 6 notes). Built once alongside
// syncEngine, sharing the same client, but only ever subscribe()d while
// signed in, on the same transition that starts the sync engine — see
// syncLifecycle below.
let realtimeSync = null;
// Owns the "start/stop the engine, subscribe/unsubscribe realtime" auth-
// status transition logic (see sync/sync-lifecycle.js) — extracted out
// of this file (found in review) so it's unit-testable without
// Electron. Built once alongside syncEngine/realtimeSync.
let syncLifecycle = null;

/* ---------- JSON helpers ---------- */
async function readJSON(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    // A missing file is the normal first-run case; anything else is a real
    // problem worth surfacing (corrupt JSON, permissions, etc.).
    if (err.code === 'ENOENT') {
      log.debug('file not found, treating as empty', { file });
    } else {
      log.warn('failed to read JSON file', { file, err });
    }
    return null;
  }
}

// Write to a temp file then rename — rename is atomic, so a crash mid-write
// can never leave a half-written (corrupt) data file.
async function atomicWrite(file, obj) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

// One snapshot per calendar day, pruned to the last MAX_BACKUPS. Cheap, and
// gives a rolling history independent of the user's manual exports.
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
    // Backups are best-effort — log loudly but never block startup.
    log.error('daily backup failed', { err });
  }
}

/* ---------- Window state persistence ---------- */
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

/* ---------- IPC: all disk IO lives in the main process ---------- */
ipcMain.handle('data:load', async () => await readJSON(DATA_FILE()));

ipcMain.handle('data:save', async (_e, data) => {
  if (!data || typeof data !== 'object') {
    log.warn('rejected save with invalid payload', { type: typeof data });
    return { ok: false, error: 'invalid payload' };
  }
  try {
    if (syncEngine) {
      // recordLocalSave merges this payload with what's currently on
      // disk instead of overwriting it outright — see
      // docs/supabase-sync-plan.md's Phase 4-5 notes ("the save race") for
      // why: a save the renderer queued just before a background pull
      // wrote in a remote change must not stomp on that change. It also
      // does this phase's outbox diffing (never trusts the renderer to
      // report what changed) and schedules a debounced push.
      //
      // Gated on `syncEngine` existing at all, not on whether it's
      // running (found in review): the merge itself needs no signed-in
      // user —
      // only recordLocalSave's own outbox bookkeeping does, and that
      // already skips gracefully when there isn't one — so routing
      // through it whenever the engine exists keeps every write to this
      // file behind the same mutex even right at sign-out, when a pull
      // merge started just before stop() ran can still be finishing its
      // own write. Falling back to a bare atomicWrite in that narrow
      // window would let it race a plain save and silently drop one.
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
  return await readJSON(filePaths[0]);
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

/* ---------- Sync/auth (see docs/supabase-sync-plan.md → "Sign-in flow") ---------- */
const SESSION_FILE = () => path.join(app.getPath('userData'), 'sync-session.enc');

// Builds the auth service (and returns the supabase-js client it uses,
// so the sync engine below can share the same authenticated client
// rather than creating a second one), or returns null if sync isn't
// usable — either because it's not configured at all (no env vars /
// sync-config.json), or because this OS has no secret store for
// Electron's safeStorage to use. Never throws: any failure here just
// means the app runs fully local, as it always did.
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
  // On Linux, isEncryptionAvailable() can still be true with the
  // 'basic_text' backend (no keyring/D-Bus secret service), which uses a
  // hardcoded key rather than one backed by the OS — the session file is
  // then not meaningfully encrypted at rest. Auth still works (this is
  // strictly better than the alternative of refusing to persist a session
  // at all), but it's worth a loud warning rather than a silent downgrade.
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

// Builds the sync engine (Phases 4-5), sharing the auth service's own
// supabase-js client. Never started here — only main.js's authService
// .onChange handler below start()s/stop()s it, so pushes/pulls only run
// while signed in (see docs/supabase-sync-plan.md's "Local-first" note).
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

// Builds the realtime sync trigger (Phase 6), sharing the same
// supabase-js client as auth/sync rather than opening a second
// connection — this is also what keeps the realtime socket authorized
// across token refreshes, since the client's own
// auth.onAuthStateChange -> realtime.setAuth wiring runs regardless of
// who else is using the client (see sync/realtime.js's own doc
// comment). `onChange` is wired straight to the sync engine's existing
// coalescing trigger — a realtime event never merges its own payload,
// it just means "pull now", the same as the 60s interval or a window
// focus.
function buildRealtimeSync(client, engine) {
  return createRealtimeSync({ client, onChange: () => engine.triggerNow() });
}

// Builds and wires up authService/syncEngine/realtimeSync/syncLifecycle —
// shared between normal startup (app.whenReady() below) and the
// in-process "a key was just saved via the startup prompt" flow (see
// syncConfig:saveKey below), so both go through exactly one code path
// rather than two copies that could drift. Idempotent: a second call
// while authService is already set is a no-op (returns false) — there's
// nothing left to build, and buildAuthService() would just repeat the
// same work for nothing. Returns whether it actually (re)built anything.
function initSyncAndAuth() {
  if (authService) return false;
  const built = buildAuthService();
  if (!built) return false;
  authService = built.service;
  syncEngine = buildSyncEngine(built.client);
  realtimeSync = buildRealtimeSync(built.client, syncEngine);
  syncLifecycle = createSyncLifecycle({ engine: syncEngine, realtime: realtimeSync });
  authService.onChange((status) => {
    if (win) win.webContents.send('auth:stateChanged', status);
    // All the start/stop/subscribe/unsubscribe transition logic lives
    // in sync/sync-lifecycle.js (see its own doc comment for the
    // subscribe-after-sign-out race this closes).
    const wasRunning = syncLifecycle.isRunning();
    syncLifecycle.handleAuthStatus(status);
    if (wasRunning && !syncLifecycle.isRunning()) {
      // Hide the status indicator on sign-out — a signed-out state
      // shows no sync UI at all, per the plan.
      if (win) win.webContents.send('sync:stateChanged', { state: null });
    }
  });
  return true;
}

ipcMain.handle('sync:status', async () => {
  // The only way the renderer can learn the current sync status other
  // than waiting for the next 'sync:stateChanged' push — needed because
  // that push can otherwise go nowhere: main.js starts the engine (from
  // authService.onChange, which can fire before createWindow()/`win` is
  // set) before the renderer has registered its listener, and setStatus
  // dedupes identical statuses, so a "synced" pushed once before anyone
  // was listening then never gets pushed again. Sync.init() calls this
  // once on load/reload, the same way Auth.init() calls authStatus().
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

/* ---------- Startup "add your key" prompt ----------
   Shown by the renderer only when this reports true — which folds in
   the "env vars fully configure it" case for free, since
   resolveSyncConfig() only reports `configured: false` when no key was
   found from any source (see sync/config.js's own doc comment). */
ipcMain.handle('syncConfig:needsKey', async () => {
  const syncConfig = resolveSyncConfig({ userDataDir: app.getPath('userData') });
  return !syncConfig.configured;
});

// The validate -> skip-if-configured -> save -> init sequencing (plus the
// concurrency guard that keeps two near-simultaneous saveKey calls from
// each running that whole sequence independently) lives in
// sync/save-key-handler.js, a pure module unit-tested with fakes — see
// its own doc comment and test/sync-save-key-handler.test.js. Wraps
// initSyncAndAuth so a successful in-process init also rebuilds the
// Radar menu (Sign Out now applies) — the pure module itself has no
// notion of the menu.
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

/* ---------- Menu ---------- */
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
        { label: 'New Contact', accelerator: 'CmdOrCtrl+N', click: send('new') },
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

/* ---------- App lifecycle ---------- */
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
    // Used for the window/taskbar icon on Windows and Linux (ignored on macOS,
    // which takes the icon from the .icns in the packaged bundle / dock below).
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
  // Window focus is one of the sync engine's triggers (see
  // docs/supabase-sync-plan.md's Phase 4-5 notes) — a no-op while sync
  // isn't running, so this is safe to wire unconditionally.
  win.on('focus', () => {
    // triggerNow() is fire-and-forget here (the focus handler can't await
    // it) — without a .catch, anything that throws outside runCycle's own
    // try/catch (e.g. getUserId()/now() themselves) becomes an unhandled
    // rejection with no cycleId context (found in review).
    if (syncLifecycle && syncLifecycle.isRunning()) {
      syncEngine.triggerNow().catch((err) => log.error('sync focus trigger failed', { err }));
    }
  });
  log.info('window created', { width: state.width, height: state.height });
}

app.whenReady().then(async () => {
  // Dev convenience: show the radar icon in the macOS dock. Packaged builds
  // get their dock icon from the bundled .icns, but `electron .` would
  // otherwise show the generic Electron icon.
  if (process.platform === 'darwin' && app.dock && fs.existsSync(ICON_PNG)) {
    app.dock.setIcon(ICON_PNG);
  }

  await dailyBackup();
  initSyncAndAuth();
  buildMenu();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
