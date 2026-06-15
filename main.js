'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const DATA_FILE = () => path.join(app.getPath('userData'), 'work-radar-data.json');
const BACKUP_DIR = () => path.join(app.getPath('userData'), 'backups');
const WINSTATE = () => path.join(app.getPath('userData'), 'window-state.json');
const MAX_BACKUPS = 30;

let win = null;

/* ---------- JSON helpers ---------- */
async function readJSON(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (e) { return null; }
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
  await fsp.mkdir(BACKUP_DIR(), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const target = path.join(BACKUP_DIR(), `work-radar-${stamp}.json`);
  if (!fs.existsSync(target)) {
    await fsp.copyFile(DATA_FILE(), target).catch(() => {});
  }
  let files = (await fsp.readdir(BACKUP_DIR()).catch(() => []))
    .filter(f => f.startsWith('work-radar-') && f.endsWith('.json'))
    .sort();
  while (files.length > MAX_BACKUPS) {
    const f = files.shift();
    await fsp.unlink(path.join(BACKUP_DIR(), f)).catch(() => {});
  }
}

/* ---------- Window state persistence ---------- */
async function loadWinState() {
  const s = await readJSON(WINSTATE());
  return s && s.width ? s : { width: 1100, height: 720 };
}
async function saveWinState() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  await atomicWrite(WINSTATE(), b).catch(() => {});
}

/* ---------- IPC: all disk IO lives in the main process ---------- */
ipcMain.handle('data:load', async () => await readJSON(DATA_FILE()));

ipcMain.handle('data:save', async (_e, data) => {
  if (!data || typeof data !== 'object') return { ok: false };
  await atomicWrite(DATA_FILE(), data);
  return { ok: true };
});

ipcMain.handle('data:export', async (_e, data) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Work Radar backup',
    defaultPath: `work-radar-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { ok: false };
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  return { ok: true, path: filePath };
});

ipcMain.handle('data:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import Work Radar backup',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePaths[0]) return null;
  return await readJSON(filePaths[0]);
});

ipcMain.handle('data:revealBackups', async () => {
  await fsp.mkdir(BACKUP_DIR(), { recursive: true }).catch(() => {});
  shell.openPath(BACKUP_DIR());
  return { ok: true };
});

/* ---------- Menu ---------- */
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (action) => () => { if (win) win.webContents.send('menu', action); };

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' }
      ]
    }] : []),
    {
      label: 'Radar',
      submenu: [
        { label: 'New Contact', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: 'Search', accelerator: 'CmdOrCtrl+F', click: send('search') },
        { type: 'separator' },
        { label: 'Export Backup…', accelerator: 'CmdOrCtrl+E', click: send('export') },
        { label: 'Import Backup…', accelerator: 'CmdOrCtrl+I', click: send('import') },
        { label: 'Reveal Auto-Backups', click: () => win && win.webContents.send('menu', 'reveal') },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' }
      ]
    }
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // renderer cannot touch Node directly
      nodeIntegration: false,   // no Node in the renderer
      sandbox: true             // renderer runs sandboxed
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  let saveTimer = null;
  const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveWinState, 400); };
  win.on('resize', queueSave);
  win.on('move', queueSave);
  win.on('close', saveWinState);
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  await dailyBackup();
  buildMenu();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
