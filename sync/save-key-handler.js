'use strict';

const defaultLog = require('../logger');

function createSaveKeyHandler({
  validateKey,
  isAlreadyConfigured,
  saveKey,
  initSyncAndAuth,
  log = defaultLog,
} = {}) {
  if (typeof validateKey !== 'function') {
    throw new Error('createSaveKeyHandler requires validateKey');
  }
  if (typeof isAlreadyConfigured !== 'function') {
    throw new Error('createSaveKeyHandler requires isAlreadyConfigured');
  }
  if (typeof saveKey !== 'function') {
    throw new Error('createSaveKeyHandler requires saveKey');
  }
  if (typeof initSyncAndAuth !== 'function') {
    throw new Error('createSaveKeyHandler requires initSyncAndAuth');
  }

  // Identical concurrent saves share one run; different keys wait and retry.
  let pending = null;
  let pendingKey = null;

  async function run(rawKey, { asWaitedRetry = false } = {}) {
    const validation = validateKey(rawKey);
    if (!validation.ok) {
      log.warn('rejected sync-config key save — failed validation', { reason: validation.error });
      return { ok: false, error: validation.error };
    }

    if (isAlreadyConfigured()) {
      // This key was not the one that configured sync while it waited.
      if (asWaitedRetry) {
        return { ok: false, error: 'Sync is already configured.' };
      }
      return { ok: true, alreadyConfigured: true };
    }

    try {
      await saveKey(validation.key);
    } catch (err) {
      log.error('failed to save sync-config.json', { err });
      return {
        ok: false,
        error: 'Could not save the key — check the app can write to its data folder.',
      };
    }

    let started;
    try {
      started = initSyncAndAuth();
    } catch (err) {
      log.error('initSyncAndAuth threw while bringing sync up after a key save', { err });
      return {
        ok: false,
        error: 'Key saved, but sync could not be started — see the app logs for details.',
      };
    }
    if (!started) {
      log.error(
        'sync-config.json saved but auth could not be initialized — see the previous log line ' +
          '(e.g. no OS secret store available for safeStorage)'
      );
      return {
        ok: false,
        error:
          'Key saved, but this system has no secure storage for the sign-in session, so sync can’t start.',
      };
    }
    log.info('sync configured in-process after the startup key prompt');
    return { ok: true };
  }

  function handleSaveKey(rawKey, { asWaitedRetry = false } = {}) {
    const trimmedKey = typeof rawKey === 'string' ? rawKey.trim() : rawKey;
    // Never return another key's result to this caller.
    const inFlight = pending;
    if (inFlight) {
      if (pendingKey === trimmedKey) return inFlight;
      return inFlight.catch(() => {}).then(() => handleSaveKey(rawKey, { asWaitedRetry: true }));
    }
    pendingKey = trimmedKey;
    pending = run(rawKey, { asWaitedRetry }).finally(() => {
      pending = null;
      pendingKey = null;
    });
    return pending;
  }

  return { handleSaveKey };
}

module.exports = { createSaveKeyHandler };
