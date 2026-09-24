'use strict';
/* ============================================================
   WORK RADAR — sync timestamp/row mapping
   The one place ms-epoch numbers (the client's internal representation,
   per renderer/domain.js) convert to/from Postgres `timestamptz` values,
   and domain item/log-entry shapes convert to/from the wire shapes used
   by the push RPCs (camelCase, ISO strings — see
   supabase/migrations/..._push_rpc_functions.sql) and by a plain
   `select('*')` pull (snake_case, ISO strings — see
   supabase/migrations/..._create_items_and_log_entries_tables.sql).

   Pure, no IO, no Supabase client — safe to unit-test directly (see
   docs/supabase-sync-plan.md's Phase 4 notes on why this is its own
   module rather than inlined in the sync engine).
   ============================================================ */

// undefined/null/0-that-means-"unset" all round-trip through here as
// null: domain.js items use `undefined` for an unset archivedAt/deletedAt
// (see migrate()), but `undefined` doesn't survive JSON.stringify inside
// an array element the way `null` does (jsonb_array_elements would just
// drop the key), so the wire form is always explicit `null`.
function msToIso(ms) {
  if (ms === null || ms === undefined) return null;
  return new Date(ms).toISOString();
}

// The inverse. An unparseable/missing input becomes null, never NaN —
// callers (rowToItem/rowToLogEntry) then normalise that to `undefined`
// where domain.js expects an unset field.
function isoToMs(iso) {
  if (iso === null || iso === undefined) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// A domain.js item -> the jsonb shape push_items expects (camelCase,
// ISO timestamps). `category`/`notes` default to '' the same way
// domain.js's migrate() does, so a legacy/partial item still pushes
// cleanly.
function itemToPushRow(item) {
  return {
    id: item.id,
    name: item.name,
    status: item.status,
    priority: item.priority,
    category: item.category || '',
    notes: item.notes || '',
    addedAt: msToIso(item.addedAt),
    updatedAt: msToIso(item.updatedAt),
    reviewedAt: msToIso(item.reviewedAt),
    archivedAt: msToIso(item.archivedAt),
    deletedAt: msToIso(item.deletedAt),
  };
}

// A domain.js log entry (plus the id of the item it belongs to, which
// domain.js's own log entries don't carry — they live nested inside
// their item) -> the jsonb shape push_log_entries expects.
function logEntryToPushRow(itemId, entry) {
  return { id: entry.id, itemId, ts: msToIso(entry.ts), text: entry.text || '' };
}

// A pulled `items` row (snake_case, ISO timestamps, as returned by a
// plain `select('*')`) -> a domain.js item, minus its log (log entries
// are a separate table/pull — see sync-engine.js). archivedAt/deletedAt
// come back as `undefined` rather than `null` when unset, matching
// domain.js's own convention (isStale/mergeItem etc. use `!item.archivedAt`).
function rowToItem(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    priority: row.priority,
    category: row.category || '',
    notes: row.notes || '',
    addedAt: isoToMs(row.added_at),
    updatedAt: isoToMs(row.updated_at),
    reviewedAt: isoToMs(row.reviewed_at),
    archivedAt: isoToMs(row.archived_at) || undefined,
    deletedAt: isoToMs(row.deleted_at) || undefined,
    log: [],
  };
}

// A pulled `log_entries` row -> a domain.js log entry ({id, ts, text}).
// The item it belongs to (row.item_id) is handled by the caller, which
// groups pulled rows by item before merging them in.
function rowToLogEntry(row) {
  return { id: row.id, ts: isoToMs(row.ts), text: row.text || '' };
}

module.exports = {
  msToIso,
  isoToMs,
  itemToPushRow,
  logEntryToPushRow,
  rowToItem,
  rowToLogEntry,
};
