'use strict';

// Durable, bounded project history.  History is deliberately kept separate
// from the current item and from its append-only activity log: restoring a
// snapshot must never remove notes or attachments added after that snapshot.

const crypto = require('crypto');

const SCHEMA = 1;
const RETENTION = 100;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const TIMESTAMP_FIELDS = ['addedAt', 'updatedAt', 'reviewedAt', 'archivedAt', 'deletedAt'];
const RESTORABLE_OPTIONAL_FIELDS = ['archivedAt', 'deletedAt'];

function timestampMs(value) {
  if (value === null || value === undefined || value === '') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeSnapshot(snapshot) {
  const normalized = clone(snapshot);
  if (!normalized || typeof normalized !== 'object') return null;
  for (const field of TIMESTAMP_FIELDS) {
    if (Object.hasOwn(normalized, field)) normalized[field] = timestampMs(normalized[field]);
  }
  return normalized;
}

function revisionOrderValue(revision) {
  return revision.serverReceivedAt || revision.clientTime || 0;
}

function itemSnapshot(item) {
  if (!item || typeof item !== 'object') return null;
  const snapshot = { ...item };
  // Activity entries are a separate append-only stream.  Keeping them out of
  // every revision makes history compact and avoids restoring away later notes.
  delete snapshot.log;
  return clone(snapshot);
}

function revisionId(itemId, action, clientTime, explicitId) {
  if (explicitId) return String(explicitId);
  // Baselines are deterministic across devices; ordinary edits use UUIDs so
  // two saves at the same timestamp remain independently recoverable.
  if (action === 'baseline') return `baseline-${itemId}-${clientTime}`;
  return crypto.randomUUID();
}

function makeRevision(item, options = {}) {
  const snapshot = itemSnapshot(item);
  if (!snapshot || !item.id) throw new TypeError('makeRevision requires an item with an id');
  const clientTime = Number.isFinite(options.clientTime)
    ? options.clientTime
    : Number.isFinite(item.updatedAt)
      ? item.updatedAt
      : Date.now();
  const action = options.action || 'edit';
  return {
    id: revisionId(item.id, action, clientTime, options.id),
    itemId: item.id,
    snapshotSchema: SCHEMA,
    snapshot,
    action,
    sourceDevice: options.sourceDevice || '',
    clientTime,
    serverReceivedAt: options.serverReceivedAt,
    restoredFromRevisionId: options.restoredFromRevisionId || null,
    origin: options.origin || 'local',
    status: options.status || 'pending',
  };
}

function normalizeRevision(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id || !raw.itemId) return null;
  const snapshot =
    raw.snapshot && typeof raw.snapshot === 'object' ? normalizeSnapshot(raw.snapshot) : null;
  if (!snapshot) return null;
  return {
    id: String(raw.id),
    itemId: String(raw.itemId),
    snapshotSchema: Number(raw.snapshotSchema || SCHEMA),
    snapshot,
    action: String(raw.action || 'edit'),
    sourceDevice: String(raw.sourceDevice || ''),
    clientTime: Number.isFinite(raw.clientTime) ? raw.clientTime : 0,
    ...(raw.serverReceivedAt ? { serverReceivedAt: timestampMs(raw.serverReceivedAt) } : {}),
    restoredFromRevisionId: raw.restoredFromRevisionId || null,
    origin: String(raw.origin || 'local'),
    status: String(raw.status || 'pending'),
  };
}

function sortRevisions(revisions) {
  return revisions
    .slice()
    .sort(
      (a, b) =>
        revisionOrderValue(b) - revisionOrderValue(a) ||
        (b.clientTime || 0) - (a.clientTime || 0) ||
        (b.id < a.id ? -1 : b.id > a.id ? 1 : 0)
    );
}

function retain(revisions, pendingIds = new Set(), limit = RETENTION) {
  const byRevisionId = new Map();
  for (const revision of revisions || []) {
    const normalized = normalizeRevision(revision);
    if (!normalized) continue;
    const existing = byRevisionId.get(normalized.id);
    // Prefer a server-acknowledged copy when the same revision was pulled
    // after a local pending copy.
    if (!existing || (existing.status === 'pending' && normalized.status !== 'pending')) {
      byRevisionId.set(normalized.id, normalized);
    }
  }
  const grouped = new Map();
  for (const revision of byRevisionId.values()) {
    const list = grouped.get(revision.itemId) || [];
    list.push(revision);
    grouped.set(revision.itemId, list);
  }
  const out = [];
  for (const list of grouped.values()) {
    const sorted = sortRevisions(list);
    const kept = sorted.filter(
      (revision, index) =>
        index < limit || pendingIds.has(revision.id) || revision.status === 'pending'
    );
    out.push(...kept);
  }
  return out.sort((a, b) =>
    a.itemId < b.itemId
      ? -1
      : a.itemId > b.itemId
        ? 1
        : revisionOrderValue(b) - revisionOrderValue(a) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0)
  );
}

function baselineData(data, options = {}) {
  const existing = Array.isArray(data && data.itemRevisions) ? data.itemRevisions : [];
  const knownItems = new Set(existing.map((revision) => revision && revision.itemId));
  const additions = [];
  for (const item of [...((data && data.items) || []), ...((data && data.arch) || [])]) {
    if (!item || !item.id || knownItems.has(item.id)) continue;
    const revision = makeRevision(item, {
      action: 'baseline',
      clientTime: Number.isFinite(item.updatedAt) ? item.updatedAt : options.now || Date.now(),
      sourceDevice: options.sourceDevice,
      origin: 'migration',
      status: 'pending',
    });
    knownItems.add(item.id);
    additions.push(revision);
  }
  return { ...data, itemRevisions: retain([...existing, ...additions], options.pendingIds) };
}

function shouldRecord(previous, next) {
  if (!previous || !next) return true;
  const before = itemSnapshot(previous) || {};
  const after = itemSnapshot(next) || {};
  delete before.updatedAt;
  delete after.updatedAt;
  return JSON.stringify(before) !== JSON.stringify(after);
}

function markSuperseded(data) {
  const revisions = Array.isArray(data && data.itemRevisions) ? data.itemRevisions : [];
  const newestByItem = new Map();
  for (const revision of revisions) {
    if (revision.status === 'pending') continue;
    const newest = newestByItem.get(revision.itemId);
    if (!newest || revisionOrderValue(revision) > revisionOrderValue(newest)) {
      newestByItem.set(revision.itemId, revision);
    }
  }
  return {
    ...data,
    itemRevisions: revisions.map((revision) => {
      const newest = newestByItem.get(revision.itemId);
      if (
        newest &&
        newest.id !== revision.id &&
        revision.status === 'synced' &&
        revisionOrderValue(revision) < revisionOrderValue(newest)
      )
        return { ...revision, status: 'superseded' };
      return revision;
    }),
  };
}

function append(data, items, options = {}) {
  const current = Array.isArray(data && data.itemRevisions) ? data.itemRevisions : [];
  const additions = (items || [])
    .filter(
      (item) =>
        item && (!options.previousById || shouldRecord(options.previousById.get(item.id), item))
    )
    .map((item) => makeRevision(item, options));
  return { ...data, itemRevisions: retain([...current, ...additions], options.pendingIds) };
}

function merge(data, incoming, options = {}) {
  return {
    ...data,
    itemRevisions: retain(
      [...((data && data.itemRevisions) || []), ...((incoming && incoming.itemRevisions) || [])],
      options.pendingIds
    ),
  };
}

function historyFor(data, itemId) {
  return sortRevisions(((data && data.itemRevisions) || []).filter((r) => r.itemId === itemId));
}

function compare(revision, item) {
  const before = revision && revision.snapshot ? revision.snapshot : {};
  const after = itemSnapshot(item) || {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((field) => ({
      field,
      before: clone(before[field]),
      after: clone(after[field]),
    }));
}

function restore(revision, current, options = {}) {
  if (!revision || !revision.snapshot || !current) return current;
  const snapshot = normalizeSnapshot(revision.snapshot) || {};
  const restored = {
    ...clone(current),
    ...snapshot,
    // Preserve identity and activity, while explicitly clearing optional
    // tombstone fields omitted by older snapshots.
    id: current.id,
    log: clone(current.log || []),
  };
  for (const field of RESTORABLE_OPTIONAL_FIELDS) {
    if (!Object.hasOwn(snapshot, field) || snapshot[field] === null) restored[field] = undefined;
  }
  if (options.now !== undefined)
    restored.updatedAt = Math.max(options.now, (current.updatedAt || 0) + 1);
  return restored;
}

function toPushRow(revision) {
  return {
    id: revision.id,
    itemId: revision.itemId,
    snapshotSchema: revision.snapshotSchema || SCHEMA,
    snapshot: clone(revision.snapshot),
    action: revision.action,
    sourceDevice: revision.sourceDevice || null,
    clientTime: revision.clientTime ? new Date(revision.clientTime).toISOString() : null,
    restoredFromRevisionId: revision.restoredFromRevisionId || null,
  };
}

function fromRow(row) {
  if (!row) return null;
  return normalizeRevision({
    id: row.id,
    itemId: row.item_id || row.itemId,
    snapshotSchema: row.snapshot_schema || row.snapshotSchema,
    snapshot: row.snapshot,
    action: row.action,
    sourceDevice: row.source_device || row.sourceDevice,
    clientTime: row.client_time ? new Date(row.client_time).getTime() : row.clientTime,
    serverReceivedAt: row.server_received_at,
    restoredFromRevisionId: row.restored_from_revision_id || row.restoredFromRevisionId,
    origin: row.origin || 'cloud',
    status: 'synced',
  });
}

module.exports = {
  SCHEMA,
  RETENTION,
  itemSnapshot,
  makeRevision,
  normalizeRevision,
  retain,
  baselineData,
  append,
  shouldRecord,
  markSuperseded,
  merge,
  historyFor,
  compare,
  restore,
  toPushRow,
  fromRow,
};
