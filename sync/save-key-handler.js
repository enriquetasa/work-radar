'use strict';
/* ============================================================
   WORK RADAR — save-key sequencing (startup "add your key" prompt)
   Pure, dependency-injected sequencing for main.js's syncConfig:saveKey
   IPC handler — same split as sync/sync-lifecycle.js: the decision logic
   lives here as a plain function taking injected collaborators, so it's
   unit-testable under node:test without Electron (see
   test/sync-save-key-handler.test.js); main.js supplies the real
   collaborators (sync/key-validation.js's validatePublishableKey,
   `() => !!authService`, sync/sync-config-store.js's saveSyncConfigKey,
   and its own initSyncAndAuth()).

   Sequencing: validate -> skip if already configured -> save -> init.

   Found in review: the old inline handler let two near-simultaneous
   syncConfig:saveKey calls (caused by a renderer bug — see
   renderer/app.js's Auth.init() idempotency fix — that bound the same
   #auth-form submit listener twice, which is a separate fix from this
   one) both pass the "not yet configured" check before either had
   finished its own await, so both went on to save and call
   initSyncAndAuth() — the second one running against a
   `authService` the first one had *just* set, then logging a false
   "auth could not be initialized" and reporting `{ ok: false }` for a
   save that had actually succeeded. `handleSaveKey()` below keeps a
   single in-flight run's promise (`pending`) and hands it to any call
   that arrives while it's still settling, so the whole
   validate/save/init sequence only ever executes once per overlapping
   burst of calls — there is no gap left for a second call to observe a
   stale "not configured" state in.
   ============================================================ */

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

  // The one in-flight run, if any — see the module doc comment above for
  // why concurrent calls join this instead of each running the sequence
  // independently.
  let pending = null;

  async function run(rawKey) {
    const validation = validateKey(rawKey);
    if (!validation.ok) {
      log.warn('rejected sync-config key save — failed validation', { reason: validation.error });
      return { ok: false, error: validation.error };
    }

    if (isAlreadyConfigured()) {
      // Distinct from an init failure below — nothing went wrong, there
      // was just nothing left to do (env vars were set all along, or an
      // earlier run already finished this).
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

    // No app restart: build auth/sync/realtime the same way normal
    // startup does, in-process, then let the ordinary sign-in panel take
    // over from here.
    const started = initSyncAndAuth();
    if (!started) {
      log.error(
        'sync-config.json saved but auth could not be initialized — see the previous log line ' +
          '(e.g. no OS secret store available for safeStorage)'
      );
      // The key itself *was* saved — that's not undone — but sync can't
      // actually come up this run, and the caller must not report
      // ok:true for something that didn't happen (found in review).
      return {
        ok: false,
        error:
          'Key saved, but this system has no secure storage for the sign-in session, so sync can’t start.',
      };
    }
    log.info('sync configured in-process after the startup key prompt');
    return { ok: true };
  }

  function handleSaveKey(rawKey) {
    if (pending) return pending;
    pending = run(rawKey).finally(() => {
      pending = null;
    });
    return pending;
  }

  return { handleSaveKey };
}

module.exports = { createSaveKeyHandler };
