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

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, critical() {} };

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

function item(id, overrides) {
  return {
    id,
    name: id,
    status: 'active',
    priority: 'medium',
    category: '',
    notes: '',
    addedAt: 1000,
    updatedAt: 1000,
    reviewedAt: 1000,
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
  const outbox = require('../sync/outbox.js');
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
    let state = await readJsonFile(syncStateFilePath);
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
    assert.equal(secondPush[0].name, 'v2', 'v2 must be pushed on the next cycle, not silently dropped');
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
    assert.equal(stillOnDisk, corrupt, 'the corrupt file must be left untouched, never overwritten');
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
