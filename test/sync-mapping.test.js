'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const M = require('../sync/mapping.js');
const D = require('../renderer/domain.js');

test('msToIso/isoToMs round-trip a real timestamp', () => {
  const ms = Date.parse('2026-01-15T10:20:30.123Z');
  assert.equal(M.msToIso(ms), '2026-01-15T10:20:30.123Z');
  assert.equal(M.isoToMs(M.msToIso(ms)), ms);
});

test('msToIso/isoToMs treat null and undefined as null', () => {
  assert.equal(M.msToIso(null), null);
  assert.equal(M.msToIso(undefined), null);
  assert.equal(M.isoToMs(null), null);
  assert.equal(M.isoToMs(undefined), null);
});

test('isoToMs returns null (never NaN) for an unparseable string', () => {
  assert.equal(M.isoToMs('not a date'), null);
});

test('itemToPushRow converts every timestamp field and defaults category/notes', () => {
  const now = Date.now();
  const item = {
    id: 'i1',
    name: 'Alpha',
    status: 'active',
    priority: 'high',
    addedAt: now,
    updatedAt: now,
    reviewedAt: now,
  };
  const row = M.itemToPushRow(item);
  assert.equal(row.id, 'i1');
  assert.equal(row.name, 'Alpha');
  assert.equal(row.category, '');
  assert.equal(row.notes, '');
  assert.equal(row.addedAt, M.msToIso(now));
  assert.equal(row.updatedAt, M.msToIso(now));
  assert.equal(row.reviewedAt, M.msToIso(now));
  assert.equal(row.archivedAt, null);
  assert.equal(row.deletedAt, null);
});

test('itemToPushRow carries archivedAt/deletedAt through when present', () => {
  const now = Date.now();
  const item = {
    id: 'i2',
    name: 'Beta',
    status: 'watch',
    priority: 'low',
    category: 'oees',
    notes: 'note',
    addedAt: now,
    updatedAt: now,
    reviewedAt: now,
    archivedAt: now + 1,
    deletedAt: now + 2,
  };
  const row = M.itemToPushRow(item);
  assert.equal(row.archivedAt, M.msToIso(now + 1));
  assert.equal(row.deletedAt, M.msToIso(now + 2));
});

test('logEntryToPushRow attaches the given itemId and converts ts', () => {
  const entry = { id: 'e1', ts: 12345, text: 'update' };
  const row = M.logEntryToPushRow('item-1', entry);
  assert.deepEqual(row, { id: 'e1', itemId: 'item-1', ts: M.msToIso(12345), text: 'update' });
});

test('logEntryToPushRow defaults text to an empty string', () => {
  const row = M.logEntryToPushRow('item-1', { id: 'e1', ts: 1 });
  assert.equal(row.text, '');
});

test('rowToItem converts a full pulled row back to domain shape', () => {
  const now = Date.now();
  const row = {
    id: 'i1',
    name: 'Alpha',
    status: 'active',
    priority: 'high',
    category: 'oees',
    notes: 'n',
    added_at: M.msToIso(now),
    updated_at: M.msToIso(now),
    reviewed_at: M.msToIso(now),
    archived_at: M.msToIso(now + 1),
    deleted_at: M.msToIso(now + 2),
  };
  const item = M.rowToItem(row);
  assert.equal(item.id, 'i1');
  assert.equal(item.addedAt, now);
  assert.equal(item.updatedAt, now);
  assert.equal(item.reviewedAt, now);
  assert.equal(item.archivedAt, now + 1);
  assert.equal(item.deletedAt, now + 2);
  assert.deepEqual(item.log, []);
});

test('rowToItem leaves archivedAt/deletedAt undefined (not null) when unset', () => {
  const now = Date.now();
  const row = {
    id: 'i1',
    name: 'Alpha',
    status: 'active',
    priority: 'high',
    added_at: M.msToIso(now),
    updated_at: M.msToIso(now),
    reviewed_at: M.msToIso(now),
    archived_at: null,
    deleted_at: null,
  };
  const item = M.rowToItem(row);
  assert.equal(item.archivedAt, undefined);
  assert.equal(item.deletedAt, undefined);
});

test('rowToItem defaults category/notes to empty string when null', () => {
  const now = Date.now();
  const row = {
    id: 'i1',
    name: 'Alpha',
    status: 'active',
    priority: 'high',
    category: null,
    notes: null,
    added_at: M.msToIso(now),
    updated_at: M.msToIso(now),
    reviewed_at: M.msToIso(now),
  };
  const item = M.rowToItem(row);
  assert.equal(item.category, '');
  assert.equal(item.notes, '');
});

test('rowToLogEntry converts a pulled log_entries row back to domain shape', () => {
  const ts = Date.now();
  const row = { id: 'e1', item_id: 'i1', ts: M.msToIso(ts), text: 'note' };
  assert.deepEqual(M.rowToLogEntry(row), { id: 'e1', ts, text: 'note' });
});

test('a full item round-trips through push-row and pull-row shapes unchanged', () => {
  const now = Date.now();
  const item = {
    id: 'i1',
    name: 'Alpha',
    status: 'active',
    priority: 'high',
    category: 'oees',
    notes: 'note',
    reviewIntervalDays: 7,
    nextReviewOn: '2026-09-30',
    waitingOn: 'Alex',
    checkpoint: 'Budget decision',
    checkpointOn: '2026-09-28',
    addedAt: now - 3000,
    updatedAt: now,
    reviewedAt: now - 1000,
    archivedAt: undefined,
    deletedAt: undefined,
  };
  const pushRow = M.itemToPushRow(item);
  // Simulate what a select('*') would return once that push row lands
  // in Postgres: same fields, snake_case, archivedAt/deletedAt as null.
  const pulledRow = {
    id: pushRow.id,
    name: pushRow.name,
    status: pushRow.status,
    priority: pushRow.priority,
    category: pushRow.category,
    notes: pushRow.notes,
    review_interval_days: pushRow.reviewIntervalDays,
    next_review_on: pushRow.nextReviewOn,
    waiting_on: pushRow.waitingOn,
    checkpoint: pushRow.checkpoint,
    checkpoint_on: pushRow.checkpointOn,
    added_at: pushRow.addedAt,
    updated_at: pushRow.updatedAt,
    reviewed_at: pushRow.reviewedAt,
    archived_at: pushRow.archivedAt,
    deleted_at: pushRow.deletedAt,
  };
  const roundTripped = M.rowToItem(pulledRow);
  assert.deepEqual(roundTripped, { ...item, log: [] });
});

test('legacy server rows normalize exactly like migrated local items', () => {
  const reviewedAt = new Date(2026, 8, 23, 23, 30).getTime();
  const item = { id: 'legacy', reviewedAt, addedAt: reviewedAt, updatedAt: reviewedAt };
  const pulled = M.rowToItem({
    id: item.id,
    reviewed_at: M.msToIso(reviewedAt),
    added_at: M.msToIso(reviewedAt),
    updated_at: M.msToIso(reviewedAt),
  });
  assert.deepEqual(D.normalizeSchedule(pulled), D.normalizeSchedule(item));
  assert.equal(pulled.reviewIntervalDays, 14);
  assert.equal(pulled.nextReviewOn, '2026-10-07');
});

test('manual cadence and cleared optional fields survive the wire boundary', () => {
  const item = {
    reviewIntervalDays: null,
    nextReviewOn: '',
    waitingOn: '',
    checkpoint: '',
    checkpointOn: '',
  };
  const pushed = M.itemToPushRow(item);
  assert.equal(pushed.reviewIntervalDays, null);
  assert.equal(pushed.nextReviewOn, '');
  const pulled = M.rowToItem({
    review_interval_days: null,
    next_review_on: null,
    waiting_on: null,
    checkpoint: null,
    checkpoint_on: null,
  });
  assert.deepEqual(D.normalizeSchedule(pulled), item);
});
