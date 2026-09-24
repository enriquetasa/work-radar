'use strict';
/* ============================================================
   WORK RADAR — sync state shape
   Pure helpers over the shape persisted to sync-state.json (see
   sync/atomic-json-file.js for the actual IO, and sync-engine.js for
   who calls these). No IO here, so the shape/defaults are unit-testable
   on their own.

   Keyed by Supabase user id, not just "this machine": a machine could
   in principle sign out and sign back in as a different account, and
   each account's outbox/cursors/first-sync flag must not leak into the
   other's.
   ============================================================ */

const SCHEMA = 1;

// A fresh user's slice: nothing pushed, nothing pulled, first sync not
// yet done. `snapshot` is outbox.js's snapshotOf() shape — see there.
function emptyUserState() {
  return {
    pendingItemIds: [],
    pendingLogEntryIds: [],
    itemsCursor: null,
    logEntriesCursor: null,
    snapshot: { items: {}, logEntryIds: [] },
    firstSyncDone: false,
  };
}

function emptyState() {
  return { schema: SCHEMA, users: {} };
}

// Tolerant of a missing/corrupt/older state object — always returns a
// well-shaped state, never throws, so a first run (no file yet) or a
// hand-edited/corrupt sync-state.json degrades to "start fresh" rather
// than crashing the sync engine.
function normalizeState(state) {
  if (!state || typeof state !== 'object' || typeof state.users !== 'object' || !state.users) {
    return emptyState();
  }
  return { schema: SCHEMA, users: state.users };
}

function getUserState(state, userId) {
  const normalized = normalizeState(state);
  const existing = normalized.users[userId];
  return existing ? { ...emptyUserState(), ...existing } : emptyUserState();
}

// Returns a *new* top-level state with this user's slice replaced —
// never mutates the input, so callers can safely hold onto a state they
// read earlier.
function setUserState(state, userId, userState) {
  const normalized = normalizeState(state);
  return { ...normalized, users: { ...normalized.users, [userId]: userState } };
}

module.exports = { SCHEMA, emptyState, emptyUserState, normalizeState, getUserState, setUserState };
