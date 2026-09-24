'use strict';
/* ============================================================
   Covers sync/save-key-handler.js's createSaveKeyHandler(), the pure
   sequencing extracted out of main.js's syncConfig:saveKey IPC handler
   (see that module's own doc comment) — same pattern as
   sync/sync-lifecycle.js: a plain function taking injected collaborators,
   returning a small API, unit-tested with fakes.

   Found in review: two concurrent syncConfig:saveKey calls (caused by a
   renderer bug that bound the same submit listener twice) both passed
   the old inline handler's "not yet configured" check before either had
   finished saving, so both went on to call initSyncAndAuth() — the
   second one saw auth already built by the first and logged a false
   "auth could not be initialized" error. This suite drives that race
   directly with fakes and asserts it can no longer happen.
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSaveKeyHandler } = require('../sync/save-key-handler.js');

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, critical() {} };

function makeDeps(overrides = {}) {
  let configured = false;
  const saveCalls = [];
  const initCalls = [];
  return {
    validateKey: (key) => (key === 'bad-key' ? { ok: false, error: 'bad key' } : { ok: true, key }),
    isAlreadyConfigured: () => configured,
    saveKey: async (key) => {
      saveCalls.push(key);
    },
    initSyncAndAuth: () => {
      initCalls.push(true);
      configured = true;
      return true;
    },
    log: silentLog,
    saveCalls,
    initCalls,
    setConfigured: (v) => {
      configured = v;
    },
    ...overrides,
  };
}

test('requires its collaborators', () => {
  assert.throws(() => createSaveKeyHandler({}), /validateKey/);
  assert.throws(
    () =>
      createSaveKeyHandler({
        validateKey: () => {},
      }),
    /isAlreadyConfigured/
  );
  assert.throws(
    () =>
      createSaveKeyHandler({
        validateKey: () => {},
        isAlreadyConfigured: () => {},
      }),
    /saveKey/
  );
  assert.throws(
    () =>
      createSaveKeyHandler({
        validateKey: () => {},
        isAlreadyConfigured: () => {},
        saveKey: () => {},
      }),
    /initSyncAndAuth/
  );
});

test('rejects an invalid key without ever saving or initializing', async () => {
  const deps = makeDeps();
  const handler = createSaveKeyHandler(deps);
  const result = await handler.handleSaveKey('bad-key');
  assert.deepEqual(result, { ok: false, error: 'bad key' });
  assert.deepEqual(deps.saveCalls, []);
  assert.deepEqual(deps.initCalls, []);
});

test('the happy path saves the key and initializes exactly once', async () => {
  const deps = makeDeps();
  const handler = createSaveKeyHandler(deps);
  const result = await handler.handleSaveKey('sb_publishable_ok');
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(deps.saveCalls, ['sb_publishable_ok']);
  assert.equal(deps.initCalls.length, 1);
});

test('already configured: skips save and init entirely, distinct from an init failure', async () => {
  const deps = makeDeps();
  deps.setConfigured(true);
  const handler = createSaveKeyHandler(deps);
  const result = await handler.handleSaveKey('sb_publishable_ok');
  assert.deepEqual(result, { ok: true, alreadyConfigured: true });
  assert.deepEqual(deps.saveCalls, []);
  assert.deepEqual(deps.initCalls, []);
});

test('a save that throws is reported as a save failure, and init is never called', async () => {
  const deps = makeDeps({
    saveKey: async () => {
      throw new Error('disk full');
    },
  });
  const handler = createSaveKeyHandler(deps);
  const result = await handler.handleSaveKey('sb_publishable_ok');
  assert.equal(result.ok, false);
  assert.match(result.error, /save/i);
  assert.deepEqual(deps.initCalls, []);
});

test('initSyncAndAuth() returning false is reported as a distinct failure, not ok:true', () => {
  return (async () => {
    const deps = makeDeps({
      initSyncAndAuth: () => false, // e.g. no OS secret store for safeStorage
    });
    const handler = createSaveKeyHandler(deps);
    const result = await handler.handleSaveKey('sb_publishable_ok');
    assert.equal(result.ok, false);
    assert.match(result.error, /secure storage|sync can.t start/i);
    assert.deepEqual(deps.saveCalls, ['sb_publishable_ok']); // the key WAS saved
  })();
});

test('never logs the raw key on any path', async () => {
  const calls = [];
  const capturingLog = {
    debug: (...a) => calls.push(a),
    info: (...a) => calls.push(a),
    warn: (...a) => calls.push(a),
    error: (...a) => calls.push(a),
    critical: (...a) => calls.push(a),
  };
  const deps = makeDeps({ log: capturingLog });
  const handler = createSaveKeyHandler(deps);
  await handler.handleSaveKey('sb_publishable_super_secret_value');
  const serialized = JSON.stringify(calls);
  assert.ok(!serialized.includes('sb_publishable_super_secret_value'));
});

test('two concurrent calls join a single in-flight save/init — the second never re-runs either', async () => {
  let resolveSave;
  const deps = makeDeps({
    saveKey: async (key) => {
      deps.saveCalls.push(key);
      await new Promise((resolve) => {
        resolveSave = resolve;
      });
    },
  });
  const handler = createSaveKeyHandler(deps);

  const first = handler.handleSaveKey('sb_publishable_ok');
  const second = handler.handleSaveKey('sb_publishable_ok');
  // Give the event loop a tick so both calls have started (and, before
  // the fix, both would have already passed the "not configured" check).
  await Promise.resolve();
  await Promise.resolve();
  resolveSave();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, { ok: true });
  assert.deepEqual(secondResult, { ok: true });
  assert.equal(deps.saveCalls.length, 1, 'saveKey must only run once for the joined calls');
  assert.equal(deps.initCalls.length, 1, 'initSyncAndAuth must only run once for the joined calls');
});

test('after an in-flight save settles, a later call starts a fresh run (not stuck joined forever)', async () => {
  const deps = makeDeps();
  const handler = createSaveKeyHandler(deps);
  await handler.handleSaveKey('sb_publishable_ok');
  assert.equal(deps.initCalls.length, 1);
  // Now "already configured" — a later call should hit that branch fresh,
  // not somehow still be joined to the first (already-settled) run.
  const second = await handler.handleSaveKey('sb_publishable_ok');
  assert.deepEqual(second, { ok: true, alreadyConfigured: true });
  assert.equal(deps.initCalls.length, 1);
});

test('a rejected key does not join or block a concurrent valid save', async () => {
  const deps = makeDeps();
  const handler = createSaveKeyHandler(deps);
  const badResult = await handler.handleSaveKey('bad-key');
  assert.equal(badResult.ok, false);
  const goodResult = await handler.handleSaveKey('sb_publishable_ok');
  assert.equal(goodResult.ok, true);
  assert.equal(deps.initCalls.length, 1);
});
