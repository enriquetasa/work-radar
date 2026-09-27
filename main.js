'use strict';

const crypto = require('node:crypto');
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
const { createOnboardingStore } = require('./onboarding-store');
const { normalizePreferences, buildBriefing, renderBriefing } = require('./briefing');
const history = require('./sync/history');
const { createAttachmentService } = require('./sync/attachments');
const {
  createFullBackupArchive,
  importFullBackupArchive,
  parseFullBackupArchive,
} = require('./sync/attachment-backup');

// Keep the data directory stable if the Electron product name changes.
app.setPath('userData', path.join(app.getPath('appData'), 'work-radar'));
log.info('userData path resolved', { userData: app.getPath('userData') });

const BASE_DATA_FILE = () => path.join(app.getPath('userData'), 'work-radar-data.json');
const PROFILE_ROOT = () => path.join(app.getPath('userData'), 'profiles');
let activeProfileId = null;
const profilePath = (userId) =>
  path.join(
    PROFILE_ROOT(),
    `${String(userId).replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown'}`,
    'work-radar-data.json'
  );
const DATA_FILE = () => (activeProfileId ? profilePath(activeProfileId) : BASE_DATA_FILE());
const SYNC_STATE_FILE = () => path.join(app.getPath('userData'), 'sync-state.json');
const BACKUP_DIR = () => path.join(app.getPath('userData'), 'backups');
const WINSTATE = () => path.join(app.getPath('userData'), 'window-state.json');
const BRIEFING_FILE = () => path.join(app.getPath('userData'), 'briefing-preferences.json');
const ONBOARDING_FILE = () => path.join(app.getPath('userData'), 'onboarding.json');
const PROFILE_FILE = () => path.join(app.getPath('userData'), 'profile.json');
const ATTACHMENTS_DIR = () => path.join(app.getPath('userData'), 'attachments');
const ICON_PNG = path.join(__dirname, 'build', 'icon.png');
const MAX_BACKUPS = 30;

function getSyncConfig() {
  return resolveSyncConfig({
    userDataDir: app.getPath('userData'),
    bundledConfigDir: app.isPackaged ? process.resourcesPath : undefined,
  });
}

let win = null;
let authService = null;
let syncEngine = null;
let syncLifecycle = null;
let supabaseClient = null;
let authGeneration = 0;
let localDataQueue = Promise.resolve();
let attachmentService = null;
const attachmentClientRef = { current: null };
const attachmentStorageProxy = new Proxy(
  {},
  {
    get: (_target, property) => {
      const storage = attachmentClientRef.current?.storage;
      const value = storage?.[property];
      return typeof value === 'function' ? value.bind(storage) : value;
    },
  }
);
const attachmentClientProxy = new Proxy(
  {},
  {
    get: (_target, property) => {
      if (property === 'storage') return attachmentStorageProxy;
      const value = attachmentClientRef.current?.[property];
      return typeof value === 'function' ? value.bind(attachmentClientRef.current) : value;
    },
  }
);

const readJSON = (file) => readJsonFile(file, { log });
const atomicWrite = (file, data) => writeJsonFileAtomic(file, data, { log });

function captureProfileContext() {
  const profileId = activeProfileId || null;
  return {
    profileId,
    dataPath: DATA_FILE(),
    scope: profileId || 'local',
    authGeneration,
  };
}

function assertProfileContext(context) {
  if (
    activeProfileId !== context.profileId ||
    DATA_FILE() !== context.dataPath ||
    authGeneration !== context.authGeneration
  ) {
    throw new Error('profile changed; operation cancelled');
  }
}

function assertPayloadProfile(data, context) {
  if (data && Object.hasOwn(data, 'profileId') && (data.profileId || null) !== context.profileId) {
    throw new Error('profile changed; reload before continuing');
  }
}
const onboardingStore = createOnboardingStore({
  filePath: ONBOARDING_FILE(),
  read: (file) => readJSON(file),
  write: (file, value) => atomicWrite(file, value),
});

// Backups are best-effort and must never block startup.
async function dailyBackup() {
  const capturedProfileId = activeProfileId;
  const capturedDataPath = DATA_FILE();
  const capturedService = attachmentService;
  const capturedScope = capturedProfileId || 'local';
  if (!fs.existsSync(capturedDataPath)) return;
  try {
    await fsp.mkdir(BACKUP_DIR(), { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const scopeName = capturedProfileId
      ? String(capturedProfileId).replace(/[^a-zA-Z0-9_-]/g, '')
      : 'local';
    const target = path.join(BACKUP_DIR(), 'work-radar-' + scopeName + '-' + stamp + '.json');
    if (!fs.existsSync(target)) {
      const raw = await readJSON(capturedDataPath);
      const records = capturedService
        ? await capturedService.list({ scope: capturedScope, includeDeleted: false })
        : [];
      const snapshot = raw
        ? { ...raw, attachments: records.map(({ localPath, cachePath, ...record }) => record) }
        : raw;
      await fsp.writeFile(target, JSON.stringify(snapshot, null, 2), 'utf8');
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

ipcMain.handle('data:load', async () => {
  const data = await readJSON(DATA_FILE());
  if (data && Number.isSafeInteger(data.schema) && data.schema > 3)
    throw new Error('Unsupported newer Work Radar data schema: ' + data.schema);
  return data
    ? { ...data, profileId: activeProfileId }
    : activeProfileId
      ? {
          schema: 3,
          items: [],
          arch: [],
          lastExport: 0,
          itemRevisions: [],
          profileId: activeProfileId,
        }
      : data;
});

ipcMain.handle('data:save', async (_e, data) => {
  if (!data || typeof data !== 'object') {
    log.warn('rejected save with invalid payload', { type: typeof data });
    return { ok: false, error: 'invalid payload' };
  }
  try {
    if (Number.isSafeInteger(data.schema) && data.schema > 3)
      return { ok: false, error: 'Unsupported newer Work Radar data schema: ' + data.schema };
    if (
      Object.hasOwn(data, 'profileId') &&
      (data.profileId || null) !== (activeProfileId || null)
    ) {
      return { ok: false, error: 'profile changed; reload before saving' };
    }
    // The engine serializes saves with any pull already in flight. Local-only
    // saves use the same durable revision append path so offline history is
    // retained before any account is chosen.
    if (syncEngine) {
      const saved = await syncEngine.recordLocalSave(data);
      return { ok: true, data: saved };
    } else {
      const targetFile = DATA_FILE();
      const save = localDataQueue.then(async () => {
        const current = (await readJSON(targetFile)) || { items: [], arch: [], itemRevisions: [] };
        const before = new Map(
          [...(current.items || []), ...(current.arch || [])].map((item) => [item.id, item])
        );
        const changed = [...(data.items || []), ...(data.arch || [])].filter((item) => {
          const previous = before.get(item.id);
          return (
            !previous ||
            previous.updatedAt !== item.updatedAt ||
            previous.deletedAt !== item.deletedAt ||
            previous.archivedAt !== item.archivedAt
          );
        });
        const existingRevisions = Array.isArray(current.itemRevisions) ? current.itemRevisions : [];
        const incomingRevisions = Array.isArray(data.itemRevisions) ? data.itemRevisions : [];
        const revisions = [
          ...new Map(
            [...existingRevisions, ...incomingRevisions]
              .filter((revision) => revision && revision.id)
              .map((revision) => [revision.id, revision])
          ).values(),
        ];
        const enriched = changed.length
          ? history.append({ ...data, itemRevisions: revisions }, changed, {
              action: data.historyAction || 'edit',
              restoredFromRevisionId: data.restoredFromRevisionId,
            })
          : { ...data, itemRevisions: revisions };
        await atomicWrite(targetFile, enriched);
        return enriched;
      });
      localDataQueue = save.catch(() => {});
      const enriched = await save;
      return { ok: true, data: enriched };
    }
  } catch (err) {
    log.error('failed to save data file', { file: DATA_FILE(), err });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('data:export', async (_e, data) => {
  const context = captureProfileContext();
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Work Radar backup',
    defaultPath: `work-radar-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false };
  try {
    assertProfileContext(context);
    assertPayloadProfile(data, context);
    await localDataQueue;
    assertProfileContext(context);
    const authoritative = (await readJSON(context.dataPath)) || data;
    assertProfileContext(context);
    if (Number.isSafeInteger(authoritative?.schema) && authoritative.schema > 3)
      throw new Error('Unsupported newer Work Radar data schema: ' + authoritative.schema);
    const service = buildAttachmentService(supabaseClient);
    const attachmentRecords = service
      ? await service.list({ scope: context.scope, includeDeleted: false })
      : [];
    assertProfileContext(context);
    const exported = {
      ...authoritative,
      attachments: attachmentRecords.map(({ localPath, cachePath, ...record }) => record),
    };
    await fsp.writeFile(filePath, JSON.stringify(exported, null, 2), 'utf8');
    assertProfileContext(context);
    log.info('exported backup', { path: filePath });
    return { ok: true, path: filePath };
  } catch (err) {
    log.error('failed to export backup', { path: filePath, err });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('data:import', async () => {
  const context = captureProfileContext();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import Work Radar backup',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePaths[0]) return null;
  try {
    const imported = await readJSON(filePaths[0]);
    assertProfileContext(context);
    if (imported && Number.isSafeInteger(imported.schema) && imported.schema > 3)
      return { error: 'Unsupported newer Work Radar data schema: ' + imported.schema };
    return imported;
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('data:exportFull', async (_event, data) => {
  const context = captureProfileContext();
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export full Work Radar backup',
    defaultPath: `work-radar-full-backup-${new Date().toISOString().slice(0, 10)}.wrbackup`,
    filters: [{ name: 'Work Radar backup', extensions: ['wrbackup'] }],
  });
  if (canceled || !filePath) return { ok: false };
  try {
    assertProfileContext(context);
    assertPayloadProfile(data, context);
    await localDataQueue;
    assertProfileContext(context);
    const authoritative = (await readJSON(context.dataPath)) || data;
    assertProfileContext(context);
    if (Number.isSafeInteger(authoritative?.schema) && authoritative.schema > 3)
      throw new Error('Unsupported newer Work Radar data schema: ' + authoritative.schema);
    const service = buildAttachmentService(supabaseClient);
    const attachments = service
      ? await service.list({ scope: context.scope, includeDeleted: false })
      : [];
    assertProfileContext(context);
    const archive = await createFullBackupArchive({
      data: authoritative,
      history: authoritative.itemRevisions || [],
      attachments,
      readAttachmentBytes: async (record) => {
        assertProfileContext(context);
        if (!service) return null;
        const local = await service
          .storage(context.scope)
          .read(record.id)
          .catch(() => null);
        if (local) {
          assertProfileContext(context);
          return local.bytes;
        }
        const downloaded = await service.download(record.id, { scope: context.scope });
        const bytes = await fsp.readFile(downloaded);
        assertProfileContext(context);
        return bytes;
      },
    });
    assertProfileContext(context);
    await fsp.writeFile(filePath, archive);
    assertProfileContext(context);
    return { ok: true, path: filePath };
  } catch (err) {
    log.error('full backup export failed', { err });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('data:importFull', async () => {
  const context = captureProfileContext();
  const picked = await dialog.showOpenDialog(win, {
    title: 'Import full Work Radar backup',
    properties: ['openFile'],
    filters: [{ name: 'Work Radar backup', extensions: ['wrbackup', 'gz'] }],
  });
  if (picked.canceled || !picked.filePaths[0]) return null;
  const createdAttachmentIds = new Set();
  try {
    const archiveBytes = await fsp.readFile(picked.filePaths[0]);
    assertProfileContext(context);
    const parsed = parseFullBackupArchive(archiveBytes);
    if (parsed.data && Number.isSafeInteger(parsed.data.schema) && parsed.data.schema > 3)
      throw new Error('Unsupported newer Work Radar data schema: ' + parsed.data.schema);
    const service = buildAttachmentService(supabaseClient);
    const idempotentAttachments = new Set();
    const restoreAttachments = new Set();
    const existingById = new Map();
    if (service) {
      for (const record of await service.list({ scope: context.scope, includeDeleted: true })) {
        assertProfileContext(context);
        existingById.set(record.id, record);
      }
      for (const attachment of parsed.attachments) {
        assertProfileContext(context);
        const existing = existingById.get(attachment.id);
        if (!existing) continue;
        const sameMetadata =
          !existing.deletedAt &&
          existing.itemId === attachment.itemId &&
          existing.displayName === attachment.displayName &&
          existing.contentType === attachment.contentType &&
          existing.byteSize === attachment.byteSize &&
          existing.checksum === attachment.checksum;
        if (!sameMetadata) {
          throw new Error(
            'backup attachment ID ' + attachment.id + ' conflicts with an existing attachment'
          );
        }
        const local = await service
          .storage(context.scope)
          .read(existing.id)
          .catch(() => null);
        const sameBytes =
          local &&
          local.bytes.length === attachment.byteSize &&
          crypto.createHash('sha256').update(local.bytes).digest('hex') === attachment.checksum;
        if (sameBytes) idempotentAttachments.add(attachment.id);
        else restoreAttachments.add(attachment.id);
      }
    }
    assertProfileContext(context);
    const choice = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Import backup', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Import full Work Radar backup',
      message:
        'Import ' +
        (Array.isArray(parsed.data.items) ? parsed.data.items.length : 0) +
        ' live and ' +
        (Array.isArray(parsed.data.arch) ? parsed.data.arch.length : 0) +
        ' archived projects plus ' +
        parsed.attachments.length +
        ' attachments?',
      detail: 'The imported projects will be merged with this profile.',
    });
    assertProfileContext(context);
    if (choice.response !== 0) return null;
    const backup = await importFullBackupArchive(archiveBytes, {
      writeAttachment: service
        ? async (attachment) => {
            assertProfileContext(context);
            if (idempotentAttachments.has(attachment.id)) {
              return { ...existingById.get(attachment.id), created: false };
            }
            const imported = await service.importBytes({
              record: attachment,
              bytes: attachment.bytes,
              scope: context.scope,
              deferQueue: true,
            });
            if (!restoreAttachments.has(attachment.id)) createdAttachmentIds.add(attachment.id);
            try {
              assertProfileContext(context);
            } catch (error) {
              if (!restoreAttachments.has(attachment.id))
                await service
                  .discardImported(attachment.id, { scope: context.scope })
                  .catch(() => {});
              throw error;
            }
            return restoreAttachments.has(attachment.id)
              ? { ...imported, created: false }
              : imported;
          }
        : undefined,
      removeAttachment: service
        ? (attachment) =>
            idempotentAttachments.has(attachment.id) || restoreAttachments.has(attachment.id)
              ? null
              : service.discardImported(attachment.id, { scope: context.scope })
        : undefined,
    });
    assertProfileContext(context);
    if (service && context.scope !== 'local') {
      for (const attachment of parsed.attachments) {
        assertProfileContext(context);
        if (!idempotentAttachments.has(attachment.id))
          await service.enqueueImported(attachment.id, { scope: context.scope });
      }
    }
    assertProfileContext(context);
    return {
      ...backup.data,
      itemRevisions: backup.history,
      attachments: backup.attachments.map(({ bytes, localPath, cachePath, ...record }) => record),
      __fullImportConfirmed: true,
    };
  } catch (err) {
    if (createdAttachmentIds.size) {
      const service = buildAttachmentService(supabaseClient);
      if (service) {
        for (const id of createdAttachmentIds) {
          await service.discardImported(id, { scope: context.scope }).catch(() => {});
        }
      }
    }
    log.warn('full backup import failed', { err });
    return { error: err.message };
  }
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

// Onboarding is local installation state and is never included in backups.
ipcMain.handle('onboarding:get', () => onboardingStore.get());
ipcMain.handle('onboarding:update', async (_event, patch) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    return { ok: false, error: 'invalid onboarding update' };
  try {
    return { ok: true, state: await onboardingStore.update(patch) };
  } catch (err) {
    log.error('failed to persist onboarding state', { err });
    return { ok: false, error: 'could not save onboarding state' };
  }
});
ipcMain.handle('onboarding:chooseLocal', async () => {
  try {
    return { ok: true, state: await onboardingStore.chooseLocal() };
  } catch (err) {
    log.error('failed to persist local-only choice', { err });
    return { ok: false, error: 'could not save local-only choice' };
  }
});
ipcMain.handle('onboarding:markSignedIn', async () => {
  try {
    return { ok: true, state: await onboardingStore.markSignedIn() };
  } catch (err) {
    log.error('failed to persist signed-in onboarding state', { err });
    return { ok: false, error: 'could not save onboarding state' };
  }
});
ipcMain.handle('briefing:preferences', async () => {
  const local = normalizePreferences((await readJSON(BRIEFING_FILE())) || {});
  let signedIn = false;
  let cloudError = null;
  if (supabaseClient && authService) {
    try {
      const { data: session } = await supabaseClient.auth.getSession();
      const userId = session.session?.user?.id;
      signedIn = Boolean(userId);
      if (userId) {
        const { data, error } = await supabaseClient.functions.invoke('morning-briefing', {
          body: { action: 'status' },
        });
        if (error || !data?.ok) {
          cloudError = 'cloud briefing status unavailable';
        } else {
          return {
            ok: true,
            preferences: normalizePreferences(data.preferences || local),
            signedIn,
            latestDelivery: data.latestDelivery || null,
            latestTest: data.latestTest || null,
          };
        }
      }
    } catch (err) {
      cloudError = 'cloud briefing status unavailable';
      log.warn('briefing preference cloud read unavailable', { err });
    }
  }
  return { ok: true, preferences: local, signedIn, cloudError };
});
ipcMain.handle('briefing:setPreferences', async (_event, preferences) => {
  try {
    const normalized = normalizePreferences(preferences || {});
    await atomicWrite(BRIEFING_FILE(), normalized);
    let cloudSynced = false;
    let signedIn = false;
    let cloudError = null;
    if (supabaseClient && authService) {
      try {
        const { data: session } = await supabaseClient.auth.getSession();
        const userId = session.session?.user?.id;
        signedIn = Boolean(userId);
        if (userId) {
          const { error } = await supabaseClient.from('briefing_preferences').upsert({
            owner_id: userId,
            enabled: normalized.enabled,
            timezone: normalized.timezone,
            local_time: normalized.time,
            weekdays: normalized.weekdays,
            updated_at: new Date().toISOString(),
          });
          if (error) {
            cloudError = 'could not sync briefing settings to your account';
            log.warn('briefing preference cloud write unavailable', { err: error });
          } else cloudSynced = true;
        }
      } catch (err) {
        cloudError = 'could not sync briefing settings to your account';
        log.warn('briefing preference cloud write unavailable', { err });
      }
    }
    return {
      ok: true,
      preferences: normalized,
      cloudSynced,
      signedIn,
      cloudError,
    };
  } catch (err) {
    log.error('failed to save briefing preferences', { err });
    return { ok: false, error: 'could not save briefing preferences' };
  }
});
ipcMain.handle('briefing:preview', async (_event, payload = {}) => {
  const preferences = normalizePreferences(payload.preferences || {});
  const data = await readJSON(DATA_FILE());
  const briefing = buildBriefing(Array.isArray(data && data.items) ? data.items : [], {
    localDate: payload.localDate,
    timezone: preferences.timezone,
    generatedAt: new Date().toISOString(),
  });
  return { ok: true, briefing, rendered: renderBriefing(briefing) };
});
ipcMain.handle('briefing:test', async () => {
  if (!supabaseClient || !authService)
    return { ok: false, status: 'failed', error: 'sign in to send a test briefing' };
  try {
    const status = await authService.getStatus();
    if (!status.signedIn)
      return { ok: false, status: 'failed', error: 'sign in to send a test briefing' };
    const { data, error } = await supabaseClient.functions.invoke('morning-briefing', {
      body: { action: 'test' },
    });
    if (error || data?.error) {
      return {
        ok: false,
        status: 'failed',
        error: String(data?.error || 'test delivery failed')
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 240),
      };
    }
    return {
      ok: true,
      status: data?.status || (data?.skipped ? 'skipped' : 'sent'),
      skipped: data?.skipped === true,
      reason: data?.reason || null,
    };
  } catch (err) {
    log.warn('briefing test delivery failed', { err });
    return { ok: false, status: 'failed', error: 'test delivery failed' };
  }
});

async function profileState() {
  return (await readJSON(PROFILE_FILE())) || { version: 1, activeUserId: null, associatedAt: null };
}
async function hasLocalProjectData() {
  const data = await readJSON(DATA_FILE());
  return !!(
    data &&
    ((Array.isArray(data.items) && data.items.length) ||
      (Array.isArray(data.arch) && data.arch.length))
  );
}
async function profileAllowsUser(userId) {
  const state = await profileState();
  if (state.activeUserId === userId) {
    activeProfileId = userId;
    return true;
  }
  // A signed-in account with no local-only data may select its own isolated
  // profile after sign-out from another account.
  if (await hasLocalProjectData()) return false;
  activeProfileId = userId;
  await atomicWrite(PROFILE_FILE(), { ...state, activeUserId: userId, associatedAt: Date.now() });
  return true;
}
async function associateCurrentProfile(userId) {
  const state = await profileState();
  const base = BASE_DATA_FILE();
  const target = profilePath(userId);
  const localExists = fs.existsSync(base);
  if (localExists && state.activeUserId !== userId) {
    if (fs.existsSync(target)) throw new Error('an account profile already exists on this device');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rename(base, target);
  }
  activeProfileId = userId;
  const next = { ...state, activeUserId: userId, associatedAt: Date.now() };
  await atomicWrite(PROFILE_FILE(), next);
  return next;
}

ipcMain.handle('profile:status', async () => {
  const state = await profileState();
  const status = authService ? await authService.getStatus() : { signedIn: false };
  return {
    activeUserId: state.activeUserId,
    signedInUserId: status.userId || null,
    requiresAssociation: !!(
      status.signedIn &&
      state.activeUserId !== status.userId &&
      (await hasLocalProjectData())
    ),
  };
});
ipcMain.handle('profile:useSeparate', async () => {
  if (!authService) return { ok: false, error: 'sign in to use a separate profile' };
  const status = await authService.getStatus();
  if (!status.signedIn || !status.userId)
    return { ok: false, error: 'sign in to use a separate profile' };
  try {
    await fsp.mkdir(path.dirname(profilePath(status.userId)), { recursive: true });
    activeProfileId = status.userId;
    const state = await profileState();
    await atomicWrite(PROFILE_FILE(), {
      ...state,
      activeUserId: status.userId,
      associatedAt: state.associatedAt || null,
    });
    authGeneration += 1;
    startSyncProfile(status);
    if (win) win.webContents.send('auth:stateChanged', status);
    return { ok: true };
  } catch (err) {
    log.error('separate profile selection failed', { err });
    return { ok: false, error: 'could not select account profile' };
  }
});
ipcMain.handle('profile:associate', async () => {
  if (!authService) return { ok: false, error: 'sign in to associate this profile' };
  const status = await authService.getStatus();
  if (!status.signedIn || !status.userId)
    return { ok: false, error: 'sign in to associate this profile' };
  try {
    await associateCurrentProfile(status.userId);
    const service = buildAttachmentService(supabaseClient);
    if (service) await service.associateLocalAccount(status.userId);
    if (authGeneration) authGeneration += 1;
    startSyncProfile(status);
    if (win) win.webContents.send('auth:stateChanged', status);
    return { ok: true };
  } catch (err) {
    log.error('profile association failed', { err });
    return { ok: false, error: 'could not associate local profile' };
  }
});

function buildAttachmentService(client = null) {
  if (client) attachmentClientRef.current = client;
  if (attachmentService) return attachmentService;
  try {
    attachmentService = createAttachmentService({
      rootDir: ATTACHMENTS_DIR(),
      client: attachmentClientProxy,
      accountId: null,
      log,
    });
    return attachmentService;
  } catch (err) {
    log.error('attachment service unavailable', { err });
    return null;
  }
}

ipcMain.handle('attachments:pickAdd', async (_event, itemId) => {
  const service = buildAttachmentService(supabaseClient);
  if (!service) return { ok: false, error: 'attachments are unavailable' };
  const picked = await dialog.showOpenDialog(win, {
    title: 'Add project attachment',
    properties: ['openFile'],
  });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
  try {
    return { ok: true, attachment: await service.add({ itemId, sourcePath: picked.filePaths[0] }) };
  } catch (err) {
    log.warn('attachment add failed', { err });
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('attachments:list', async (_event, itemId) => {
  const service = buildAttachmentService(supabaseClient);
  return service
    ? { ok: true, attachments: await service.list({ itemId }) }
    : { ok: true, attachments: [] };
});
ipcMain.handle('attachments:remove', async (_event, id) => {
  const service = buildAttachmentService(supabaseClient);
  if (!service) return { ok: false, error: 'attachments are unavailable' };
  try {
    return { ok: true, attachment: await service.remove(id) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('attachments:open', async (_event, id) => {
  const service = buildAttachmentService(supabaseClient);
  if (!service) return { ok: false, error: 'attachments are unavailable' };
  try {
    const record = await service.get(id);
    if (!record) return { ok: false, error: 'attachment is unavailable' };
    const sourcePath = await service.download(id);
    const displayName = path.basename(record.displayName || 'attachment');
    const safeName =
      displayName.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/^[-.]+/, '_') || 'attachment';
    const openDir = path.join(app.getPath('temp'), 'work-radar-open');
    await fsp.mkdir(openDir, { recursive: true });
    const openPath = path.join(openDir, id + '-' + safeName);
    await fsp.copyFile(sourcePath, openPath);
    const error = await shell.openPath(openPath);
    return error ? { ok: false, error } : { ok: true, path: openPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('attachments:removeForItem', async (_event, itemId) => {
  const service = buildAttachmentService(supabaseClient);
  if (!service) return { ok: false, error: 'attachments are unavailable' };
  try {
    const records = await service.list({ itemId, includeDeleted: false });
    const removed = [];
    for (const record of records) removed.push(await service.remove(record.id));
    return { ok: true, removed };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('attachments:refresh', async () => {
  const service = buildAttachmentService(supabaseClient);
  if (!service) return { ok: false, error: 'attachments are unavailable' };
  const context = captureProfileContext();
  try {
    assertProfileContext(context);
    const attachments = await service.pullMetadata({ scope: context.scope });
    assertProfileContext(context);
    try {
      assertProfileContext(context);
      await service.reconcile({ scope: context.scope, cleanupOrphans: false });
    } catch (err) {
      log.warn('attachment reservation reconciliation failed', { err });
    }
    assertProfileContext(context);
    return { ok: true, attachments };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('attachments:processQueue', async () => {
  const service = buildAttachmentService(supabaseClient);
  if (!service) return { ok: false, error: 'attachments are unavailable' };
  try {
    return { ok: true, results: await service.processQueue() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

const SESSION_FILE = () => path.join(app.getPath('userData'), 'sync-session.enc');

function buildAuthService() {
  const syncConfig = getSyncConfig();
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

function buildSyncEngine(client, dataFilePath) {
  return createSyncEngine({
    client,
    dataFilePath,
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

function stopSyncProfile() {
  const lifecycle = syncLifecycle;
  syncLifecycle = null;
  syncEngine = null;
  if (lifecycle) lifecycle.handleAuthStatus({ signedIn: false, userId: null, pending: false });
  if (win) win.webContents.send('sync:stateChanged', { state: null });
}

function startSyncProfile(status) {
  stopSyncProfile();
  const engine = buildSyncEngine(supabaseClient, DATA_FILE());
  const realtime = buildRealtimeSync(supabaseClient, engine);
  const lifecycle = createSyncLifecycle({ engine, realtime });
  syncEngine = engine;
  syncLifecycle = lifecycle;
  lifecycle.handleAuthStatus(status);
  const context = captureProfileContext();
  attachmentService
    ?.setAccount(status.userId)
    .then(async () => {
      await attachmentService.pullMetadata({ scope: context.scope });
      assertProfileContext(context);
      try {
        await attachmentService.reconcile({ scope: context.scope, cleanupOrphans: false });
      } catch (err) {
        log.warn('attachment reservation reconciliation failed', { err });
      }
      assertProfileContext(context);
      await dailyBackup();
    })
    .catch((err) => log.warn('attachment account sync failed', { err }));
  if (win) win.webContents.send('sync:reload');
}

function initSyncAndAuth() {
  if (authService) return false;
  const built = buildAuthService();
  if (!built) return false;
  try {
    built.service.onChange((status) => {
      const generation = ++authGeneration;
      if (!status.signedIn) {
        stopSyncProfile();
        activeProfileId = null;
        attachmentService
          ?.setAccount(null)
          .catch((err) => log.warn('attachment account clear failed', { err }));
        if (win) win.webContents.send('auth:stateChanged', status);
        return;
      }
      // Stop the prior account before any awaited profile check. The old
      // engine is then unreachable from data:save and cannot write after the
      // active profile changes.
      if (activeProfileId && activeProfileId !== status.userId) stopSyncProfile();
      profileAllowsUser(status.userId)
        .then((allowed) => {
          if (generation !== authGeneration) return;
          if (win)
            win.webContents.send(
              'auth:stateChanged',
              allowed ? status : { ...status, profileRequired: true }
            );
          if (allowed) startSyncProfile(status);
        })
        .catch((err) => log.error('profile association check failed', { err }));
    });
    authService = built.service;
    supabaseClient = built.client;
    buildAttachmentService(supabaseClient);
    return true;
  } catch (err) {
    disposeFailedAuthAttempt({ service: built.service, client: built.client });
    throw err;
  }
}

// The renderer requests an initial snapshot in case it missed an early status event.
ipcMain.handle('sync:status', async () => {
  return syncLifecycle && syncLifecycle.isRunning() && syncEngine ? syncEngine.getStatus() : null;
});

ipcMain.handle('auth:status', async () => {
  if (!authService) return { configured: false };
  const status = await authService.getStatus();
  const state = await profileState();
  const profileRequired = !!(
    status.signedIn &&
    state.activeUserId !== status.userId &&
    (await hasLocalProjectData())
  );
  return { configured: true, ...status, profileRequired };
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
  const syncConfig = getSyncConfig();
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
        { label: 'Export Full Backup…', click: send('exportFull') },
        { label: 'Import Backup…', accelerator: 'CmdOrCtrl+I', click: send('import') },
        { label: 'Import Full Backup…', click: send('importFull') },
        { label: 'Reveal Auto-Backups', click: send('reveal') },
        { label: 'Open Introduction', click: send('welcome') },
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

  try {
    initSyncAndAuth();
  } catch (err) {
    log.error('initSyncAndAuth failed at startup — continuing fully local', { err });
  }
  buildAttachmentService(supabaseClient);
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
