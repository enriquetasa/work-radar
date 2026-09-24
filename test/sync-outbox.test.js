'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const O = require('../sync/outbox.js');

function item(id, updatedAt, log) {
  return { id, name: id, status: 'active', priority: 'medium', updatedAt, log: log || [] };
}

test('snapshotOf captures each item id -> updatedAt across items and arch', () => {
  const data = { items: [item('a', 1)], arch: [item('b', 2)] };
  const snap = O.snapshotOf(data);
  assert.deepEqual(snap.items, { a: 1, b: 2 });
  assert.deepEqual(snap.logEntryIds, []);
});

test('snapshotOf collects log entry ids from every item', () => {
  const data = {
    items: [item('a', 1, [{ id: 'e1', ts: 1, text: 't' }])],
    arch: [item('b', 2, [{ id: 'e2', ts: 2, text: 't2' }])],
  };
  const snap = O.snapshotOf(data);
  assert.deepEqual(snap.logEntryIds.sort(), ['e1', 'e2']);
});

test('snapshotOf tolerates missing items/arch arrays', () => {
  assert.deepEqual(O.snapshotOf({}), { items: {}, logEntryIds: [] });
});

test('diffSnapshot reports a brand-new item as changed', () => {
  const prev = O.snapshotOf({ items: [], arch: [] });
  const next = O.snapshotOf({ items: [item('a', 100)], arch: [] });
  const diff = O.diffSnapshot(prev, next);
  assert.deepEqual(diff.changedItemIds, ['a']);
  assert.deepEqual(diff.newLogEntryIds, []);
});

test('diffSnapshot reports an item whose updatedAt moved as changed', () => {
  const prev = O.snapshotOf({ items: [item('a', 100)], arch: [] });
  const next = O.snapshotOf({ items: [item('a', 200)], arch: [] });
  assert.deepEqual(O.diffSnapshot(prev, next).changedItemIds, ['a']);
});

test('diffSnapshot does not report an unchanged item', () => {
  const prev = O.snapshotOf({ items: [item('a', 100)], arch: [] });
  const next = O.snapshotOf({ items: [item('a', 100)], arch: [] });
  assert.deepEqual(O.diffSnapshot(prev, next).changedItemIds, []);
});

test('diffSnapshot reports a log entry with a new id as new, but not one already seen', () => {
  const prev = O.snapshotOf({ items: [item('a', 1, [{ id: 'e1', ts: 1, text: 't' }])], arch: [] });
  const next = O.snapshotOf({
    items: [
      item('a', 1, [
        { id: 'e1', ts: 1, text: 't' },
        { id: 'e2', ts: 2, text: 't2' },
      ]),
    ],
    arch: [],
  });
  assert.deepEqual(O.diffSnapshot(prev, next).newLogEntryIds, ['e2']);
});

test('diffSnapshot against an empty/undefined previous snapshot treats everything as new', () => {
  const next = O.snapshotOf({ items: [item('a', 1, [{ id: 'e1', ts: 1, text: 't' }])], arch: [] });
  const diff = O.diffSnapshot(undefined, next);
  assert.deepEqual(diff.changedItemIds, ['a']);
  assert.deepEqual(diff.newLogEntryIds, ['e1']);
});

test('unionIds dedupes and preserves the order of the first list', () => {
  assert.deepEqual(O.unionIds(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
  assert.deepEqual(O.unionIds([], ['a']), ['a']);
  assert.deepEqual(O.unionIds(['a'], []), ['a']);
  assert.deepEqual(O.unionIds(undefined, undefined), []);
});

test('removeIds drops only the given ids, keeping the rest in order', () => {
  assert.deepEqual(O.removeIds(['a', 'b', 'c'], ['b']), ['a', 'c']);
  assert.deepEqual(O.removeIds(['a'], []), ['a']);
  assert.deepEqual(O.removeIds(undefined, ['a']), []);
});

test('indexData maps item ids to items and log entry ids to {itemId, entry}', () => {
  const entry = { id: 'e1', ts: 1, text: 't' };
  const data = { items: [item('a', 1, [entry])], arch: [item('b', 2)] };
  const { itemsById, logEntriesById } = O.indexData(data);
  assert.equal(itemsById.get('a').id, 'a');
  assert.equal(itemsById.get('b').id, 'b');
  assert.deepEqual(logEntriesById.get('e1'), { itemId: 'a', entry });
});

test('chunk splits into groups of at most `size`, preserving order', () => {
  assert.deepEqual(O.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(O.chunk([], 2), []);
  assert.deepEqual(O.chunk([1], 10), [[1]]);
});
