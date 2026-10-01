'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSyncLifecycle } = require('../sync/sync-lifecycle.js');

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, critical() {} };

function spyLog() {
  const calls = { debug: [], info: [], warn: [], error: [], critical: [] };
  const log = {};
  Object.keys(calls).forEach((level) => {
    log[level] = (...args) => calls[level].push(args);
  });
  return { log, calls };
}

function fakeEngine() {
  const calls = { start: 0, stop: 0 };
  return { calls, start: () => calls.start++, stop: () => calls.stop++ };
}

function fakeRealtime({ subscribeThrows } = {}) {
  const calls = { subscribe: [], unsubscribe: 0 };
  return {
    calls,
    subscribe: (userId) => {
      calls.subscribe.push(userId);
      if (subscribeThrows) throw subscribeThrows;
    },
    unsubscribe: () => calls.unsubscribe++,
  };
}

function signedIn(userId) {
  return { signedIn: true, email: 'a@example.com', userId, pending: false };
}
const signedOut = { signedIn: false, email: null, userId: null, pending: false };

test('a signed-in status starts the engine and subscribes realtime with the status userId', () => {
  const engine = fakeEngine();
  const realtime = fakeRealtime();
  const lifecycle = createSyncLifecycle({ engine, realtime, log: silentLog });

  lifecycle.handleAuthStatus(signedIn('user-1'));

  assert.equal(engine.calls.start, 1);
  assert.deepEqual(realtime.calls.subscribe, ['user-1']);
  assert.equal(lifecycle.isRunning(), true);
});

test('signedIn immediately followed by signedOut leaves no channel subscribed (no async gap to race)', () => {
  const engine = fakeEngine();
  const realtime = fakeRealtime();
  const lifecycle = createSyncLifecycle({ engine, realtime, log: silentLog });

  lifecycle.handleAuthStatus(signedIn('user-1'));
  lifecycle.handleAuthStatus(signedOut);

  assert.deepEqual(realtime.calls.subscribe, ['user-1']);
  assert.equal(realtime.calls.unsubscribe, 1);
  assert.equal(engine.calls.stop, 1);
  assert.equal(lifecycle.isRunning(), false);
});

test('a second signedIn event while already running (e.g. TOKEN_REFRESHED) does not re-subscribe', () => {
  const engine = fakeEngine();
  const realtime = fakeRealtime();
  const lifecycle = createSyncLifecycle({ engine, realtime, log: silentLog });

  lifecycle.handleAuthStatus(signedIn('user-1'));
  lifecycle.handleAuthStatus(signedIn('user-1')); // e.g. hourly TOKEN_REFRESHED

  assert.equal(engine.calls.start, 2, 'start() is idempotent, safe to call every time');
  assert.deepEqual(
    realtime.calls.subscribe,
    ['user-1'],
    'subscribe must only run on the transition'
  );
});

test('signedOut while never running is a harmless no-op', () => {
  const engine = fakeEngine();
  const realtime = fakeRealtime();
  const lifecycle = createSyncLifecycle({ engine, realtime, log: silentLog });

  lifecycle.handleAuthStatus(signedOut);

  assert.equal(engine.calls.stop, 0);
  assert.equal(realtime.calls.unsubscribe, 0);
});

test('sign-out then sign-in as someone else subscribes the new userId', () => {
  const engine = fakeEngine();
  const realtime = fakeRealtime();
  const lifecycle = createSyncLifecycle({ engine, realtime, log: silentLog });

  lifecycle.handleAuthStatus(signedIn('user-1'));
  lifecycle.handleAuthStatus(signedOut);
  lifecycle.handleAuthStatus(signedIn('user-2'));

  assert.deepEqual(realtime.calls.subscribe, ['user-1', 'user-2']);
  assert.equal(lifecycle.isRunning(), true);
});

test('a signedIn status with no userId still starts the engine, but logs instead of subscribing', () => {
  const engine = fakeEngine();
  const realtime = fakeRealtime();
  const { log, calls: logCalls } = spyLog();
  const lifecycle = createSyncLifecycle({ engine, realtime, log });

  lifecycle.handleAuthStatus({
    signedIn: true,
    email: 'a@example.com',
    userId: null,
    pending: false,
  });

  assert.equal(engine.calls.start, 1);
  assert.deepEqual(realtime.calls.subscribe, []);
  assert.equal(logCalls.warn.length, 1);
  // The user's email is PII and must never land in structured logs (found
  // in review) — the rest of the codebase deliberately avoids logging it
  // (see main.js's auth:signIn handler and auth-service.js), and this
  // defensive warn must not be the exception.
  const [, warnContext] = logCalls.warn[0];
  assert.ok(!('email' in (warnContext || {})), 'warn context must not carry an email key');
});

test('signedIn(user-1) followed by signedIn(user-2) while running re-subscribes to user-2', () => {
  const engine = fakeEngine();
  const realtime = fakeRealtime();
  const lifecycle = createSyncLifecycle({ engine, realtime, log: silentLog });

  lifecycle.handleAuthStatus(signedIn('user-1'));
  lifecycle.handleAuthStatus(signedIn('user-2'));

  assert.deepEqual(realtime.calls.subscribe, ['user-1', 'user-2']);
  assert.equal(lifecycle.isRunning(), true);
});

// The same gap applies when the first signedIn status carried no userId
// at all (the defensive case above): a later status that does carry one
// must subscribe then, not wait for a sign-out/sign-in cycle.
test('signedIn with no userId followed by signedIn with a userId subscribes once the userId is known', () => {
  const engine = fakeEngine();
  const realtime = fakeRealtime();
  const lifecycle = createSyncLifecycle({ engine, realtime, log: silentLog });

  lifecycle.handleAuthStatus({
    signedIn: true,
    email: 'a@example.com',
    userId: null,
    pending: false,
  });
  lifecycle.handleAuthStatus(signedIn('user-1'));

  assert.deepEqual(realtime.calls.subscribe, ['user-1']);
  assert.equal(lifecycle.isRunning(), true);
});

test('createSyncLifecycle requires an engine and a realtime sync', () => {
  assert.throws(() => createSyncLifecycle({ realtime: fakeRealtime() }), /engine/);
  assert.throws(() => createSyncLifecycle({ engine: fakeEngine() }), /realtime/);
});

test('a subscribe() that throws is caught and logged with userId context, and does not mark the user as subscribed', () => {
  const engine = fakeEngine();
  const boom = new Error('channel() blew up');
  const realtime = fakeRealtime({ subscribeThrows: boom });
  const { log, calls: logCalls } = spyLog();
  const lifecycle = createSyncLifecycle({ engine, realtime, log });

  assert.doesNotThrow(() => lifecycle.handleAuthStatus(signedIn('user-1')));

  assert.equal(engine.calls.start, 1, 'sync itself still starts — only realtime failed');
  assert.equal(lifecycle.isRunning(), true);
  assert.equal(logCalls.error.length, 1);
  const [, ctx] = logCalls.error[0];
  assert.equal(ctx.userId, 'user-1');
  assert.equal(ctx.err, boom);
});

// Since subscribedUserId was never actually set, a later signedIn event
// for the same user (e.g. the next TOKEN_REFRESHED) must retry the
// subscribe rather than treat it as an already-subscribed no-op — see
// the "does not re-subscribe" test above for the happy-path contrast.
test('after a throwing subscribe(), the next signed-in event for the same user retries it', () => {
  const engine = fakeEngine();
  const realtime = fakeRealtime({ subscribeThrows: new Error('boom') });
  const lifecycle = createSyncLifecycle({ engine, realtime, log: silentLog });

  lifecycle.handleAuthStatus(signedIn('user-1'));
  lifecycle.handleAuthStatus(signedIn('user-1')); // e.g. TOKEN_REFRESHED

  assert.deepEqual(realtime.calls.subscribe, ['user-1', 'user-1']);
});
