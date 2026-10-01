'use strict';
const { normalizeSchedule } = require('../renderer/domain.js');
const history = require('./history.js');

// Use explicit nulls on the JSON wire; domain objects use undefined for unset timestamps.
function msToIso(ms) {
  if (ms === null || ms === undefined) return null;
  return new Date(ms).toISOString();
}

function isoToMs(iso) {
  if (iso === null || iso === undefined) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function itemToPushRow(item) {
  return {
    id: item.id,
    name: item.name,
    status: item.status,
    priority: item.priority,
    category: item.category || '',
    notes: item.notes || '',
    ...normalizeSchedule(item),
    addedAt: msToIso(item.addedAt),
    updatedAt: msToIso(item.updatedAt),
    reviewedAt: msToIso(item.reviewedAt),
    archivedAt: msToIso(item.archivedAt),
    deletedAt: msToIso(item.deletedAt),
  };
}

function logEntryToPushRow(itemId, entry) {
  return { id: entry.id, itemId, ts: msToIso(entry.ts), text: entry.text || '' };
}

function rowToItem(row) {
  const item = {
    id: row.id,
    name: row.name,
    status: row.status,
    priority: row.priority,
    category: row.category || '',
    notes: row.notes || '',
    reviewIntervalDays: row.review_interval_days,
    nextReviewOn: row.next_review_on || '',
    waitingOn: row.waiting_on || '',
    checkpoint: row.checkpoint || '',
    checkpointOn: row.checkpoint_on || '',
    addedAt: isoToMs(row.added_at),
    updatedAt: isoToMs(row.updated_at),
    reviewedAt: isoToMs(row.reviewed_at),
    archivedAt: isoToMs(row.archived_at) || undefined,
    deletedAt: isoToMs(row.deleted_at) || undefined,
    log: [],
  };
  return { ...item, ...normalizeSchedule(item) };
}

function rowToLogEntry(row) {
  return { id: row.id, ts: isoToMs(row.ts), text: row.text || '' };
}

// History uses an independent, idempotent revision stream.
function revisionToPushRow(revision) {
  return {
    id: revision.id,
    itemId: revision.itemId,
    snapshotSchema: revision.snapshotSchema || 1,
    snapshot: revision.snapshot,
    action: revision.action || 'edit',
    sourceDevice: revision.sourceDevice || null,
    clientTime: msToIso(revision.clientTime),
    restoredFromRevisionId: revision.restoredFromRevisionId || null,
  };
}

function rowToRevision(row) {
  return history.fromRow(row);
}

module.exports = {
  msToIso,
  isoToMs,
  itemToPushRow,
  logEntryToPushRow,
  rowToItem,
  rowToLogEntry,
  revisionToPushRow,
  rowToRevision,
};
