'use strict';
/* ============================================================
   WORK RADAR — integration tests: realtime sync trigger (Phase 6)
   Drives two real sync-engine instances — "two machines", same pattern
   as test/integration/sync-engine.test.js — but machine B never polls:
   its sync-state.json interval is effectively disabled (engine.start()
   is never called at all, so no 60s timer exists) and it never calls
   triggerNow() itself. The only thing that can make it pull is a real
   Supabase Realtime event delivered through sync/realtime.js, wired to
   the real public.items/public.log_entries changefeed — no fakes here;
   test/sync-realtime.test.js covers the module's own logic against a
   fake client/channel.

   Needs `npx supabase start` already running, with Realtime enabled
   (the default — see supabase/config.toml's [realtime] section) and
   both tables already in the supabase_realtime publication (see
   supabase/migrations/..._add_tables_to_realtime_publication.sql).

   Excluded from `npm test` — run via `npm run test:integration`.
   ============================================================ */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createClient } = require('@supabase/supabase-js');

const logger = require('../../logger.js');
const { createSyncEngine } = require('../../sync/sync-engine.js');
const { createRealtimeSync } = require('../../sync/realtime.js');
const { readJsonFile, writeJsonFileAtomic } = require('../../sync/atomic-json-file.js');

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, critical() {} };

// Same helper as the other integration suites — read fresh every run,
// never hardcoded (see the secrets rule).
function readLocalSupabaseConfig() {
  let raw;
  try {
    raw = execFileSync('npx', ['supabase', 'status', '-o', 'json'], { encoding: 'utf8' });
  } catch (err) {
    throw new Error(
      'Could not read `supabase status -o json` — is the local stack running ' +
        '(`npx supabase start`)? ' +
        err.message
    );
  }
  const status = JSON.parse(raw);
  if (!status.API_URL || !status.PUBLISHABLE_KEY || !status.SECRET_KEY) {
    throw new Error('supabase status did not include API_URL/PUBLISHABLE_KEY/SECRET_KEY');
  }
  return {
    url: status.API_URL,
    publishableKey: status.PUBLISHABLE_KEY,
    secretKey: status.SECRET_KEY,
  };
}

let admin;
let config;
let testUser;

before(async () => {
  config = readLocalSupabaseConfig();
  admin = createClient(config.url, config.secretKey);
  const email = `work-radar-realtime-${crypto.randomUUID()}@example.com`;
  const password = crypto.randomBytes(24).toString('hex');
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  testUser = { email, password, userId: data.user.id };
  logger.info('realtime integration test user created', { userId: testUser.userId });
});

after(async () => {
  if (!testUser) return;
  const { error } = await admin.auth.admin.deleteUser(testUser.userId);
  if (error) {
    logger.error('failed to clean up realtime integration test user', {
      err: error,
      userId: testUser.userId,
    });
  }
});

// A fresh supabase-js client, signed in as the one shared test user —
// each call is a new, independent session/socket, standing in for "a
// second device signed into the same account".
async function createMachineClient() {
  const client = createClient(config.url, config.publishableKey);
  const { error } = await client.auth.signInWithPassword({
    email: testUser.email,
    password: testUser.password,
  });
  if (error) throw error;
  return client;
}

// A "machine": its own tmp userData dir and its own signed-in
// client/engine — same shape as sync-engine.test.js's createMachine.
// `intervalMs` is set absurdly high (never fires within a test's
// lifetime) rather than left at the engine default, and engine.start()
// below is never called at all for the machine under test — the whole
// point of this suite is that realtime, not the interval, is what makes
// machine B pull.
async function createMachine(seedData) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wr-realtime-it-'));
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  await writeJsonFileAtomic(
    dataFilePath,
    seedData || { schema: 3, items: [], arch: [], lastExport: 0 }
  );
  const client = await createMachineClient();
  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    intervalMs: 24 * 60 * 60_000, // effectively disabled — see module doc above
    lookbackMs: 60_000,
  });
  return { dataFilePath, syncStateFilePath, engine, client };
}

async function getUserId(client) {
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data.session.user.id;
}

function item(id, overrides) {
  const now = Date.now();
  return {
    id,
    name: id,
    status: 'active',
    priority: 'medium',
    category: '',
    notes: '',
    addedAt: now,
    updatedAt: now,
    reviewedAt: now,
    log: [],
    ...overrides,
  };
}

async function readData(dataFilePath) {
  return (await readJsonFile(dataFilePath)) || { items: [], arch: [] };
}

function findItem(data, id) {
  return [...(data.items || []), ...(data.arch || [])].find((i) => i.id === id);
}

// Polls instead of a fixed sleep — Realtime delivery over the local
// stack is normally near-instant, but CI/dev-box scheduling jitter can
// make a fixed delay flaky in either direction. Generous ceiling since
// this is a real network round trip through the local Realtime service.
// `predicate` may be sync or async — always awaited, so an async
// predicate's pending Promise (always truthy on its own) never makes
// the loop condition below exit before the real result is in.
async function waitFor(predicate, message, timeoutMs = 15_000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Wraps a machine's realtime.subscribe() the same way main.js wires it
// (onChange -> engine.triggerNow()), but also remembers the promise the
// *latest* call kicked off — a caller can then await that specific pull
// settling, rather than only observing that *a* call happened (found in
// review: the tests otherwise wrote to machine A right after seeing the
// SUBSCRIBED catch-up call start, not after it actually finished).
function wireRealtime(client, engine) {
  const state = { calls: 0, lastCycle: Promise.resolve() };
  const realtime = createRealtimeSync({
    client,
    log: silentLog,
    onChange: () => {
      state.calls += 1;
      // Chained onto the previous cycle rather than reassigned outright
      // (found in review): triggerNow() only starts a new cycle when
      // none is running — if one already is, it just sets
      // `rerunRequested` and resolves immediately, so a bare
      // `state.lastCycle = engine.triggerNow()` could replace the
      // in-flight cycle's promise with one that's already settled while
      // the real work is still going. Chaining means `state.lastCycle`
      // always still resolves only once every cycle this triggered,
      // including the eventual rerun, has actually finished.
      state.lastCycle = state.lastCycle.then(() => engine.triggerNow());
      return state.lastCycle;
    },
  });
  return { realtime, state };
}

test('machine B picks up machine A change via realtime, with its own interval effectively disabled', async () => {
  const m1 = await createMachine();
  const m2 = await createMachine();
  let realtime2 = null;
  let state = null;

  // Pushes (or re-pushes) RT-A from machine A with a fresh updatedAt —
  // a real outbox change each time, not a no-op re-send — so a dropped
  // realtime event can be retried by giving the changefeed another,
  // genuinely new row version to publish.
  async function pushRtA() {
    await m1.engine.recordLocalSave({
      schema: 3,
      items: [item('RT-A', { updatedAt: Date.now(), name: 'created on machine 1' })],
      arch: [],
      lastExport: 0,
    });
    await m1.engine.triggerNow();
  }

  try {
    const userId2 = await getUserId(m2.client);
    ({ realtime: realtime2, state } = wireRealtime(m2.client, m2.engine));
    realtime2.subscribe(userId2);

    // Wait for the SUBSCRIBED catch-up pull (nothing to pull yet — the
    // point is just to know the channel is actually live before machine
    // A's change happens, so the test isn't racing the subscribe itself),
    // and let that pull actually finish before writing — not just start.
    await waitFor(() => state.calls >= 1, 'realtime channel to report SUBSCRIBED');
    await state.lastCycle;

    const before = state.calls;
    await pushRtA();

    // Machine B never calls triggerNow() itself and never started its
    // own interval — only a realtime-driven pull can make this appear.
    // realtime-js can report SUBSCRIBED slightly before the server-side
    // replication slot is fully attached, which can drop the very first
    // change published right after subscribe — re-push on each poll
    // that still finds nothing, rather than let that show up as an
    // opaque 15s timeout (found in review).
    await waitFor(async () => {
      const data = await readData(m2.dataFilePath);
      if (findItem(data, 'RT-A')) return true;
      await pushRtA();
      return false;
    }, 'machine B to have pulled RT-A after a realtime event');

    const data2 = await readData(m2.dataFilePath);
    assert.equal(findItem(data2, 'RT-A').name, 'created on machine 1');
    assert.ok(state.calls > before, 'the table-change event must have triggered a pull');
  } finally {
    if (realtime2) realtime2.unsubscribe();
    // unsubscribe() only tears down the channel — a realtime-triggered
    // triggerNow() it kicked off keeps running on its own. stop() first
    // (so no new retry/rerun gets scheduled), then await that last cycle
    // so it can't still be mid-flight against a deleted user after this
    // test's after() hook runs (found in review).
    m2.engine.stop();
    if (state) await state.lastCycle.catch(() => {});
    // Machine A's engine is also stopped (found in review): every
    // pushRtA() call goes through recordLocalSave(), which arms a 3s
    // debounce timer. The last one otherwise outlives this test and can
    // fire during the next test, or mid-cleanup once `after()` has
    // already deleted the shared user, and keeps the process alive for
    // up to 3s regardless.
    m1.engine.stop();
    // Close the underlying websocket outright, not just the channel —
    // otherwise the open realtime socket keeps this test file's process
    // alive after the last assertion runs.
    await m1.client.realtime.disconnect();
    await m2.client.realtime.disconnect();
  }
});

test('a log entry added on machine A is also picked up by machine B via realtime', async () => {
  const t0 = Date.now();
  const shared = item('RT-B', { updatedAt: t0, name: 'shared item' });
  const m1 = await createMachine({ schema: 3, items: [shared], arch: [], lastExport: 0 });
  await m1.engine.triggerNow(); // push RT-B so machine B has something to pull first

  const m2 = await createMachine();
  await m2.engine.triggerNow(); // ordinary pull: seed machine B with RT-B before subscribing
  assert.ok(findItem(await readData(m2.dataFilePath), 'RT-B'), 'setup: machine B must have RT-B');

  let realtime2 = null;
  let state = null;

  // Same idea as the previous test's pushRtA(): a fresh log entry id
  // each call, so a retry is a genuinely new row version for the
  // changefeed to publish, not a no-op re-send.
  async function pushLogEntry() {
    const withEntry = {
      ...findItem(await readData(m1.dataFilePath), 'RT-B'),
      log: [{ id: crypto.randomUUID(), ts: Date.now(), text: 'note from machine 1' }],
    };
    await m1.engine.recordLocalSave({
      schema: 3,
      items: [withEntry],
      arch: [],
      lastExport: 0,
    });
    await m1.engine.triggerNow();
  }

  try {
    const userId2 = await getUserId(m2.client);
    ({ realtime: realtime2, state } = wireRealtime(m2.client, m2.engine));
    realtime2.subscribe(userId2);
    await waitFor(() => state.calls >= 1, 'realtime channel to report SUBSCRIBED');
    await state.lastCycle;

    await pushLogEntry();

    await waitFor(async () => {
      const data = await readData(m2.dataFilePath);
      const found = findItem(data, 'RT-B');
      if (found && found.log.some((e) => e.text === 'note from machine 1')) return true;
      // See the previous test's comment: SUBSCRIBED can arrive slightly
      // before the replication slot is fully attached, dropping the
      // first change published right after — retry rather than time out
      // opaquely.
      await pushLogEntry();
      return false;
    }, 'machine B to have pulled the new log entry after a realtime event');
  } finally {
    if (realtime2) realtime2.unsubscribe();
    m2.engine.stop();
    if (state) await state.lastCycle.catch(() => {});
    // See the previous test's comment: machine A's own debounce timer
    // (armed by every pushLogEntry()'s recordLocalSave()) otherwise
    // outlives this test.
    m1.engine.stop();
    await m1.client.realtime.disconnect();
    await m2.client.realtime.disconnect();
  }
});
