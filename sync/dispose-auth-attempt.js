'use strict';
/* ============================================================
   WORK RADAR — clean up a failed initSyncAndAuth() attempt
   Called by main.js's initSyncAndAuth() when a step after
   buildAuthService() throws (buildSyncEngine/buildRealtimeSync/
   createSyncLifecycle/authService.onChange).

   buildAuthService() itself already leaves a live, working auth service
   and supabase-js client behind by the time any of those later steps can
   throw: the service is already subscribed to the client's
   onAuthStateChange, and supabase-js's own auto-refresh ticker will
   already be running in this process by the time the client has finished
   initializing (see stopAutoRefreshOnceReady()'s own comment for exactly
   when that is) regardless of whether anything here ever succeeds. Left
   alone, a later successful retry of initSyncAndAuth() builds a *second*
   client/service pair — now two independently auto-refreshing clients
   are rotating the same refresh token, which can get the session revoked
   outright (auth-js treats a refresh token as single-use). This module
   tears the failed attempt down first: `service.dispose()` (clears its
   listeners and unsubscribes from the client) and, once the client is
   actually ready, `client.auth.stopAutoRefresh()` (stops that client's
   own ticker).

   Best-effort and defensive by design — this runs from inside an
   already-failing path, so neither half throwing (or the client/service
   being missing at all) may ever produce a second error on top of the
   first; each failure is caught and logged (with the error, never
   anything from the session/client itself) instead of escaping as a
   thrown error or an unhandled rejection. Returns a promise so a caller
   (or a test) that wants to wait for the cleanup to actually settle can;
   main.js's own caller doesn't need to — it rethrows synchronously right
   after starting this, so nothing there depends on this promise settling
   first.
   ============================================================ */

const defaultLog = require('../logger');

// supabase-js's own auto-refresh ticker is *not* running yet immediately
// after createClient() returns. createClient() kicks off auth's
// initialize() in the background without awaiting it, and — in a
// non-browser environment like this app's main process — it's
// _initialize()'s own `finally` block (which runs only once the
// persisted session has actually been read) that calls
// startAutoRefresh(), not createClient() itself. Calling
// stopAutoRefresh() immediately (an earlier version of this module) can
// therefore complete *before* the ticker has even started, and
// initialize() then starts it anyway moments later — reproduced in
// review against the installed auth-js 2.117.1 with this app's own
// client options. Awaiting client.auth.initialize() first guarantees the
// ticker decision has already been made by the time stopAutoRefresh()
// runs. Calling initialize() again here is safe even though
// createClient() already triggered it once: auth-js caches the
// in-flight/settled `initializePromise` and initialize() just
// awaits/returns that instead of starting a second initialization.
function stopAutoRefreshOnceReady(client, logger) {
  try {
    const ready =
      typeof client.auth.initialize === 'function'
        ? Promise.resolve(client.auth.initialize())
        : Promise.resolve();
    return ready
      .then(() => client.auth.stopAutoRefresh())
      .catch((err) => {
        logger.error('failed to stop auto-refresh after a failed initSyncAndAuth()', { err });
      });
  } catch (err) {
    // Defensive only — initialize()/stopAutoRefresh() are documented as
    // async, but this is cleanup code running inside an already-failing
    // path, so it takes no chances on a synchronous throw either.
    logger.error('failed to stop auto-refresh after a failed initSyncAndAuth()', { err });
    return Promise.resolve();
  }
}

function disposeFailedAuthAttempt({ service, client, log: logger = defaultLog } = {}) {
  if (service && typeof service.dispose === 'function') {
    try {
      service.dispose();
    } catch (err) {
      logger.error('failed to dispose the auth service after a failed initSyncAndAuth()', { err });
    }
  }
  if (!client || !client.auth || typeof client.auth.stopAutoRefresh !== 'function') {
    return Promise.resolve();
  }
  return stopAutoRefreshOnceReady(client, logger);
}

module.exports = { disposeFailedAuthAttempt };
