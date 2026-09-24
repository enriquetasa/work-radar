'use strict';
/* ============================================================
   WORK RADAR — integration tests: sync engine (Phases 4-5)
   Drives two independent sync engine instances — "two machines" —
   against the LOCAL Supabase stack, signed in as the same user (two
   independent sessions, the way two real devices would be), each with
   its own tmp userData directory. No fakes here: these use the engine's
   real default push/pull implementations (buildDefaultPushRpc/
   buildDefaultPullPage in sync/sync-engine.js) against the real
   push_items/push_log_entries RPCs and a real select('*') pull — the
   unit tests in test/sync-engine.test.js cover the engine's logic with
   fakes; this covers the wiring to the actual database.

   Needs `npx supabase start` already running. Never targets a hosted
   project — URL/keys are read fresh from `supabase status -o json`
   every run (see the secrets rule), same pattern as
   test/integration/sync.test.js and auth.test.js.

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
const D = require('../../renderer/domain.js');
const { createSyncEngine } = require('../../sync/sync-engine.js');
const { readJsonFile, writeJsonFileAtomic } = require('../../sync/atomic-json-file.js');

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, critical() {} };

// Same helper as the other integration suites — see their module doc
// comments for why this is read fresh every run rather than hardcoded.
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
  const email = `work-radar-sync-engine-${crypto.randomUUID()}@example.com`;
  const password = crypto.randomBytes(24).toString('hex');
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  testUser = { email, password, userId: data.user.id };
  logger.info('sync-engine integration test user created', { userId: testUser.userId });
});

after(async () => {
  if (!testUser) return;
  const { error } = await admin.auth.admin.deleteUser(testUser.userId);
  if (error) {
    logger.error('failed to clean up sync-engine integration test user', {
      err: error,
      userId: testUser.userId,
    });
  }
});

// A fresh supabase-js client, signed in as the one shared test user —
// each call is a new, independent session, standing in for "a second
// device signed into the same account".
async function createMachineClient() {
  const client = createClient(config.url, config.publishableKey);
  const { error } = await client.auth.signInWithPassword({
    email: testUser.email,
    password: testUser.password,
  });
  if (error) throw error;
  return client;
}

// A "machine": its own tmp userData dir (data file + sync-state.json)
// and its own signed-in client/engine. `seedData` is what that machine
// already had locally, offline, before it ever synced. `engineOptions`
// overrides/extends the engine config (e.g. `pullPageSize`, to exercise
// pagination against the real database).
async function createMachine(seedData, engineOptions = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wr-sync-engine-it-'));
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
    // Generous relative to how fast these tests actually run, but far
    // shorter than the 5-minute default so a pull's lookback window
    // doesn't need to be tuned per assertion.
    lookbackMs: 60_000,
    ...engineOptions,
  });
  return { dataFilePath, syncStateFilePath, engine, client };
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

test('two machines with independent offline edits converge to identical state after syncing', async () => {
  const t0 = Date.now();
  const m1 = await createMachine({
    schema: 3,
    items: [item('A', { updatedAt: t0, name: 'from machine 1' })],
    arch: [],
    lastExport: 0,
  });
  const m2 = await createMachine({
    schema: 3,
    items: [item('B', { updatedAt: t0, name: 'from machine 2' })],
    arch: [],
    lastExport: 0,
  });

  await m1.engine.triggerNow(); // machine 1's first sync: push A
  await m2.engine.triggerNow(); // machine 2's first sync: push B, pull A
  await m1.engine.triggerNow(); // machine 1 pulls B

  const data1 = await readData(m1.dataFilePath);
  const data2 = await readData(m2.dataFilePath);

  for (const data of [data1, data2]) {
    assert.ok(findItem(data, 'A'), 'A must exist on both machines');
    assert.ok(findItem(data, 'B'), 'B must exist on both machines');
    assert.equal(findItem(data, 'A').name, 'from machine 1');
    assert.equal(findItem(data, 'B').name, 'from machine 2');
  }
});

test('a purge tombstone propagates to the other machine, never as a hard delete', async () => {
  const t0 = Date.now();
  const shared = item('C', { updatedAt: t0, name: 'shared item' });
  const m1 = await createMachine({ schema: 3, items: [shared], arch: [], lastExport: 0 });
  await m1.engine.triggerNow(); // push C

  const m2 = await createMachine();
  await m2.engine.triggerNow(); // pull C
  const pulledC = findItem(await readData(m2.dataFilePath), 'C');
  assert.ok(pulledC, 'machine 2 must have pulled C before purging it');

  // Machine 2 archives then purges its copy of C — mirrors the real
  // app flow (Radar UI only offers PURGE from the archive view).
  const purged = D.purgeItem(D.archiveItem(pulledC, t0 + 1_000), t0 + 2_000);
  await m2.engine.recordLocalSave({ schema: 3, items: [], arch: [purged], lastExport: 0 });
  await m2.engine.triggerNow(); // push the tombstone

  await m1.engine.triggerNow(); // pull it back
  const afterPurge = findItem(await readData(m1.dataFilePath), 'C');
  assert.ok(afterPurge, 'the row must still exist locally — a purge is a tombstone, not a delete');
  assert.ok(afterPurge.deletedAt, 'machine 1 must see the purge tombstone (deletedAt set)');
});

test('log entries added on both machines (before either has pulled the other) both survive', async () => {
  const t0 = Date.now();
  const shared = item('D', { updatedAt: t0, name: 'shared with logs' });
  const m1 = await createMachine({ schema: 3, items: [shared], arch: [], lastExport: 0 });
  await m1.engine.triggerNow(); // push D

  const m2 = await createMachine();
  await m2.engine.triggerNow(); // pull D

  const withE1 = D.addLogEntry(
    findItem(await readData(m1.dataFilePath), 'D'),
    'note from machine 1',
    t0 + 1_000
  );
  await m1.engine.recordLocalSave({ schema: 3, items: [withE1], arch: [], lastExport: 0 });

  const withE2 = D.addLogEntry(
    findItem(await readData(m2.dataFilePath), 'D'),
    'note from machine 2',
    t0 + 1_500
  );
  await m2.engine.recordLocalSave({ schema: 3, items: [withE2], arch: [], lastExport: 0 });

  await m1.engine.triggerNow(); // push e1 (and D's own bump, win-or-lose either way)
  await m2.engine.triggerNow(); // push e2, pull e1
  await m1.engine.triggerNow(); // pull e2

  const finalD1 = findItem(await readData(m1.dataFilePath), 'D');
  const finalD2 = findItem(await readData(m2.dataFilePath), 'D');
  assert.deepEqual(finalD1.log.map((e) => e.text).sort(), [
    'note from machine 1',
    'note from machine 2',
  ]);
  assert.deepEqual(finalD2.log.map((e) => e.text).sort(), [
    'note from machine 1',
    'note from machine 2',
  ]);
});

test('first sync from two machines with overlapping data converges without replacing local data', async () => {
  const t0 = Date.now();
  const m1 = await createMachine({
    schema: 3,
    items: [
      item('X', { updatedAt: t0, name: 'X on machine 1' }),
      item('Y', { updatedAt: t0, name: 'Y original' }),
    ],
    arch: [],
    lastExport: 0,
  });
  const m2 = await createMachine({
    schema: 3,
    items: [
      item('Y', { updatedAt: t0 + 5_000, name: 'Y edited on machine 2' }),
      item('Z', { updatedAt: t0, name: 'Z on machine 2' }),
    ],
    arch: [],
    lastExport: 0,
  });

  await m1.engine.triggerNow(); // m1's first sync: push X, Y(t0) — nothing else on the server yet
  // Never replaced with remote data: at this point m1 has only ever
  // pushed, nothing existed to pull, so its own Y must be untouched.
  assert.equal(findItem(await readData(m1.dataFilePath), 'Y').name, 'Y original');

  await m2.engine.triggerNow(); // m2's first sync: push Y(t0+5000, newer -> wins) and Z; pull X
  await m1.engine.triggerNow(); // m1 pulls Y's update and Z

  const data1 = await readData(m1.dataFilePath);
  const data2 = await readData(m2.dataFilePath);
  for (const data of [data1, data2]) {
    assert.ok(findItem(data, 'X'), 'X must survive on both machines');
    assert.ok(findItem(data, 'Z'), 'Z must survive on both machines');
    assert.equal(
      findItem(data, 'Y').name,
      'Y edited on machine 2',
      'the genuinely newer Y must win on both machines'
    );
  }
});

test('a multi-row push that shares one synced_at is paginated correctly one row at a time', async () => {
  // Every row of a single push_items batch gets the same server-side
  // synced_at, which is exactly the case sync/keyset.js's own module
  // comment calls out: a bare gt(synced_at) cursor could skip the rest
  // of a shared-synced_at batch once a page boundary lands inside it.
  // Only exercised against fakes in test/sync-engine.test.js; this drives
  // the real .or(keysetOrFilter(...)) PostgREST path (buildDefaultPullPage
  // in sync/sync-engine.js) with pullPageSize: 1, so a page boundary is
  // guaranteed to fall inside the batch.
  const t0 = Date.now();
  const m1 = await createMachine({
    schema: 3,
    items: [
      item('P1', { updatedAt: t0, name: 'row 1' }),
      item('P2', { updatedAt: t0, name: 'row 2' }),
      item('P3', { updatedAt: t0, name: 'row 3' }),
    ],
    arch: [],
    lastExport: 0,
  });
  await m1.engine.triggerNow(); // pushes all three items in one batch -> one shared synced_at

  const m2 = await createMachine(undefined, { pullPageSize: 1 });
  await m2.engine.triggerNow(); // must page through the shared synced_at boundary via keysetOrFilter

  const data2 = await readData(m2.dataFilePath);
  assert.deepEqual(
    ['P1', 'P2', 'P3'].map((id) => findItem(data2, id) && findItem(data2, id).name),
    ['row 1', 'row 2', 'row 3'],
    'every row of a batch sharing one synced_at must arrive even when paginating one row at a time'
  );
});
