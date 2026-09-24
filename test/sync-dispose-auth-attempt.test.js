'use strict';
/* ============================================================
   Covers sync/dispose-auth-attempt.js's disposeFailedAuthAttempt() — the
   cleanup main.js's initSyncAndAuth() runs when a step after
   buildAuthService() throws (buildSyncEngine/buildRealtimeSync/
   createSyncLifecycle/authService.onChange). Found in review:
   buildAuthService() already leaves a live, subscribed auth service and
   a supabase-js client with its own auto-refresh ticker running in this
   process — left alone, a later successful retry builds a *second*
   client/service pair, and two independently auto-refreshing clients
   rotating the same refresh token can get the session revoked entirely.
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { disposeFailedAuthAttempt } = require('../sync/dispose-auth-attempt.js');

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, critical() {} };

test('disposes the service and stops auto-refresh on the client', async () => {
  const calls = [];
  const service = { dispose: () => calls.push('dispose') };
  const client = { auth: { stopAutoRefresh: async () => calls.push('stopAutoRefresh') } };
  // disposeFailedAuthAttempt() returns a promise precisely so a caller
  // (or a test) that wants to know the cleanup has actually finished can
  // await it, rather than guessing how many microtask ticks it takes.
  await disposeFailedAuthAttempt({ service, client, log: silentLog });
  assert.deepEqual(calls.sort(), ['dispose', 'stopAutoRefresh']);
});

test('tolerates a missing service or client (defensive)', () => {
  assert.doesNotThrow(() => disposeFailedAuthAttempt({ service: null, client: null }));
  assert.doesNotThrow(() => disposeFailedAuthAttempt({}));
});

test('a throwing dispose() is caught and logged, never escapes', () => {
  const errorCalls = [];
  const service = {
    dispose: () => {
      throw new Error('dispose boom');
    },
  };
  const log = { ...silentLog, error: (msg, ctx) => errorCalls.push({ msg, ctx }) };
  assert.doesNotThrow(() => disposeFailedAuthAttempt({ service, client: null, log }));
  assert.equal(errorCalls.length, 1);
  assert.match(errorCalls[0].msg, /dispose/i);
});

test('a rejecting stopAutoRefresh() is caught and logged, never an unhandled rejection', async () => {
  const errorCalls = [];
  const log = { ...silentLog, error: (msg, ctx) => errorCalls.push({ msg, ctx }) };
  const client = {
    auth: {
      stopAutoRefresh: async () => {
        throw new Error('refresh boom');
      },
    },
  };
  await disposeFailedAuthAttempt({ service: null, client, log });
  assert.equal(errorCalls.length, 1);
  assert.match(errorCalls[0].msg, /auto-refresh/i);
});

test('a synchronously-throwing stopAutoRefresh() is also caught, not just a rejection', async () => {
  const errorCalls = [];
  const log = { ...silentLog, error: (msg, ctx) => errorCalls.push({ msg, ctx }) };
  const client = {
    auth: {
      stopAutoRefresh: () => {
        throw new Error('sync boom');
      },
    },
  };
  await assert.doesNotReject(disposeFailedAuthAttempt({ service: null, client, log }));
  assert.equal(errorCalls.length, 1);
});

/* Regression test for a review finding: supabase-js's own auto-refresh
   ticker isn't running yet immediately after createClient() returns.
   createClient() kicks off auth's initialize() in the background without
   awaiting it, and — in a non-browser environment like this app's main
   process — it's _initialize()'s own `finally` block (which runs only
   after the persisted session has been read) that actually starts the
   ticker, not createClient() itself. Calling stopAutoRefresh()
   immediately (the previous version of this module) can complete before
   that ticker has even started, and initialize() then starts it anyway
   moments later — reproduced against the installed auth-js 2.117.1 with
   this app's own client options. The fake client below models exactly
   that: its ticker only flips on once `initialize()` itself resolves, on
   a later tick, independently of anything this module does — the same
   as the real background _initialize() call createClient() already
   kicked off before dispose-auth-attempt.js ever runs. */
test('waits for the client to finish initializing before stopping — a ticker that only starts once initialize() resolves is still stopped', async () => {
  let tickerRunning = false;
  // Models createClient()'s own already-in-flight background
  // initialize() call — nothing in this test ever calls `.initialize()`
  // itself to kick this off; it fires on its own, on a later tick,
  // exactly like the real one already would have by the time
  // disposeFailedAuthAttempt() runs.
  const backgroundInit = new Promise((resolve) => {
    setTimeout(() => {
      tickerRunning = true;
      resolve();
    }, 0);
  });
  const client = {
    auth: {
      // Same in-flight promise every call, like auth-js's own cached
      // `initializePromise` — calling this again must not restart
      // anything, only await what's already happening.
      initialize: () => backgroundInit,
      stopAutoRefresh: async () => {
        tickerRunning = false;
      },
    },
  };

  await disposeFailedAuthAttempt({ service: null, client, log: silentLog });
  // Give the background "ticker starts" tick every chance to have fired
  // by now, whether or not the code under test itself waited for it.
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(
    tickerRunning,
    false,
    'stopAutoRefresh() must run *after* the ticker has actually started, not before'
  );
});
