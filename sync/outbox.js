'use strict';
/* ============================================================
   WORK RADAR — outbox diffing
   Works out which items/log entries need pushing by comparing a
   data:save payload against a lightweight snapshot of the last payload
   the sync engine saw — never by trusting the renderer to report what
   changed (see docs/supabase-sync-plan.md's Phase 4 notes). Pure, no IO.

   `data` throughout is the shape renderer/domain.js's serialize()
   produces: { items: [...], arch: [...] } (each item optionally
   carrying a `log` array).
   ============================================================ */

// A snapshot is deliberately tiny — just enough to detect "this item
// changed" (its updatedAt moved) and "this log entry is new" (its id
// wasn't seen before) — so it's cheap to persist in sync-state.json
// alongside the outbox itself, rather than keeping a full copy of the
// last-synced data file around.
function snapshotOf(data) {
  const items = {};
  const logEntryIds = [];
  [...(data.items || []), ...(data.arch || [])].forEach((item) => {
    items[item.id] = item.updatedAt;
    (item.log || []).forEach((e) => logEntryIds.push(e.id));
  });
  return { items, logEntryIds };
}

// Compares two snapshots and returns the ids that need to be (re-)pushed:
// an item whose id is new or whose updatedAt moved, and a log entry
// whose id wasn't in the previous snapshot at all (log entries are
// append-only — they never change once written, so "new id" is the only
// way one can need pushing).
function diffSnapshot(prev, next) {
  const prevItems = (prev && prev.items) || {};
  const prevLogIds = new Set((prev && prev.logEntryIds) || []);
  const changedItemIds = Object.keys(next.items).filter(
    (id) => prevItems[id] === undefined || prevItems[id] !== next.items[id]
  );
  const newLogEntryIds = next.logEntryIds.filter((id) => !prevLogIds.has(id));
  return { changedItemIds, newLogEntryIds };
}

// Deduplicated union, order-preserving (existing ids first) so a
// repeatedly-failing id doesn't get reshuffled to the back of the queue
// on every retry.
function unionIds(a, b) {
  const seen = new Set(a || []);
  const out = [...(a || [])];
  (b || []).forEach((id) => {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  });
  return out;
}

function removeIds(ids, toRemove) {
  const gone = new Set(toRemove);
  return (ids || []).filter((id) => !gone.has(id));
}

// Indexes the full data file by id, for turning a list of pending ids
// (which is all the persisted outbox keeps) back into pushable rows.
// Log entries are indexed with the id of the item they belong to, since
// push_log_entries needs itemId and domain.js's log entries don't carry
// it themselves (they live nested inside their item).
function indexData(data) {
  const itemsById = new Map();
  const logEntriesById = new Map();
  [...(data.items || []), ...(data.arch || [])].forEach((item) => {
    itemsById.set(item.id, item);
    (item.log || []).forEach((entry) => {
      logEntriesById.set(entry.id, { itemId: item.id, entry });
    });
  });
  return { itemsById, logEntriesById };
}

// Splits an array into chunks of at most `size` — used to keep push
// batches (and, incidentally, any other bulk RPC call) bounded.
function chunk(arr, size) {
  if (!arr.length) return [];
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

module.exports = { snapshotOf, diffSnapshot, unionIds, removeIds, indexData, chunk };
