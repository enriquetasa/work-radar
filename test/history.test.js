'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../sync/history.js');

function item(id, updatedAt, patch = {}) {
  return {
    id,
    name: id,
    status: 'active',
    priority: 'medium',
    addedAt: 1,
    updatedAt,
    reviewedAt: updatedAt,
    log: [],
    ...patch,
  };
}

test('each local save creates an immutable snapshot without activity log entries', () => {
  const first = H.makeRevision(item('a', 10, { notes: 'one', log: [{ id: 'e1' }] }), { id: 'r1' });
  const second = H.makeRevision(item('a', 11, { notes: 'two' }), { id: 'r2' });
  assert.equal(first.snapshot.notes, 'one');
  assert.equal(first.snapshot.log, undefined);
  const data = H.append({ itemRevisions: [first] }, [item('a', 11, { notes: 'two' })], {
    id: 'ignored',
  });
  assert.equal(data.itemRevisions.length, 2);
  assert.notEqual(data.itemRevisions[0].snapshot, second.snapshot);
});

test('baseline is deterministic and retention keeps newest 100', () => {
  const base = H.baselineData({ items: [item('a', 1)], arch: [] });
  assert.equal(base.itemRevisions.length, 1);
  assert.equal(
    H.baselineData({ items: [item('a', 1)], arch: [] }).itemRevisions[0].id,
    base.itemRevisions[0].id
  );
  let data = base;
  for (let n = 2; n <= 110; n++) data = H.append(data, [item('a', n)]);
  data.itemRevisions = data.itemRevisions.map((revision) => ({ ...revision, status: 'synced' }));
  data.itemRevisions = H.retain(data.itemRevisions);
  assert.equal(H.historyFor(data, 'a').length, 100);
});

test('restore preserves later activity and compare reports field changes', () => {
  const old = H.makeRevision(item('a', 10, { notes: 'old' }), { id: 'old' });
  const current = item('a', 20, { notes: 'new', log: [{ id: 'e1', text: 'later' }] });
  assert.deepEqual(
    H.compare(old, current).find((change) => change.field === 'notes'),
    {
      field: 'notes',
      before: 'old',
      after: 'new',
    }
  );
  const restored = H.restore(old, current, { now: 30 });
  assert.equal(restored.notes, 'old');
  assert.deepEqual(restored.log, current.log);
  assert.equal(restored.updatedAt, 30);
});

test('wire rows round trip timestamps and immutable metadata', () => {
  const revision = H.makeRevision(item('a', 100), {
    id: 'r1',
    action: 'restore',
    restoredFromRevisionId: 'r0',
    sourceDevice: 'laptop',
  });
  const row = H.toPushRow(revision);
  const roundTrip = H.fromRow({
    id: row.id,
    item_id: row.itemId,
    snapshot_schema: row.snapshotSchema,
    snapshot: row.snapshot,
    action: row.action,
    source_device: row.sourceDevice,
    client_time: row.clientTime,
    restored_from_revision_id: row.restoredFromRevisionId,
  });
  assert.equal(roundTrip.id, 'r1');
  assert.equal(roundTrip.clientTime, 100);
  assert.equal(roundTrip.action, 'restore');
});

test('cloud rows normalize ISO snapshot timestamps and order by server receipt', () => {
  const olderClient = H.fromRow({
    id: 'r-old',
    item_id: 'a',
    snapshot_schema: 1,
    snapshot: {
      id: 'a',
      addedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    },
    action: 'edit',
    client_time: '2026-01-02T00:00:00.000Z',
    server_received_at: '2026-01-03T00:00:00.000Z',
  });
  const newerClient = H.fromRow({
    id: 'r-new',
    item_id: 'a',
    snapshot_schema: 1,
    snapshot: { id: 'a', addedAt: 2, updatedAt: 3 },
    action: 'edit',
    client_time: '2026-01-04T00:00:00.000Z',
    server_received_at: '2026-01-04T00:00:00.000Z',
  });
  assert.equal(olderClient.snapshot.updatedAt, Date.parse('2026-01-01T00:00:01.000Z'));
  assert.equal(H.historyFor({ itemRevisions: [newerClient, olderClient] }, 'a')[0].id, 'r-new');
});

test('log-only changes do not create revisions and synced edits become superseded', () => {
  const previous = item('a', 10, { notes: 'same', log: [] });
  const logOnly = item('a', 11, {
    notes: 'same',
    reviewedAt: 10,
    log: [{ id: 'l1', text: 'note' }],
  });
  assert.equal(H.shouldRecord(previous, logOnly), false);
  const old = H.makeRevision(item('a', 10, { notes: 'old' }), {
    id: 'old',
    status: 'synced',
    serverReceivedAt: 100,
  });
  const latest = H.makeRevision(item('a', 20, { notes: 'new' }), {
    id: 'latest',
    status: 'synced',
    serverReceivedAt: 200,
  });
  const marked = H.markSuperseded({ itemRevisions: [old, latest] });
  assert.equal(marked.itemRevisions.find((r) => r.id === 'old').status, 'superseded');
  assert.equal(marked.itemRevisions.find((r) => r.id === 'latest').status, 'synced');
});

test('five saves remain independently restorable and tombstone fields clear on restore', () => {
  let data = { itemRevisions: [] };
  for (let n = 1; n <= 5; n++) {
    const next = item('a', n, { notes: `version-${n}` });
    data = H.append(data, [next], { previousById: new Map() });
  }
  assert.equal(H.historyFor(data, 'a').length, 5);
  const current = item('a', 50, { notes: 'deleted', archivedAt: 50, deletedAt: 50 });
  const restored = H.restore(H.historyFor(data, 'a')[0], current, { now: 51 });
  assert.equal(restored.notes, 'version-5');
  assert.equal(restored.archivedAt, undefined);
  assert.equal(restored.deletedAt, undefined);
});
