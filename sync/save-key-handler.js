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

   Found in review: a double-click on the prompt's Save button (before
   the renderer disabled the button while a save was in flight — see
   renderer/app.js's SyncConfigPrompt.save()) could fire two overlapping
   syncConfig:saveKey calls. The old inline handler let both observe
   `authService` as still unset, so both saved and called
   initSyncAndAuth() — the second ran against an `authService` the first
   had *just* set, logging a false "auth could not be initialized", but
   the handler unconditionally returned `{ ok: true }` regardless,
   masking it. A separate, downstream bug: `SyncConfigPrompt.save()` calls
   `Auth.init()` again after every successful save, so both overlapping
   saves each called it once too — before `Auth.init()` had its own
   idempotency guard, that double-bound the #auth-form submit listener,
   making every sign-in submit fire twice.

   `handleSaveKey()` keeps a single in-flight run's promise (`pending`,
   alongside the key it's running for, `pendingKey`) and hands it to any
   call that arrives *for that same key* while it's still settling — see
   the comment on those two variables below for what happens when a
   different key arrives mid-save.
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

  // The one in-flight run, if any, plus the (trimmed) key it's running
  // for — see the module doc comment above for why concurrent calls for
  // the *same* key join this instead of each running the sequence
  // independently. A call for a *different* key must never be handed
  // this result (it was never validated/saved for that key at all) — it
  // instead waits for the in-flight run to settle, then starts its own
  // fresh run. That fresh run either genuinely saves+configures this
  // key (if the first one failed), or — if the first one succeeded —
  // finds sync already configured by a key that was never this one, and
  // reports that honestly as a failure (`asWaitedRetry`, below) rather
  // than the ordinary "already configured" success. In the UI, only one
  // key can ever actually be in the input at a time, so this only
  // matters for a case the UI itself doesn't reach — documented and
  // tested here rather than left implicit.
  let pending = null;
  let pendingKey = null;

  async function run(rawKey, { asWaitedRetry = false } = {}) {
    const validation = validateKey(rawKey);
    if (!validation.ok) {
      log.warn('rejected sync-config key save — failed validation', { reason: validation.error });
      return { ok: false, error: validation.error };
    }

    if (isAlreadyConfigured()) {
      if (asWaitedRetry) {
        // This run only exists because it waited out a *different* key's
        // in-flight save (see handleSaveKey below) — its own key was
        // never saved or used at all; a different, concurrent call's key
        // is what actually configured sync. Reporting `ok: true` here
        // (found in review) would tell the caller its own key is now in
        // effect, which isn't true.
        return { ok: false, error: 'Sync is already configured.' };
      }
      // The ordinary case: nothing went wrong, there was just nothing
      // left to do (env vars were set all along, or an earlier run
      // already finished this) — distinct from an init failure below.
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
    let started;
    try {
      started = initSyncAndAuth();
    } catch (err) {
      // A thrown initSyncAndAuth() (found in review) must not escape as
      // an unhandled rejection, and must not silently leave the key
      // "saved but nothing happened" with no log at all. main.js's own
      // initSyncAndAuth() only assigns its module-level state once
      // everything it builds has succeeded, so a throw here can't have
      // left authService set without a matching syncEngine/syncLifecycle
      // — but this module doesn't rely on that, it just reports the
      // failure honestly either way.
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

  function handleSaveKey(rawKey, { asWaitedRetry = false } = {}) {
    const trimmedKey = typeof rawKey === 'string' ? rawKey.trim() : rawKey;
    const inFlight = pending;
    if (inFlight) {
      if (pendingKey === trimmedKey) return inFlight;
      // A different key arrived while a save is in flight: never share
      // that unrelated result. Wait for it to settle (its outcome
      // doesn't matter here either way — swallow a rejection so it can
      // never surface as this call's own failure), then run a fresh
      // sequence for this key, tagged `asWaitedRetry` so run() reports
      // an honest failure rather than a misleading `ok: true` if it
      // turns out the wait ended with sync already configured (by the
      // key it was waiting on, not this one) — see run()'s own comment.
      // By then `pending`/`pendingKey` are already cleared (the
      // `.finally` below runs, and this promise settles, before any
      // reaction attached to it — including this one — can fire), so the
      // recursive call is guaranteed to see no in-flight run and start
      // its own.
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
