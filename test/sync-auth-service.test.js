'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAuthService } = require('../sync/auth-service.js');

// A no-op logger so tests don't spam stdout/stderr with the module's own
// structured logs (the real logger is exercised implicitly — this only
// swaps *where* the lines go).
const silentLog = { debug() {}, info() {}, warn() {}, error() {}, critical() {} };

// A controllable fake standing in for the real supabase-js client. Each
// method is overridable per test via `overrides`; the default behaviour
// is the "everything succeeds" happy path.
function makeFakeClient(overrides = {}) {
  let changeCallback = null;
  const calls = { signInWithOtp: [], exchangeCodeForSession: [], signOut: [], getSession: [] };
  const unsubscribe = () => {
    calls.unsubscribed = true;
  };
  const client = {
    auth: {
      onAuthStateChange(cb) {
        changeCallback = cb;
        return { data: { subscription: { unsubscribe } } };
      },
      async signInWithOtp(args) {
        calls.signInWithOtp.push(args);
        return overrides.signInWithOtp ? overrides.signInWithOtp(args) : { data: {}, error: null };
      },
      async exchangeCodeForSession(code, options) {
        calls.exchangeCodeForSession.push({ code, options });
        return overrides.exchangeCodeForSession
          ? overrides.exchangeCodeForSession(code, options)
          : { data: { session: { user: { email: 'a@example.com' } } }, error: null };
      },
      async getSession() {
        calls.getSession.push(true);
        return overrides.getSession
          ? overrides.getSession()
          : { data: { session: null }, error: null };
      },
      async signOut() {
        calls.signOut.push(true);
        return overrides.signOut ? overrides.signOut() : { error: null };
      },
    },
  };
  return { client, calls, fireChange: (event, session) => changeCallback(event, session) };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// A fake standing in for sync/callback-server.js's waitForCallback(), which
// returns { listening, result, cancel } rather than a single promise (see
// its doc comment). `resultValue`/`resultError` control what `result`
// settles with; `listeningError` makes `listening` (and, in turn, `result`)
// reject instead, simulating a bind failure (EADDRINUSE).
function fakeWaitForCallback({ resultValue, resultError, listeningError, onCancel } = {}) {
  const calls = [];
  function waitForCallback() {
    calls.push(true);
    if (listeningError) {
      const result = Promise.reject(listeningError);
      result.catch(() => {});
      return { listening: Promise.reject(listeningError), result, cancel: () => {} };
    }
    const result = resultError ? Promise.reject(resultError) : Promise.resolve(resultValue);
    result.catch(() => {});
    return { listening: Promise.resolve(), result, cancel: onCancel || (() => {}) };
  }
  return { waitForCallback, calls };
}

// A fake whose `listening`/`result` are controlled by the caller via the
// returned deferreds, for tests that need to observe ordering (e.g. "OTP
// isn't called until listening resolves").
function controllableWaitForCallback() {
  const listeningGate = deferred();
  const resultGate = deferred();
  const calls = [];
  let cancelled = false;
  function waitForCallback() {
    calls.push(true);
    resultGate.promise.catch(() => {});
    return {
      listening: listeningGate.promise,
      result: resultGate.promise,
      cancel: () => {
        cancelled = true;
      },
    };
  }
  return {
    waitForCallback,
    calls,
    resolveListening: listeningGate.resolve,
    rejectListening: listeningGate.reject,
    resolveResult: resultGate.resolve,
    rejectResult: resultGate.reject,
    wasCancelled: () => cancelled,
  };
}

test('getStatus reports signed out and not pending when there is no session', async () => {
  const { client } = makeFakeClient();
  const { waitForCallback } = fakeWaitForCallback({ resultValue: { code: 'unused' } });
  const service = createAuthService({
    client,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });
  assert.deepEqual(await service.getStatus(), {
    signedIn: false,
    email: null,
    userId: null,
    pending: false,
  });
});

test('getStatus reports the signed-in email when a session exists', async () => {
  const { client } = makeFakeClient({
    getSession: async () => ({
      data: { session: { user: { email: 'me@example.com' } } },
      error: null,
    }),
  });
  const { waitForCallback } = fakeWaitForCallback({ resultValue: { code: 'unused' } });
  const service = createAuthService({
    client,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });
  assert.deepEqual(await service.getStatus(), {
    signedIn: true,
    email: 'me@example.com',
    userId: null,
    pending: false,
  });
});

// New: the whole point of carrying userId on the status is that a
// realtime subscribe (main.js/sync/sync-lifecycle.js) can use it directly
// off this same push instead of a separate getSession() read — see
// toStatus()'s own doc comment above (found in review — Phase 6).
test('getStatus and onChange both carry the signed-in session userId', async () => {
  const { client, fireChange } = makeFakeClient({
    getSession: async () => ({
      data: { session: { user: { id: 'user-abc', email: 'me@example.com' } } },
      error: null,
    }),
  });
  const { waitForCallback } = fakeWaitForCallback({ resultValue: { code: 'unused' } });
  const service = createAuthService({
    client,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });
  assert.deepEqual(await service.getStatus(), {
    signedIn: true,
    email: 'me@example.com',
    userId: 'user-abc',
    pending: false,
  });

  const seen = [];
  service.onChange((status) => seen.push(status));
  fireChange('SIGNED_IN', { user: { id: 'user-xyz', email: 'other@example.com' } });
  assert.deepEqual(seen, [
    { signedIn: true, email: 'other@example.com', userId: 'user-xyz', pending: false },
  ]);
});

test('getStatus treats a getSession error as signed-out rather than throwing', async () => {
  const { client } = makeFakeClient({
    getSession: async () => ({ data: { session: null }, error: new Error('boom') }),
  });
  const { waitForCallback } = fakeWaitForCallback({ resultValue: { code: 'unused' } });
  const service = createAuthService({
    client,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });
  assert.deepEqual(await service.getStatus(), {
    signedIn: false,
    email: null,
    userId: null,
    pending: false,
  });
});

test('signIn runs signInWithOtp -> waitForCallback -> exchangeCodeForSession in order', async () => {
  const { client, calls } = makeFakeClient();
  const { waitForCallback } = fakeWaitForCallback({
    resultValue: { code: 'the-code', flowId: null },
  });
  const service = createAuthService({
    client,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });
  await service.signIn('person@example.com');

  assert.equal(calls.signInWithOtp.length, 1);
  assert.deepEqual(calls.signInWithOtp[0], {
    email: 'person@example.com',
    options: {
      emailRedirectTo: 'http://127.0.0.1:54390/auth/callback',
      shouldCreateUser: false,
    },
  });
  assert.equal(calls.exchangeCodeForSession.length, 1);
  assert.equal(calls.exchangeCodeForSession[0].code, 'the-code');
  assert.equal(calls.exchangeCodeForSession[0].options, undefined);
});

test('signIn passes sb_flow_id through to exchangeCodeForSession as { flowId }', async () => {
  const { client, calls } = makeFakeClient();
  const { waitForCallback } = fakeWaitForCallback({
    resultValue: { code: 'the-code', flowId: 'flow-xyz' },
  });
  const service = createAuthService({
    client,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });
  await service.signIn('person@example.com');
  assert.deepEqual(calls.exchangeCodeForSession[0], {
    code: 'the-code',
    options: { flowId: 'flow-xyz' },
  });
});

test('signIn reports pending:true (and no email) as soon as it starts', async () => {
  const { client } = makeFakeClient();
  const c = controllableWaitForCallback();
  const service = createAuthService({
    client,
    waitForCallback: c.waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });

  const seen = [];
  service.onChange((status) => seen.push(status));
  const signInPromise = service.signIn('person@example.com');

  assert.deepEqual(await service.getStatus(), {
    signedIn: false,
    email: null,
    userId: null,
    pending: true,
  });
  assert.deepEqual(seen[0], { signedIn: false, email: null, userId: null, pending: true });

  c.resolveListening();
  c.resolveResult({ code: 'x', flowId: null });
  await signInPromise;
  assert.deepEqual(await service.getStatus(), {
    signedIn: false,
    email: null,
    userId: null,
    pending: false,
  });
});

test('signIn binds the loopback listener before calling signInWithOtp, and never sends the email if binding fails', async () => {
  const { client, calls } = makeFakeClient();
  const listeningError = Object.assign(new Error('Port 54390 is in use — close it and try again'), {
    code: 'EADDRINUSE',
  });
  const { waitForCallback } = fakeWaitForCallback({ listeningError });
  const service = createAuthService({
    client,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });
  await assert.rejects(service.signIn('person@example.com'), /in use/);
  assert.equal(calls.signInWithOtp.length, 0, 'signInWithOtp must never run when binding fails');
});

test('signIn cancels the loopback listener when signInWithOtp errors, and never waits for a callback', async () => {
  let cancelled = false;
  const { client } = makeFakeClient({
    signInWithOtp: async () => ({ data: null, error: new Error('rate limited') }),
  });
  const { waitForCallback } = fakeWaitForCallback({
    resultValue: { code: 'unused' },
    onCancel: () => {
      cancelled = true;
    },
  });
  const service = createAuthService({
    client,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });
  await assert.rejects(service.signIn('person@example.com'), /rate limited/);
  assert.equal(cancelled, true, 'the loopback listener must be cancelled, not left running');
});

test('signIn throws when the loopback callback rejects (error or timeout)', async () => {
  const { client } = makeFakeClient();
  const { waitForCallback } = fakeWaitForCallback({
    resultError: new Error('no callback received within the sign-in window'),
  });
  const service = createAuthService({
    client,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });
  await assert.rejects(service.signIn('person@example.com'), /sign-in window/);
});

// Found in review: this is the most common failure path (a Supabase
// `?error=` redirect, a timeout, or a cancel), and until this test, only
// the callback server's own log line (no attemptId) and main.js's generic
// "sign-in failed" (no attemptId) ever recorded it — no line correlated
// the failure with the rest of this attempt's logs via attemptId.
test('signIn logs a loopback callback failure with the attempt id', async () => {
  const { client } = makeFakeClient();
  const { waitForCallback } = fakeWaitForCallback({
    resultError: new Error('no callback received within the sign-in window'),
  });
  const errorCalls = [];
  const capturingLog = { ...silentLog, error: (...args) => errorCalls.push(args) };
  const service = createAuthService({
    client,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: capturingLog,
  });
  await assert.rejects(service.signIn('person@example.com'), /sign-in window/);
  const callbackFailureCalls = errorCalls.filter(([msg]) => msg === 'loopback callback failed');
  assert.equal(callbackFailureCalls.length, 1);
  const [, context] = callbackFailureCalls[0];
  assert.equal(typeof context.attemptId, 'string');
  assert.ok(context.attemptId.length > 0);
  assert.match(context.err.message, /sign-in window/);
});

test('signIn throws when exchangeCodeForSession errors', async () => {
  const { client } = makeFakeClient({
    exchangeCodeForSession: async () => ({ data: null, error: new Error('bad code') }),
  });
  const { waitForCallback } = fakeWaitForCallback({ resultValue: { code: 'x', flowId: null } });
  const service = createAuthService({
    client,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });
  await assert.rejects(service.signIn('person@example.com'), /bad code/);
});

test('signIn refuses to start when a session is already signed in', async () => {
  const { client } = makeFakeClient({
    getSession: async () => ({
      data: { session: { user: { email: 'already@example.com' } } },
      error: null,
    }),
  });
  const { waitForCallback, calls } = fakeWaitForCallback({ resultValue: { code: 'unused' } });
  const service = createAuthService({
    client,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });
  await assert.rejects(service.signIn('person@example.com'), /already signed in/);
  assert.equal(calls.length, 0, 'must not start a loopback wait when already signed in');
});

test('signIn (failure path) pushes the settled pending:false status after the rejection, never before', async () => {
  // Pins the ordering renderer/auth-view.js's fix depends on: the IPC
  // reply carrying signIn()'s rejection reaches the renderer before the
  // settled onChange push — see docs/supabase-sync-plan.md's Phase 3
  // "Renderer" notes and test/auth-view.test.js.
  const { client } = makeFakeClient({
    signInWithOtp: async () => ({ data: null, error: new Error('rate limited') }),
  });
  const { waitForCallback } = fakeWaitForCallback({ resultValue: { code: 'unused' } });
  const service = createAuthService({
    client,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });
  const order = [];
  service.onChange((status) => order.push({ push: status }));
  await service.signIn('person@example.com').catch((err) => order.push({ rejected: err.message }));
  assert.deepEqual(order, [
    { push: { signedIn: false, email: null, userId: null, pending: true } },
    { rejected: 'rate limited' },
    { push: { signedIn: false, email: null, userId: null, pending: false } },
  ]);
});

test('signIn (success path) pushes the settled signedIn:true status after resolving', async () => {
  // Stateful: no session until exchangeCodeForSession has actually run —
  // a real client wouldn't report signed-in before that, and signIn()
  // now checks getStatus() up front too (see the "already signed in"
  // test above), so a client that's always signed in would reject this
  // call before it ever starts.
  let exchanged = false;
  const { client } = makeFakeClient({
    exchangeCodeForSession: async (_code, _options) => {
      exchanged = true;
      return { data: { session: { user: { email: 'me@example.com' } } }, error: null };
    },
    getSession: async () =>
      exchanged
        ? { data: { session: { user: { email: 'me@example.com' } } }, error: null }
        : { data: { session: null }, error: null },
  });
  const { waitForCallback } = fakeWaitForCallback({ resultValue: { code: 'x', flowId: null } });
  const service = createAuthService({
    client,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });
  const seen = [];
  service.onChange((status) => seen.push(status));
  await service.signIn('person@example.com');
  // The finally block's settled push is fired-and-forgotten (it awaits its
  // own getStatus() after signIn() has already resolved) — flush past it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen[seen.length - 1], {
    signedIn: true,
    email: 'me@example.com',
    userId: null,
    pending: false,
  });
});

test('a second signIn call while one is pending is rejected without starting a new callback wait', async () => {
  const c = controllableWaitForCallback();
  const { client } = makeFakeClient();
  const service = createAuthService({
    client,
    waitForCallback: c.waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });

  const first = service.signIn('person@example.com');
  await assert.rejects(service.signIn('other@example.com'), /already pending/);
  assert.equal(c.calls.length, 1, 'the second call must not start its own loopback wait');

  c.resolveListening();
  c.resolveResult({ code: 'x', flowId: null });
  await first;
});

test('signIn does not call cancel() when the loopback listener itself fails to bind', async () => {
  const c = controllableWaitForCallback();
  const { client, calls } = makeFakeClient();
  const service = createAuthService({
    client,
    waitForCallback: c.waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });
  const bindError = Object.assign(new Error('Port 54390 is in use — close it and try again'), {
    code: 'EADDRINUSE',
  });
  const signInPromise = service.signIn('person@example.com');
  c.rejectListening(bindError);
  await assert.rejects(signInPromise, /in use/);
  assert.equal(calls.signInWithOtp.length, 0);
  // cancel() is only for a *post-bind* failure (signInWithOtp erroring
  // after the listener is already up) — a bind failure has nothing
  // running to cancel, so it must stay false here.
  assert.equal(
    c.wasCancelled(),
    false,
    'cancel() must not be called when binding itself is what failed'
  );
});

test('signIn can run again after a previous attempt finished', async () => {
  const { client, calls } = makeFakeClient();
  const { waitForCallback } = fakeWaitForCallback({ resultValue: { code: 'x', flowId: null } });
  const service = createAuthService({
    client,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });
  await service.signIn('person@example.com');
  await service.signIn('person@example.com');
  assert.equal(calls.signInWithOtp.length, 2);
});

test('signOut calls client.auth.signOut', async () => {
  const { client: okClient, calls } = makeFakeClient();
  const { waitForCallback } = fakeWaitForCallback({ resultValue: { code: 'x', flowId: null } });
  const okService = createAuthService({
    client: okClient,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });
  await okService.signOut();
  assert.equal(calls.signOut.length, 1);
});

// auth-js's own _signOut clears the local session even when the server
// call fails with a network error, and still returns that error (found
// in review). Throwing anyway would make main.js log "sign-out failed"
// and a menu click surface an error, although the user really is signed
// out locally — so a signOut error is only a hard failure if the local
// session is *still* there afterwards.
test('signOut treats a server error as a warning when the local session is already cleared', async () => {
  const { client, calls } = makeFakeClient({
    signOut: async () => ({ error: new Error('network down') }),
    // Default getSession() already reports no session — mirrors auth-js
    // clearing local storage before returning the network error.
  });
  const { waitForCallback } = fakeWaitForCallback({ resultValue: { code: 'x', flowId: null } });
  const service = createAuthService({
    client,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });
  await service.signOut(); // must not throw
  assert.equal(calls.signOut.length, 1);
});

test('signOut still throws when the local session is still present after a server error', async () => {
  const { client } = makeFakeClient({
    signOut: async () => ({ error: new Error('network down') }),
    getSession: async () => ({
      data: { session: { user: { email: 'x@example.com' } } },
      error: null,
    }),
  });
  const { waitForCallback } = fakeWaitForCallback({ resultValue: { code: 'x', flowId: null } });
  const service = createAuthService({
    client,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });
  await assert.rejects(service.signOut(), /network down/);
});

test('onChange forwards auth state changes and unsubscribing stops future calls', async () => {
  const { client, fireChange } = makeFakeClient();
  const { waitForCallback } = fakeWaitForCallback({ resultValue: { code: 'x', flowId: null } });
  const service = createAuthService({
    client,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });

  const seen = [];
  const off = service.onChange((status) => seen.push(status));

  fireChange('SIGNED_IN', { user: { email: 'me@example.com' } });
  assert.deepEqual(seen, [
    { signedIn: true, email: 'me@example.com', userId: null, pending: false },
  ]);

  off();
  fireChange('SIGNED_OUT', null);
  assert.deepEqual(
    seen,
    [{ signedIn: true, email: 'me@example.com', userId: null, pending: false }],
    'no call after unsubscribing'
  );
});

test('dispose unsubscribes from the underlying client and clears listeners', () => {
  const { client, calls, fireChange } = makeFakeClient();
  const { waitForCallback } = fakeWaitForCallback({ resultValue: { code: 'x', flowId: null } });
  const service = createAuthService({
    client,
    waitForCallback,
    redirectTo: 'http://127.0.0.1:54390/auth/callback',
    log: silentLog,
  });
  const seen = [];
  service.onChange((status) => seen.push(status));
  service.dispose();
  assert.equal(calls.unsubscribed, true);
  // The underlying fake doesn't actually stop delivering, but dispose()
  // must at least have cleared this service's own listener set.
  fireChange('SIGNED_OUT', null);
  assert.deepEqual(seen, []);
});
