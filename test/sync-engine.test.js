'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const { createSyncEngine } = require('../sync/sync-engine.js');
const {
  readJsonFile,
  readJsonFileStrict,
  writeJsonFileAtomic,
} = require('../sync/atomic-json-file.js');
const { msToIso } = require('../sync/mapping.js');
const syncState = require('../sync/sync-state.js');
const outbox = require('../sync/outbox.js');
const domain = require('../renderer/domain.js');

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, critical() {} };

// A logger that records every call (per level) instead of discarding it,
// for the handful of tests that assert something specific got logged
// rather than just staying silent.
function spyLog() {
  const calls = { debug: [], info: [], warn: [], error: [], critical: [] };
  const log = {};
  Object.keys(calls).forEach((level) => {
    log[level] = (...args) => calls[level].push(args);
  });
  return { log, calls };
}

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'wr-sync-engine-'));
}

function makeClient(userId) {
  return {
    auth: {
      async getSession() {
        return { data: { session: userId ? { user: { id: userId } } : null }, error: null };
      },
    },
  };
}

// `reviewedAt` defaults to whatever `updatedAt` ends up being (not a
// fixed 1000), so a fixture that only overrides `updatedAt` still models
// genuine v3 data — a real v3 item can never have reviewedAt > updatedAt,
// since every mutation bumps updatedAt to at least reviewedAt (see
// domain.js's nextUpdatedAt). Without this, withDataFile's migrate() (see
// blocking-issue-1 in docs/supabase-sync-plan.md) treats such a fixture
// as v2-era data whose updatedAt never caught up, and "fixes" it by
// bumping updatedAt back up to the (fixed) reviewedAt — silently
// undoing the very updatedAt override a test set up to assert on. Pass
// `reviewedAt` explicitly to override this (e.g. to test the tie-break
// chain itself).
function item(id, overrides = {}) {
  const updatedAt = overrides.updatedAt ?? 1000;
  return {
    id,
    name: id,
    status: 'active',
    priority: 'medium',
    category: '',
    notes: '',
    addedAt: 1000,
    updatedAt,
    reviewedAt: updatedAt,
    log: [],
    ...overrides,
  };
}

// A no-op pull page (nothing new on the server) — used by tests focused
// on push behaviour so they don't also have to stub out pull.
async function emptyPage() {
  return [];
}

function acceptAll() {
  return async (rows) => rows.map((r) => ({ row_id: r.id, accepted: true, reason: null }));
}

// Polls instead of a fixed sleep, since CI/dev-box scheduling jitter can
// easily make a fixed delay flaky in either direction — this waits only
// as long as it actually takes, up to a generous ceiling.
async function waitFor(predicate, message, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// A manually-released gate: `wait` resolves only once `release()` has
// been called. Used to pause a fake RPC/read mid-flight so a test can
// run something else (another engine call, stop()) while it's stuck,
// then let it continue.
function makeGate() {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

test('recordLocalSave merges the incoming payload with what is on disk instead of overwriting it', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    pushItemsRpc: acceptAll(),
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  // Simulate a background pull having just merged in a newer remote
  // edit of item A directly to disk (what pullItemsAndMerge does).
  await writeJsonFileAtomic(dataFilePath, {
    schema: 3,
    items: [item('A', { updatedAt: 300, name: 'fromRemote' })],
    arch: [],
    lastExport: 0,
  });

  try {
    // A stale renderer save, still holding an older in-memory copy of
    // A, plus a genuinely new item B.
    const merged = await engine.recordLocalSave({
      schema: 3,
      items: [
        item('A', { updatedAt: 200, name: 'staleRendererEdit' }),
        item('B', { updatedAt: 400 }),
      ],
      arch: [],
      lastExport: 0,
    });

    const onDisk = await readJsonFile(dataFilePath);
    const a = onDisk.items.find((i) => i.id === 'A');
    const b = onDisk.items.find((i) => i.id === 'B');
    assert.equal(a.name, 'fromRemote', 'the newer remote edit must survive the stale save');
    assert.equal(a.updatedAt, 300);
    assert.ok(b, 'the genuinely new item must still be added');
    assert.deepEqual(merged.items.map((i) => i.id).sort(), ['A', 'B']);
  } finally {
    // recordLocalSave above schedules a debounced sync — cancel it so
    // it can't fire (and keep the process alive) after this test ends.
    engine.stop();
  }
});

test('recordLocalSave diffs against the last snapshot and queues only genuinely changed ids', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  const engine = createSyncEngine({ client, dataFilePath, syncStateFilePath, log: silentLog });

  // Prime the snapshot as if item A had already been synced before.
  const seedData = { schema: 3, items: [item('A', { updatedAt: 100 })], arch: [], lastExport: 0 };
  await writeJsonFileAtomic(dataFilePath, seedData);
  await writeJsonFileAtomic(
    syncStateFilePath,
    syncState.setUserState(syncState.emptyState(), 'u1', {
      ...syncState.emptyUserState(),
      snapshot: outbox.snapshotOf(seedData),
      firstSyncDone: true,
    })
  );

  try {
    await engine.recordLocalSave({
      schema: 3,
      items: [item('A', { updatedAt: 100 }), item('B', { updatedAt: 500 })],
      arch: [],
      lastExport: 0,
    });

    const state = await readJsonFile(syncStateFilePath);
    const userState = syncState.getUserState(state, 'u1');
    assert.deepEqual(userState.pendingItemIds, ['B'], 'only the new item, not the unchanged one');
  } finally {
    // This engine has no push/pull fakes wired up at all — cancel the
    // debounced sync recordLocalSave scheduled before it can fire and
    // hit the (unmocked) default client.
    engine.stop();
  }
});

test('a full cycle pushes items before log entries, in that order', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  const calls = [];

  const data = {
    schema: 3,
    items: [item('A', { updatedAt: 100, log: [{ id: 'e1', ts: 50, text: 'note' }] })],
    arch: [],
    lastExport: 0,
  };
  await writeJsonFileAtomic(dataFilePath, data);

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    pushItemsRpc: async (rows) => {
      calls.push('items');
      return rows.map((r) => ({ row_id: r.id, accepted: true, reason: null }));
    },
    pushLogEntriesRpc: async (rows) => {
      calls.push('logEntries');
      return rows.map((r) => ({ row_id: r.id, accepted: true, reason: null }));
    },
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  try {
    await engine.triggerNow();

    assert.deepEqual(calls, ['items', 'logEntries']);
    assert.equal(engine.getStatus(), 'synced');
    const state = await readJsonFile(syncStateFilePath);
    const userState = syncState.getUserState(state, 'u1');
    assert.deepEqual(userState.pendingItemIds, []);
    assert.deepEqual(userState.pendingLogEntryIds, []);
  } finally {
    engine.stop();
  }
});

test('the first cycle for a user marks all existing local data pending (first sync)', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  const pushed = { items: [], logEntries: [] };

  const data = {
    schema: 3,
    items: [item('A', { updatedAt: 100, log: [{ id: 'e1', ts: 50, text: 'note' }] })],
    arch: [item('B', { updatedAt: 50, archivedAt: 60 })],
    lastExport: 0,
  };
  await writeJsonFileAtomic(dataFilePath, data);

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    pushItemsRpc: async (rows) => {
      pushed.items.push(...rows.map((r) => r.id));
      return rows.map((r) => ({ row_id: r.id, accepted: true, reason: null }));
    },
    pushLogEntriesRpc: async (rows) => {
      pushed.logEntries.push(...rows.map((r) => r.id));
      return rows.map((r) => ({ row_id: r.id, accepted: true, reason: null }));
    },
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  try {
    await engine.triggerNow();

    assert.deepEqual(pushed.items.sort(), ['A', 'B']);
    assert.deepEqual(pushed.logEntries, ['e1']);
  } finally {
    engine.stop();
  }
});

test('a stale_or_not_owned rejection leaves the item pending for the next cycle', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');

  await writeJsonFileAtomic(dataFilePath, {
    schema: 3,
    items: [item('A', { updatedAt: 100 })],
    arch: [],
    lastExport: 0,
  });

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    pushItemsRpc: async (rows) =>
      rows.map((r) => ({ row_id: r.id, accepted: false, reason: 'stale_or_not_owned' })),
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
    getItemById: async () => null, // remote row lookup declines to weigh in -> no remediation
  });

  try {
    await engine.triggerNow();

    assert.equal(engine.getStatus(), 'pending');
    const state = await readJsonFile(syncStateFilePath);
    assert.deepEqual(syncState.getUserState(state, 'u1').pendingItemIds, ['A']);
  } finally {
    engine.stop();
  }
});

test('a stale_or_not_owned rejection whose remote row lookup finds nothing warns every cycle instead of retrying silently', async () => {
  // docs/supabase-sync-plan.md's Phase 4-5 notes say this case "retries
  // forever with a warn log every cycle" — found in review: the code
  // used to just `continue` with no log line at all, so a row stuck this
  // way (not owned by this user, or genuinely gone) retried forever with
  // no trace in the logs.
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  const { log, calls } = spyLog();

  await writeJsonFileAtomic(dataFilePath, {
    schema: 3,
    items: [item('A', { updatedAt: 100 })],
    arch: [],
    lastExport: 0,
  });

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log,
    pushItemsRpc: async (rows) =>
      rows.map((r) => ({ row_id: r.id, accepted: false, reason: 'stale_or_not_owned' })),
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
    getItemById: async () => null, // not owned by this user, or genuinely gone
  });

  try {
    await engine.triggerNow();

    assert.equal(engine.getStatus(), 'pending');
    const warned = calls.warn.find(([, ctx]) => ctx && ctx.id === 'A');
    assert.ok(warned, 'a stale rejection with no reconcilable remote row must warn with the id');
    assert.match(warned[0], /remote row/i);
    assert.ok(warned[1].cycleId, 'the warn must carry the cycleId for correlation');
  } finally {
    engine.stop();
  }
});

// A pulled row shape (snake_case, ISO timestamps), as getItemById returns
// it — see sync/mapping.js's rowToItem.
function remoteRow(id, overrides) {
  return {
    id,
    name: id,
    status: 'active',
    priority: 'medium',
    category: '',
    notes: '',
    added_at: msToIso(1000),
    updated_at: msToIso(1000),
    reviewed_at: msToIso(1000),
    archived_at: null,
    deleted_at: null,
    synced_at: msToIso(1000),
    ...overrides,
  };
}

test('a stale_or_not_owned rejection where the remote is genuinely newer resolves without re-stamping', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  let reloaded = 0;

  await writeJsonFileAtomic(dataFilePath, {
    schema: 3,
    items: [item('A', { updatedAt: 100, name: 'local copy' })],
    arch: [],
    lastExport: 0,
  });

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    onReload: () => reloaded++,
    pushItemsRpc: async (rows) =>
      rows.map((r) => ({ row_id: r.id, accepted: false, reason: 'stale_or_not_owned' })),
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
    // Strictly newer updatedAt and different content — an ordinary
    // "someone else already pushed a newer edit" rejection.
    getItemById: async () => remoteRow('A', { updated_at: msToIso(200), name: 'remote copy' }),
  });

  try {
    await engine.triggerNow();

    const state = await readJsonFile(syncStateFilePath);
    assert.deepEqual(
      syncState.getUserState(state, 'u1').pendingItemIds,
      [],
      'must resolve (stop retrying), never re-stamp, when the remote copy is genuinely newer'
    );
    assert.equal(engine.getStatus(), 'synced');
    assert.equal(reloaded, 0, 'resolving must not re-stamp, so there is nothing to reload');
    const onDisk = await readJsonFile(dataFilePath);
    assert.equal(
      onDisk.items.find((i) => i.id === 'A').updatedAt,
      100,
      'the local copy must not be re-stamped'
    );
  } finally {
    engine.stop();
  }
});

test('a stale_or_not_owned rejection on content-identical rows resolves without re-stamping (retry / first-sync overlap)', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  let reloaded = 0;

  await writeJsonFileAtomic(dataFilePath, {
    schema: 3,
    items: [item('A', { updatedAt: 100, name: 'same everywhere' })],
    arch: [],
    lastExport: 0,
  });

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    onReload: () => reloaded++,
    pushItemsRpc: async (rows) =>
      rows.map((r) => ({ row_id: r.id, accepted: false, reason: 'stale_or_not_owned' })),
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
    // Same content, updated_at equal to local's — an already-accepted
    // push being retried, or two machines' first sync overlapping on
    // identical data. Must never be re-stamped: doing so would spread a
    // content-free updatedAt bump to every machine (found in review).
    getItemById: async () => remoteRow('A', { updated_at: msToIso(100), name: 'same everywhere' }),
  });

  try {
    await engine.triggerNow();

    const state = await readJsonFile(syncStateFilePath);
    assert.deepEqual(syncState.getUserState(state, 'u1').pendingItemIds, []);
    assert.equal(reloaded, 0, 'identical content must resolve, never re-stamp');
    const onDisk = await readJsonFile(dataFilePath);
    assert.equal(onDisk.items.find((i) => i.id === 'A').updatedAt, 100);
  } finally {
    engine.stop();
  }
});

test('a stale_or_not_owned rejection on an exact updatedAt tie the local merge still prefers re-stamps and stays pending', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  let reloaded = 0;

  await writeJsonFileAtomic(dataFilePath, {
    schema: 3,
    // A higher reviewedAt than the remote row below, with an equal
    // updatedAt — mergeItem's tie-break (reviewedAt first) prefers this
    // local copy, per renderer/domain.js's own tie-break order.
    items: [item('A', { updatedAt: 500, reviewedAt: 600, name: 'local wins the tie' })],
    arch: [],
    lastExport: 0,
  });

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    onReload: () => reloaded++,
    pushItemsRpc: async (rows) =>
      rows.map((r) => ({ row_id: r.id, accepted: false, reason: 'stale_or_not_owned' })),
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
    getItemById: async () =>
      remoteRow('A', { updated_at: msToIso(500), reviewed_at: msToIso(100), name: 'remote loses' }),
  });

  try {
    await engine.triggerNow();

    const state = await readJsonFile(syncStateFilePath);
    assert.deepEqual(
      syncState.getUserState(state, 'u1').pendingItemIds,
      ['A'],
      'a genuine tie the local merge prefers must stay pending for the re-stamped retry'
    );
    assert.equal(engine.getStatus(), 'pending');
    assert.ok(reloaded >= 1, 're-stamping changes the data file, so the renderer must reload');
    const onDisk = await readJsonFile(dataFilePath);
    const a = onDisk.items.find((i) => i.id === 'A');
    assert.equal(a.name, 'local wins the tie', 'the content stays local’s, only updatedAt moves');
    assert.ok(a.updatedAt > 500, 'updatedAt must be bumped strictly past the remote value');
  } finally {
    engine.stop();
  }
});

test('a concurrent recordLocalSave mid-push keeps the newer edit pending instead of dropping it from the outbox', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');

  await writeJsonFileAtomic(dataFilePath, {
    schema: 3,
    items: [item('A', { updatedAt: 1000, name: 'v1' })],
    arch: [],
    lastExport: 0,
  });

  const gate = makeGate();
  const pushedRows = [];
  let firstPush = true;
  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    pushItemsRpc: async (rows) => {
      pushedRows.push(rows);
      if (firstPush) {
        firstPush = false;
        await gate.wait; // held open until released below
      }
      return rows.map((r) => ({ row_id: r.id, accepted: true, reason: null }));
    },
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  try {
    const firstCycle = engine.triggerNow();
    await waitFor(() => pushedRows.length >= 1, 'the first push must have started');
    assert.equal(pushedRows[0][0].name, 'v1', 'the in-flight push must be carrying v1');

    // A newer edit lands while that push (of v1) is still in flight.
    await engine.recordLocalSave({
      schema: 3,
      items: [item('A', { updatedAt: 2000, name: 'v2' })],
      arch: [],
      lastExport: 0,
    });

    gate.release();
    await firstCycle;

    assert.equal(engine.getStatus(), 'pending');
    const state = await readJsonFile(syncStateFilePath);
    assert.deepEqual(
      syncState.getUserState(state, 'u1').pendingItemIds,
      ['A'],
      'the push that just completed pushed v1 — it must not clear an id whose snapshot has since moved on to v2'
    );
    const onDisk = await readJsonFile(dataFilePath);
    assert.equal(onDisk.items.find((i) => i.id === 'A').name, 'v2');

    await engine.triggerNow();
    const secondPush = pushedRows[pushedRows.length - 1];
    assert.equal(secondPush.length, 1);
    assert.equal(
      secondPush[0].name,
      'v2',
      'v2 must be pushed on the next cycle, not silently dropped'
    );
    assert.equal(engine.getStatus(), 'synced');
  } finally {
    engine.stop();
  }
});

test('recordLocalSave and a pull merge are serialized so neither loses the other’s write', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');

  await writeJsonFileAtomic(dataFilePath, { schema: 3, items: [], arch: [], lastExport: 0 });

  const pulledRow = {
    id: 'remote-1',
    name: 'from remote',
    status: 'active',
    priority: 'medium',
    category: '',
    notes: '',
    added_at: msToIso(1000),
    updated_at: msToIso(1000),
    reviewed_at: msToIso(1000),
    archived_at: null,
    deleted_at: null,
    synced_at: msToIso(2000),
  };

  // Delays every real read of the data file, widening the window
  // between a read and its matching write for whichever of
  // recordLocalSave / the pull merge gets there first — without
  // sync-engine.js's own data-file mutex (withDataFile), this is
  // exactly the window that lets one clobber the other (found in
  // review: reproduced with the local edit vanishing from disk).
  const delayedReadDataFile = async (filePath) => {
    const result = await readJsonFileStrict(filePath);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return result;
  };

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    readDataFile: delayedReadDataFile,
    pushItemsRpc: acceptAll(),
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: async ({ afterId }) => (afterId ? [] : [pulledRow]),
    pullLogEntriesPage: emptyPage,
  });

  try {
    const cycle = engine.triggerNow(); // pulls `pulledRow` and merges it in
    // Give the cycle a moment to start its own (delayed) reads before
    // the local save below races in.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await engine.recordLocalSave({
      schema: 3,
      items: [item('local-1', { updatedAt: 500 })],
      arch: [],
      lastExport: 0,
    });
    await cycle;

    const onDisk = await readJsonFile(dataFilePath);
    const ids = onDisk.items.map((i) => i.id).sort();
    assert.deepEqual(
      ids,
      ['local-1', 'remote-1'],
      'neither the local save nor the pull merge may be lost to the other'
    );
  } finally {
    engine.stop();
  }
});

test('a plain write outside recordLocalSave is still diffed into the outbox and pushed on the next cycle', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  const pushedIds = [];

  await writeJsonFileAtomic(dataFilePath, { schema: 3, items: [], arch: [], lastExport: 0 });

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    pushItemsRpc: async (rows) => {
      pushedIds.push(...rows.map((r) => r.id));
      return rows.map((r) => ({ row_id: r.id, accepted: true, reason: null }));
    },
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  try {
    await engine.triggerNow(); // establishes an empty, already-synced baseline
    assert.deepEqual(pushedIds, []);

    // A plain atomicWrite made outside the engine entirely — e.g.
    // main.js's data:save handler writing directly while signed out, or
    // before the session was restored (see docs/supabase-sync-plan.md's
    // Phase 4-5 notes).
    await writeJsonFileAtomic(dataFilePath, {
      schema: 3,
      items: [item('OUTSIDE', { updatedAt: 999 })],
      arch: [],
      lastExport: 0,
    });

    await engine.triggerNow();
    assert.deepEqual(
      pushedIds,
      ['OUTSIDE'],
      'an edit made outside recordLocalSave must still be diffed into the outbox and pushed'
    );
  } finally {
    engine.stop();
  }
});

test('stop() while a cycle is in flight keeps it from reporting status or arming a retry once it resumes', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  await writeJsonFileAtomic(dataFilePath, {
    schema: 3,
    items: [item('A', { updatedAt: 100 })],
    arch: [],
    lastExport: 0,
  });

  const gate = makeGate();
  const statusesAfterStop = [];
  let stopped = false;
  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    backoffBaseMs: 15,
    backoffMaxMs: 15,
    onStatus: (s) => {
      if (stopped) statusesAfterStop.push(s);
    },
    pushItemsRpc: async () => {
      await gate.wait;
      throw new TypeError('fetch failed'); // classifies as offline
    },
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  try {
    const cycle = engine.triggerNow();
    await new Promise((resolve) => setTimeout(resolve, 5)); // let it reach the gated push

    engine.stop();
    stopped = true;
    gate.release();
    await cycle;

    // Long enough for the old scheduleRetry() (were it wrongly armed) to
    // have fired at least once and re-thrown into another gated (now
    // immediately-rejecting) push.
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.deepEqual(
      statusesAfterStop,
      [],
      'a cycle already in flight when stop() ran must never call onStatus afterwards'
    );
    assert.equal(engine.getStatus(), null, 'stop() resets status and nothing may set it again');
  } finally {
    engine.stop();
  }
});

test('a corrupt data file fails the cycle loudly instead of being silently treated as empty', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  const corrupt = '{ this is not valid json';
  await fsp.writeFile(dataFilePath, corrupt, 'utf8');

  const errors = [];
  const capturingLog = { ...silentLog, error: (msg, ctx) => errors.push({ msg, ctx }) };

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: capturingLog,
    backoffBaseMs: 100_000, // don't let a retry fire mid-test
    pushItemsRpc: acceptAll(),
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  try {
    await engine.triggerNow();

    assert.equal(engine.getStatus(), 'error', 'a corrupt data file must never be treated as empty');
    const stillOnDisk = await fsp.readFile(dataFilePath, 'utf8');
    assert.equal(
      stillOnDisk,
      corrupt,
      'the corrupt file must be left untouched, never overwritten'
    );
    assert.ok(
      errors.some((e) => e.msg === 'sync cycle failed'),
      'the failure must be logged with context, not swallowed'
    );
  } finally {
    engine.stop();
  }
});

test('an item_not_found log entry rejection stays pending and pushes once the item is accepted', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  let itemAccepted = false;

  await writeJsonFileAtomic(dataFilePath, {
    schema: 3,
    items: [item('A', { updatedAt: 100, log: [{ id: 'e1', ts: 50, text: 'note' }] })],
    arch: [],
    lastExport: 0,
  });

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    pushItemsRpc: async (rows) => {
      itemAccepted = true;
      return rows.map((r) => ({ row_id: r.id, accepted: true, reason: null }));
    },
    pushLogEntriesRpc: async (rows) =>
      rows.map((r) => ({
        row_id: r.id,
        accepted: itemAccepted,
        reason: itemAccepted ? null : 'item_not_found',
      })),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  try {
    // First cycle: item pushes fine, but the log entry rpc in this test
    // is only wired to accept once itemAccepted flips — exercised for
    // real via the two-machine integration test; here we just check the
    // bookkeeping directly.
    await engine.triggerNow();
    const state = await readJsonFile(syncStateFilePath);
    assert.deepEqual(syncState.getUserState(state, 'u1').pendingLogEntryIds, []);
  } finally {
    engine.stop();
  }
});

test('pulling items merges them into the local file and notifies the renderer to reload', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  let reloaded = 0;

  await writeJsonFileAtomic(dataFilePath, { schema: 3, items: [], arch: [], lastExport: 0 });

  const pulledRow = {
    id: 'remote-1',
    name: 'From another machine',
    status: 'active',
    priority: 'high',
    category: '',
    notes: '',
    added_at: msToIso(1000),
    updated_at: msToIso(1000),
    reviewed_at: msToIso(1000),
    archived_at: null,
    deleted_at: null,
    synced_at: msToIso(2000),
  };

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    pushItemsRpc: acceptAll(),
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: async ({ afterId }) => (afterId ? [] : [pulledRow]),
    pullLogEntriesPage: emptyPage,
    onReload: () => reloaded++,
  });

  try {
    await engine.triggerNow();

    const onDisk = await readJsonFile(dataFilePath);
    assert.equal(onDisk.items.length, 1);
    assert.equal(onDisk.items[0].name, 'From another machine');
    assert.ok(reloaded >= 1);

    const state = await readJsonFile(syncStateFilePath);
    assert.equal(syncState.getUserState(state, 'u1').itemsCursor, 2000);
  } finally {
    engine.stop();
  }
});

test('the items cursor is only persisted after the merge has been written', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  const writeOrder = [];

  await writeJsonFileAtomic(dataFilePath, { schema: 3, items: [], arch: [], lastExport: 0 });

  const pulledRow = {
    id: 'remote-1',
    name: 'X',
    status: 'active',
    priority: 'high',
    added_at: msToIso(1000),
    updated_at: msToIso(1000),
    reviewed_at: msToIso(1000),
    synced_at: msToIso(2000),
  };

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    pushItemsRpc: acceptAll(),
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: async ({ afterId }) => (afterId ? [] : [pulledRow]),
    pullLogEntriesPage: emptyPage,
    writeJsonFileAtomic: async (filePath, obj) => {
      writeOrder.push(filePath);
      await writeJsonFileAtomic(filePath, obj);
    },
  });

  try {
    await engine.triggerNow();

    const dataWriteIndex = writeOrder.indexOf(dataFilePath);
    const stateWriteIndex = writeOrder.lastIndexOf(syncStateFilePath);
    assert.ok(dataWriteIndex !== -1 && stateWriteIndex !== -1);
    assert.ok(
      dataWriteIndex < stateWriteIndex,
      'data file must be written before the cursor is persisted'
    );
  } finally {
    engine.stop();
  }
});

test('runCycle is a no-op when there is no signed-in user', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient(null);
  let pushCalled = false;

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    pushItemsRpc: async () => {
      pushCalled = true;
      return [];
    },
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  try {
    await engine.triggerNow();
    assert.equal(pushCalled, false);
    assert.equal(engine.getStatus(), null);
  } finally {
    engine.stop();
  }
});

test('a thrown network-shaped error sets status to offline and schedules a retry', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  await writeJsonFileAtomic(dataFilePath, {
    schema: 3,
    items: [item('A', { updatedAt: 100 })],
    arch: [],
    lastExport: 0,
  });

  let attempts = 0;
  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    backoffBaseMs: 20,
    backoffMaxMs: 40,
    pushItemsRpc: async () => {
      attempts++;
      if (attempts < 2) throw new TypeError('fetch failed');
      return [{ row_id: 'A', accepted: true, reason: null }];
    },
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  try {
    await engine.triggerNow();
    assert.equal(engine.getStatus(), 'offline');
    assert.equal(attempts, 1);

    // Wait for the scheduled backoff retry to fire on its own and the
    // cycle it triggers to finish (not just the push call within it).
    await waitFor(() => engine.getStatus() === 'synced', 'the retry must have fired on its own');
    assert.equal(attempts, 2);
  } finally {
    engine.stop();
  }
});

test('a non-network thrown error sets status to error', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  await writeJsonFileAtomic(dataFilePath, {
    schema: 3,
    items: [item('A', { updatedAt: 100 })],
    arch: [],
    lastExport: 0,
  });

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    backoffBaseMs: 100_000, // don't let a retry fire mid-test
    pushItemsRpc: async () => {
      const err = new Error('push_items: no authenticated user');
      throw err;
    },
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  try {
    await engine.triggerNow();
    assert.equal(engine.getStatus(), 'error');
  } finally {
    engine.stop();
  }
});

test('start() triggers immediately and stop() halts the periodic interval', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  await writeJsonFileAtomic(dataFilePath, { schema: 3, items: [], arch: [], lastExport: 0 });
  let cycles = 0;

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    intervalMs: 15,
    pushItemsRpc: acceptAll(),
    pushLogEntriesRpc: acceptAll(),
    // Called on every cycle regardless of whether there's anything
    // pending to push, unlike pushItemsRpc — a reliable per-cycle tick.
    pullItemsPage: async () => {
      cycles++;
      return [];
    },
    pullLogEntriesPage: emptyPage,
  });

  try {
    engine.start();
    await waitFor(() => cycles >= 1, 'start() must trigger a cycle immediately');

    const cyclesAtStart = cycles;
    await waitFor(
      () => cycles > cyclesAtStart,
      'the periodic interval must trigger further cycles'
    );

    engine.stop();
    // stop() only clears the interval/timeout handles — it doesn't (and
    // shouldn't) abort a cycle already in flight, so give one a moment
    // to land before taking the "no more cycles" baseline.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const cyclesAtStop = cycles;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(cycles, cyclesAtStop, 'stop() must stop further cycles from firing');
  } finally {
    engine.stop();
  }
});

test('recordLocalSave schedules a debounced sync after a save', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  let pushCount = 0;

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    saveDebounceMs: 15,
    pushItemsRpc: async (rows) => {
      pushCount++;
      return rows.map((r) => ({ row_id: r.id, accepted: true, reason: null }));
    },
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  try {
    await engine.recordLocalSave({ schema: 3, items: [item('A')], arch: [], lastExport: 0 });
    assert.equal(pushCount, 0, 'the push must not happen synchronously inside recordLocalSave');

    await waitFor(() => pushCount >= 1, 'the debounced trigger must have run a cycle');
  } finally {
    engine.stop();
  }
});

/* ---------- Review fixes: blocking issue 1 (migrate a still-schema-2
   file before merging) ---------- */

test('withDataFile migrates a still-on-disk schema-2 file before merging, so a legacy log entry does not duplicate', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');

  // A schema-2 file still on disk (the released format): the log entry
  // has no id, and updatedAt was never bumped by addLogEntry.
  const legacyItem = {
    id: 'A',
    name: 'A',
    status: 'active',
    priority: 'medium',
    category: '',
    notes: '',
    addedAt: 1000,
    reviewedAt: 1000,
    log: [{ ts: 500, text: 'hello' }],
  };
  await writeJsonFileAtomic(dataFilePath, {
    schema: 2,
    items: [legacyItem],
    arch: [],
    lastExport: 0,
  });

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    pushItemsRpc: acceptAll(),
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  try {
    // The renderer always migrates before calling data:save (Store.load()
    // runs D.migrate first) — recordLocalSave receives an already-
    // migrated payload for the exact same item still unmigrated on disk.
    const migratedPayload = {
      schema: domain.SCHEMA,
      items: domain.migrate([legacyItem]),
      arch: [],
      lastExport: 0,
    };

    await engine.recordLocalSave(migratedPayload);

    const onDisk = await readJsonFile(dataFilePath);
    const a = onDisk.items.find((i) => i.id === 'A');
    assert.equal(a.log.length, 1, 'the legacy log entry must not duplicate on disk');
    assert.ok(a.log[0].id, 'the surviving log entry must have a stable id, never undefined/null');
  } finally {
    engine.stop();
  }
});

test('a cycle pushes migrated log-entry ids even when the on-disk file is still schema-2 (no renderer save yet)', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');

  await writeJsonFileAtomic(dataFilePath, {
    schema: 2,
    items: [
      {
        id: 'A',
        name: 'A',
        status: 'active',
        priority: 'medium',
        addedAt: 1000,
        reviewedAt: 1000,
        log: [{ ts: 500, text: 'hello' }],
      },
    ],
    arch: [],
    lastExport: 0,
  });

  const pushedLogEntryIds = [];
  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    pushItemsRpc: acceptAll(),
    pushLogEntriesRpc: async (rows) => {
      pushedLogEntryIds.push(...rows.map((r) => r.id));
      return rows.map((r) => ({ row_id: r.id, accepted: true, reason: null }));
    },
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  try {
    await engine.triggerNow();
    assert.equal(pushedLogEntryIds.length, 1);
    assert.ok(pushedLogEntryIds[0], 'must never push a null/undefined log entry id');

    const onDisk = await readJsonFile(dataFilePath);
    assert.equal(
      onDisk.items[0].log.length,
      1,
      'the file on disk itself must end up migrated, not just the push'
    );
  } finally {
    engine.stop();
  }
});

/* ---------- Review fixes: blocking issue 2 (never block a local save on
   the network) ---------- */

test('recordLocalSave writes the merged save to disk before getSession settles (never blocks a local save on the network)', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  await writeJsonFileAtomic(dataFilePath, { schema: 3, items: [], arch: [], lastExport: 0 });

  const gate = makeGate();
  let getSessionCalled = false;
  const client = {
    auth: {
      async getSession() {
        getSessionCalled = true;
        await gate.wait; // simulate a stuck network token refresh
        return { data: { session: { user: { id: 'u1' } } }, error: null };
      },
    },
  };

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    pushItemsRpc: acceptAll(),
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  try {
    const savePromise = engine.recordLocalSave({
      schema: 3,
      items: [item('A', { updatedAt: 500 })],
      arch: [],
      lastExport: 0,
    });

    await waitFor(() => getSessionCalled, 'getUserId must still be called eventually');
    // Give the merge-and-write a chance to land while getSession is still
    // stuck behind the gate.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const onDisk = await readJsonFile(dataFilePath);
    assert.ok(
      onDisk.items.find((i) => i.id === 'A'),
      'the local save must reach disk without waiting for getSession to settle'
    );

    gate.release();
    await savePromise;
  } finally {
    engine.stop();
  }
});

/* ---------- Review fixes: non-blocking cleanups ---------- */

test('recordLocalSave keeps an offline/error status instead of downgrading it to pending', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  await writeJsonFileAtomic(dataFilePath, {
    schema: 3,
    items: [item('A', { updatedAt: 100 })],
    arch: [],
    lastExport: 0,
  });

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    backoffBaseMs: 100_000, // don't let a retry fire mid-test
    pushItemsRpc: async () => {
      throw new TypeError('fetch failed'); // classifies as offline
    },
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  try {
    await engine.triggerNow();
    assert.equal(engine.getStatus(), 'offline');

    await engine.recordLocalSave({
      schema: 3,
      items: [item('A', { updatedAt: 200 }), item('B', { updatedAt: 300 })],
      arch: [],
      lastExport: 0,
    });

    assert.equal(
      engine.getStatus(),
      'offline',
      'a local save while offline must not hide the offline indicator behind "pending"'
    );
  } finally {
    engine.stop();
  }
});

test('pushPendingLogEntries logs item_not_found rejections at debug and other rejections at warn', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  await writeJsonFileAtomic(dataFilePath, {
    schema: 3,
    items: [
      item('A', { updatedAt: 100, log: [{ id: 'e1', ts: 50, text: 'note' }] }),
      item('B', { updatedAt: 100, log: [{ id: 'e2', ts: 60, text: 'note2' }] }),
    ],
    arch: [],
    lastExport: 0,
  });

  const debugLines = [];
  const warnLines = [];
  const capturingLog = {
    ...silentLog,
    debug: (msg, ctx) => debugLines.push({ msg, ctx }),
    warn: (msg, ctx) => warnLines.push({ msg, ctx }),
  };

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: capturingLog,
    pushItemsRpc: acceptAll(),
    pushLogEntriesRpc: async (rows) =>
      rows.map((r) => ({
        row_id: r.id,
        accepted: false,
        reason: r.id === 'e1' ? 'item_not_found' : 'bad_row',
      })),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  try {
    await engine.triggerNow();

    assert.ok(
      debugLines.some((l) => l.ctx && l.ctx.id === 'e1'),
      'item_not_found must stay at debug'
    );
    assert.ok(
      warnLines.some((l) => l.ctx && l.ctx.id === 'e2' && l.ctx.reason === 'bad_row'),
      'a real rejection reason must be logged at warn with cycleId/id/reason'
    );
  } finally {
    engine.stop();
  }
});

test('re-pulling an already-merged row does not rewrite the data file or notify again, but still advances the cursor', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  await writeJsonFileAtomic(dataFilePath, { schema: 3, items: [], arch: [], lastExport: 0 });

  const pulledRow = {
    id: 'remote-1',
    name: 'X',
    status: 'active',
    priority: 'high',
    category: '',
    notes: '',
    added_at: msToIso(1000),
    updated_at: msToIso(1000),
    reviewed_at: msToIso(1000),
    archived_at: null,
    deleted_at: null,
    synced_at: msToIso(2000),
  };

  let reloads = 0;
  let writeCount = 0;
  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    pushItemsRpc: acceptAll(),
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: async ({ afterId }) => (afterId ? [] : [pulledRow]),
    pullLogEntriesPage: emptyPage,
    onReload: () => reloads++,
    writeJsonFileAtomic: async (filePath, obj) => {
      if (filePath === dataFilePath) writeCount++;
      await writeJsonFileAtomic(filePath, obj);
    },
  });

  try {
    await engine.triggerNow(); // first pull: merges the row in, writes once
    assert.equal(writeCount, 1);
    assert.equal(reloads, 1);

    const stateAfterFirst = await readJsonFile(syncStateFilePath);
    const cursorAfterFirst = syncState.getUserState(stateAfterFirst, 'u1').itemsCursor;

    await engine.triggerNow(); // the lookback window re-pulls the same row, unchanged

    assert.equal(writeCount, 1, 'an unchanged re-pulled row must not rewrite the data file');
    assert.equal(reloads, 1, 'an unchanged re-pulled row must not trigger another reload');

    const stateAfterSecond = await readJsonFile(syncStateFilePath);
    assert.ok(
      syncState.getUserState(stateAfterSecond, 'u1').itemsCursor >= cursorAfterFirst,
      'the cursor must still advance even when nothing changed'
    );
  } finally {
    engine.stop();
  }
});

/* ---------- Review fixes, round 2 ---------- */

test('stop() then start() while a cycle is in flight does not lose the new session’s rerun', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  // An item to push, so the first (gated) cycle's pushItemsRpc actually
  // gets called — an empty data file would never call it at all.
  await writeJsonFileAtomic(dataFilePath, {
    schema: 3,
    items: [item('A', { updatedAt: 100 })],
    arch: [],
    lastExport: 0,
  });

  const gate = makeGate();
  let pushCalls = 0;
  // pushPendingItems clears an accepted id from the outbox regardless of
  // generation (the in-flight network call itself can't be cancelled),
  // so once the gated push below resolves there is nothing left *to*
  // push again — pullItemsPage runs unconditionally on every complete
  // cycle instead, making it the reliable "did a whole new cycle run"
  // signal for the second half of this test.
  let pullCalls = 0;
  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    pushItemsRpc: async (rows) => {
      pushCalls++;
      if (pushCalls === 1) await gate.wait; // held open until released below
      return rows.map((r) => ({ row_id: r.id, accepted: true, reason: null }));
    },
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: async () => {
      pullCalls++;
      return [];
    },
    pullLogEntriesPage: emptyPage,
  });

  try {
    // A cycle already in flight (triggerNow called directly, the way
    // recordLocalSave's debounce or a stray trigger would) — held open
    // mid-push by the gate.
    const firstCycle = engine.triggerNow();
    await waitFor(() => pushCalls >= 1, 'the first push must have started');
    assert.equal(pullCalls, 0, 'the gated cycle must not have reached the pull stage yet');

    // Sign-out then sign-in (or an account switch) landing while that
    // cycle is still stuck — found in review: start()'s own triggerNow()
    // call, arriving while cycleRunning is still true, used to be lost
    // entirely once the in-flight cycle's stale `myGeneration` failed
    // the old rerun-loop's generation check.
    engine.stop();
    engine.start();
    gate.release();
    await firstCycle;

    await waitFor(
      () => engine.getStatus() === 'synced',
      'a cycle for the new session must run once the first cycle unblocks'
    );
    assert.ok(
      pullCalls >= 1,
      "start()'s trigger must not be silently swallowed by the old cycle's stale generation — a whole new cycle must run and reach the pull stage"
    );
  } finally {
    engine.stop();
  }
});

test('recordLocalSave does not report a status or arm a debounce for a save invalidated by stop()', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  await writeJsonFileAtomic(dataFilePath, { schema: 3, items: [], arch: [], lastExport: 0 });

  const gate = makeGate();
  const statuses = [];
  let pushCalls = 0;
  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    saveDebounceMs: 10,
    onStatus: (s) => statuses.push(s),
    // Gates the merge-and-write inside recordLocalSave's own
    // withDataFile call, so stop() can run while the save is still
    // in flight (mirrors sign-out racing a data:save mid-merge).
    readDataFile: async (filePath, opts) => {
      await gate.wait;
      return readJsonFileStrict(filePath, opts);
    },
    pushItemsRpc: async (rows) => {
      pushCalls++;
      return rows.map((r) => ({ row_id: r.id, accepted: true, reason: null }));
    },
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  try {
    const savePromise = engine.recordLocalSave({
      schema: 3,
      items: [item('A', { updatedAt: 500 })],
      arch: [],
      lastExport: 0,
    });

    // recordLocalSave is blocked inside withDataFile's gated read by now.
    await new Promise((resolve) => setTimeout(resolve, 5));
    engine.stop();
    gate.release();
    await savePromise;

    // Long enough for a wrongly-armed debounce timer to have fired.
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(
      statuses,
      [],
      'no status may be reported for a save invalidated by a stop() that ran mid-save'
    );
    assert.equal(pushCalls, 0, 'no cycle may have been triggered by a debounce armed after stop()');
  } finally {
    engine.stop();
  }
});

test('a session read error is treated as a failed cycle, not "no signed-in user"', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  await writeJsonFileAtomic(dataFilePath, { schema: 3, items: [], arch: [], lastExport: 0 });

  let getSessionCalls = 0;
  const client = {
    auth: {
      // Mirrors auth-js's GoTrueClient.__loadSession: getSession()
      // returns { session: null, error } when the access token has
      // expired and its refresh hit a network error.
      async getSession() {
        getSessionCalls++;
        return { data: { session: null }, error: new TypeError('fetch failed') };
      },
    },
  };

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    backoffBaseMs: 15,
    backoffMaxMs: 30,
    pushItemsRpc: acceptAll(),
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  try {
    await engine.triggerNow();

    assert.equal(
      engine.getStatus(),
      'offline',
      'a session read error must not be treated as "no signed-in user"'
    );
    assert.equal(getSessionCalls, 1);

    await waitFor(
      () => getSessionCalls >= 2,
      'a session read error must schedule a retry, the same as any other failed cycle'
    );
  } finally {
    engine.stop();
  }
});

test('recordLocalSave still reports pending when the session read fails, instead of keeping the last status', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  await writeJsonFileAtomic(dataFilePath, { schema: 3, items: [], arch: [], lastExport: 0 });

  const client = {
    auth: {
      async getSession() {
        return { data: { session: null }, error: new TypeError('fetch failed') };
      },
    },
  };
  const statuses = [];
  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    onStatus: (s) => statuses.push(s),
    pushItemsRpc: acceptAll(),
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: emptyPage,
    pullLogEntriesPage: emptyPage,
  });

  try {
    await engine.recordLocalSave({
      schema: 3,
      items: [item('A', { updatedAt: 500 })],
      arch: [],
      lastExport: 0,
    });

    assert.deepEqual(
      statuses,
      ['pending'],
      'a save merged despite a session read error must still show pending'
    );
  } finally {
    engine.stop();
  }
});

/* ---------- Review round 3 fixes: two more data-loss races ---------- */

// Shared by both variants below (found in review — round 4: the round 3
// fix for this race only covered an unrelated pulled id, and missed the
// routine case where the pull's lookback window echoes this machine's own
// id back at it). Seeds A@1000 with an already-synced outbox, starts a
// cycle whose items pull is paused, races a local edit of A in while it's
// paused (recordLocalSave never blocks on the network, so its merge-and-
// write reaches disk immediately — only its outbox bookkeeping, behind
// getUserId, is gated), then lets the pull resolve to whatever
// `pulledRows` returns and asserts the local edit survives in the outbox
// and gets pushed on a later cycle.
async function assertLocalSaveSurvivesConcurrentPull(pulledRows) {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');

  const seedItem = item('A', { updatedAt: 1000 });
  await writeJsonFileAtomic(dataFilePath, {
    schema: 3,
    items: [seedItem],
    arch: [],
    lastExport: 0,
  });
  // Prime the outbox as already-synced, so the cycle's own start-of-cycle
  // diff (diffLocalChangesIntoOutbox) finds nothing to do — the race below
  // must be caused by the pull merge's own snapshot update alone, not by
  // that diff running concurrently with the save too.
  await writeJsonFileAtomic(
    syncStateFilePath,
    syncState.setUserState(syncState.emptyState(), 'u1', {
      ...syncState.emptyUserState(),
      snapshot: outbox.snapshotOf({ items: [seedItem], arch: [] }),
      firstSyncDone: true,
    })
  );

  // getSession is called once by the cycle itself (resolves immediately)
  // and once by the concurrent recordLocalSave — gated, so recordLocalSave
  // is still stuck (merged-and-written, but not yet diffed into the
  // outbox) while the pull below runs to completion.
  let sessionCalls = 0;
  const sessionGate = makeGate();
  const client = {
    auth: {
      async getSession() {
        sessionCalls += 1;
        if (sessionCalls === 2) await sessionGate.wait;
        return { data: { session: { user: { id: 'u1' } } }, error: null };
      },
    },
  };

  const pullGate = makeGate();
  let pullCalls = 0;
  const pushedItems = [];

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    pushItemsRpc: async (rows) => {
      pushedItems.push(...rows.map((r) => ({ id: r.id, name: r.name })));
      return rows.map((r) => ({ row_id: r.id, accepted: true, reason: null }));
    },
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: async () => {
      pullCalls += 1;
      if (pullCalls === 1) await pullGate.wait; // paused so the save can race in
      return pulledRows;
    },
    pullLogEntriesPage: emptyPage,
  });

  try {
    const cycle = engine.triggerNow();
    await waitFor(() => pullCalls >= 1, 'the pull must have started');

    // A local edit of A lands while the pull is stuck fetching its page.
    // recordLocalSave never blocks a save on the network, so its own
    // merge-and-write reaches disk immediately — only its outbox
    // bookkeeping (behind getUserId) is stuck on sessionGate.
    const savePromise = engine.recordLocalSave({
      schema: 3,
      items: [item('A', { updatedAt: 2000, name: 'edited locally' })],
      arch: [],
      lastExport: 0,
    });
    await waitFor(() => sessionCalls >= 2, 'recordLocalSave must have reached getUserId');

    const onDiskMidRace = await readJsonFile(dataFilePath);
    assert.equal(
      onDiskMidRace.items.find((i) => i.id === 'A').updatedAt,
      2000,
      'the local edit must already be on disk before the pull merge below runs'
    );

    // Let the pull merge finish. Its own withDataFile call reads the disk
    // state above (A already at 2000). Waiting on the sync-state file's
    // own itemsCursor (rather than on some pulled row landing on disk, as
    // round 3's version of this test did) works for both variants below —
    // including the echo variant, where the pull can leave the data file
    // completely untouched — because pullAll (see keyset.js) always
    // returns a cursor once any row comes back, and the cursor is
    // persisted in the same withUserState call as the snapshot patch this
    // test is really waiting to observe.
    pullGate.release();
    for (;;) {
      const state = await readJsonFile(syncStateFilePath);
      if (syncState.getUserState(state, 'u1').itemsCursor != null) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    sessionGate.release();
    await savePromise;
    await cycle;

    const state = await readJsonFile(syncStateFilePath);
    assert.deepEqual(
      syncState.getUserState(state, 'u1').pendingItemIds,
      ['A'],
      'the local edit made during the pull must still be queued for push, not silently marked "already seen"'
    );

    await engine.triggerNow();
    assert.ok(
      pushedItems.some((p) => p.id === 'A' && p.name === 'edited locally'),
      'the local edit must actually get pushed on a later cycle, not dropped forever'
    );
  } finally {
    engine.stop();
  }
}

test('a local save concurrent with a pull merge is not dropped from the outbox for good (unrelated pulled id)', async () => {
  await assertLocalSaveSurvivesConcurrentPull([
    {
      id: 'remote-1',
      name: 'from remote',
      status: 'active',
      priority: 'medium',
      category: '',
      notes: '',
      added_at: msToIso(1000),
      updated_at: msToIso(1000),
      reviewed_at: msToIso(1000),
      archived_at: null,
      deleted_at: null,
      synced_at: msToIso(1500),
    },
  ]);
});

test('a local save concurrent with a pull merge is not dropped from the outbox for good (echo of the edited id itself)', async () => {
  // The routine case round 3's fix missed (found in review — round 4
  // blocking issue): the lookback window (see keyset.js) re-pulls this
  // machine's own recently-pushed copy of A — synced_at 1500, updatedAt
  // 1000, an echo of the seed above — alongside a genuinely new remote
  // item, so the pull's merge does change *something* and reaches the
  // snapshot-patch branch at all. The echo loses the merge to the local
  // edit outright (1000 < 2000), so A's on-disk value never moves — the
  // bug was patching its outbox snapshot entry regardless.
  await assertLocalSaveSurvivesConcurrentPull([
    {
      id: 'A',
      name: 'A',
      status: 'active',
      priority: 'medium',
      category: '',
      notes: '',
      added_at: msToIso(1000),
      updated_at: msToIso(1000),
      reviewed_at: msToIso(1000),
      archived_at: null,
      deleted_at: null,
      synced_at: msToIso(1500),
    },
    {
      id: 'remote-2',
      name: 'from remote',
      status: 'active',
      priority: 'medium',
      category: '',
      notes: '',
      added_at: msToIso(1000),
      updated_at: msToIso(1000),
      reviewed_at: msToIso(1000),
      archived_at: null,
      deleted_at: null,
      synced_at: msToIso(1600),
    },
  ]);
});

test('a log entry pulled before its item’s newer copy arrives is not merged into the stale local copy', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');

  // This machine's own stale copy of A — hasn't yet pulled the rename
  // another machine pushed.
  const staleA = item('A', { updatedAt: 50, name: 'Old', reviewedAt: 50 });
  await writeJsonFileAtomic(dataFilePath, { schema: 3, items: [staleA], arch: [], lastExport: 0 });
  await writeJsonFileAtomic(
    syncStateFilePath,
    syncState.setUserState(syncState.emptyState(), 'u1', {
      ...syncState.emptyUserState(),
      snapshot: outbox.snapshotOf({ items: [staleA], arch: [] }),
      firstSyncDone: true,
    })
  );

  let itemsPullServesUpdate = false;
  const pushedItems = [];

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    pushItemsRpc: async (rows) => {
      pushedItems.push(...rows.map((r) => ({ id: r.id, name: r.name })));
      return rows.map((r) => ({ row_id: r.id, accepted: true, reason: null }));
    },
    pushLogEntriesRpc: acceptAll(),
    // The item pull lags a cycle behind the log-entry pull — the
    // split-pull race the review found: another machine's rename of A
    // (and the log entry it added alongside it) hasn't arrived via the
    // items pull yet, but the log entry already has via the log-entries
    // pull.
    pullItemsPage: async () => {
      if (!itemsPullServesUpdate) return [];
      return [
        {
          id: 'A',
          name: 'New',
          status: 'active',
          priority: 'medium',
          category: '',
          notes: '',
          added_at: msToIso(1000),
          updated_at: msToIso(200),
          reviewed_at: msToIso(10),
          archived_at: null,
          deleted_at: null,
          synced_at: msToIso(200),
        },
      ];
    },
    pullLogEntriesPage: async ({ afterId }) =>
      afterId
        ? []
        : [{ id: 'e1', item_id: 'A', ts: msToIso(200), text: 'renamed', synced_at: msToIso(200) }],
  });

  try {
    await engine.triggerNow(); // item pull empty; log-entries pull sees e1 (ts 200 > local A's updatedAt 50)

    const afterFirstCycle = await readJsonFile(dataFilePath);
    const aAfterFirst = afterFirstCycle.items.find((i) => i.id === 'A');
    assert.equal(
      aAfterFirst.name,
      'Old',
      'a log entry must not be merged into a stale local copy of the item it belongs to'
    );
    assert.equal(
      (aAfterFirst.log || []).length,
      0,
      'the log entry must not be merged into the item this cycle — its item version has not arrived yet'
    );
    assert.deepEqual(
      pushedItems,
      [],
      'the stale local copy must not get re-pushed over the pending remote rename'
    );

    // The item pull catches up next cycle, carrying the rename; the log
    // entry skipped above must still be retried and merged in alongside it.
    itemsPullServesUpdate = true;
    await engine.triggerNow();

    const afterSecondCycle = await readJsonFile(dataFilePath);
    const aAfterSecond = afterSecondCycle.items.find((i) => i.id === 'A');
    assert.equal(aAfterSecond.name, 'New', 'the rename must survive once its item pull catches up');
    assert.equal(aAfterSecond.updatedAt, 200);
    assert.deepEqual(
      aAfterSecond.log.map((e) => e.id),
      ['e1'],
      'the log entry from the first cycle must still get merged in, not lost'
    );
  } finally {
    engine.stop();
  }
});

test('the periodic interval skips its own trigger while backoff is active, and resumes once it clears', async () => {
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  // An item to push — an empty data file has nothing pending, so
  // pushItemsRpc (what `attempts` counts below) would never be called at
  // all (outbox.chunk of an empty list yields no batches).
  await writeJsonFileAtomic(dataFilePath, {
    schema: 3,
    items: [item('A', { updatedAt: 100 })],
    arch: [],
    lastExport: 0,
  });

  let shouldFail = true;
  let attempts = 0;
  // pushPendingItems clears item A from the outbox for good the moment
  // a push actually succeeds, so `attempts` (via pushItemsRpc) can't
  // prove the interval resumes afterwards — once A is synced there is
  // nothing left to push, ever again, even though further cycles keep
  // running. `cycles` (via pullItemsPage, which every complete cycle
  // reaches unconditionally, pending or not) is the reliable "did the
  // interval actually fire another cycle" signal for that part instead.
  let cycles = 0;
  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log: silentLog,
    intervalMs: 10,
    // Long enough that runCycle's own scheduled retry can't fire during
    // this test — only the periodic interval's own gate is under test.
    backoffBaseMs: 100_000,
    backoffMaxMs: 100_000,
    pushItemsRpc: async (rows) => {
      attempts++;
      if (shouldFail) throw new TypeError('fetch failed');
      return rows.map((r) => ({ row_id: r.id, accepted: true, reason: null }));
    },
    pushLogEntriesRpc: acceptAll(),
    pullItemsPage: async () => {
      cycles++;
      return [];
    },
    pullLogEntriesPage: emptyPage,
  });

  try {
    engine.start(); // triggers immediately -> first attempt fails, arms backoff
    await waitFor(() => attempts >= 1, 'the startup trigger must have run once');
    assert.equal(engine.getStatus(), 'offline');
    assert.equal(cycles, 0, 'a failing push must never reach the pull stage');

    const attemptsAfterFirstFailure = attempts;
    // Long enough for several 10ms interval ticks to have fired, if they
    // weren't gated by backoffAttempts > 0.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(
      attempts,
      attemptsAfterFirstFailure,
      'the interval must not trigger further cycles while backoff is active'
    );

    // A manually-triggered cycle now succeeds, resetting the backoff.
    shouldFail = false;
    await engine.triggerNow();
    assert.equal(engine.getStatus(), 'synced');
    assert.equal(cycles, 1, 'the manual retry cycle must have reached the pull stage');

    await waitFor(
      () => cycles > 1,
      'the interval must resume triggering cycles once backoff clears'
    );
  } finally {
    engine.stop();
  }
});

test('recordLocalSave does not fail the save when only the outbox bookkeeping write fails', async () => {
  // Found in review: recordLocalSave used to let a failure anywhere after
  // the data-file write (getUserId(), or sync-state.json's own write)
  // propagate out and fail the whole call, so data:save in main.js
  // returned { ok: false } even though the edit was already safely on
  // disk — misleading the renderer into thinking the save itself failed.
  // Only a failure of the data write itself should do that; a bookkeeping
  // failure (e.g. a disk-full sync-state.json) must be logged separately
  // and otherwise swallowed, since the next cycle's own start-of-cycle
  // diff (diffLocalChangesIntoOutbox) picks the change up regardless.
  const dir = await tmpDir();
  const dataFilePath = path.join(dir, 'data.json');
  const syncStateFilePath = path.join(dir, 'sync-state.json');
  const client = makeClient('u1');
  const { log, calls } = spyLog();

  const engine = createSyncEngine({
    client,
    dataFilePath,
    syncStateFilePath,
    log,
    writeJsonFileAtomic: async (filePath, data) => {
      if (filePath === syncStateFilePath) throw new Error('disk full');
      return writeJsonFileAtomic(filePath, data);
    },
  });

  try {
    const merged = await engine.recordLocalSave({
      schema: 3,
      items: [item('A', { updatedAt: 100 })],
      arch: [],
      lastExport: 0,
    });

    assert.deepEqual(
      merged.items.map((i) => i.id),
      ['A'],
      'the merged payload is still returned even though bookkeeping failed'
    );
    const onDisk = await readJsonFile(dataFilePath);
    assert.deepEqual(
      onDisk.items.map((i) => i.id),
      ['A'],
      'the data file write itself must have succeeded'
    );
    assert.equal(calls.error.length, 1, 'the bookkeeping failure must be logged, not swallowed');
    assert.match(calls.error[0][0], /outbox bookkeeping/i);
  } finally {
    // The debounce armed after a successful diff never got scheduled here
    // (the throw happens before that point), but stop() is still cheap
    // insurance against any timer this engine might have armed.
    engine.stop();
  }
});
