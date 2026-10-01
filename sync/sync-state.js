'use strict';
const SCHEMA = 1;

function emptyUserState() {
  return {
    pendingItemIds: [],
    pendingLogEntryIds: [],
    pendingRevisionIds: [],
    revisionCursor: null,
    revisionIds: [],
    itemsCursor: null,
    logEntriesCursor: null,
    snapshot: { items: {}, logEntryIds: [] },
    firstSyncDone: false,
  };
}

function emptyState() {
  return { schema: SCHEMA, users: {} };
}

// Malformed or older state resets safely to an empty state.
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

function setUserState(state, userId, userState) {
  const normalized = normalizeState(state);
  return { ...normalized, users: { ...normalized.users, [userId]: userState } };
}

module.exports = { SCHEMA, emptyState, emptyUserState, normalizeState, getUserState, setUserState };
