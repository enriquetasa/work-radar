'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const S = require('../sync/sync-state.js');

test('emptyState has schema and an empty users map', () => {
  assert.deepEqual(S.emptyState(), { schema: S.SCHEMA, users: {} });
});

test('getUserState on an empty state returns a fresh empty user slice', () => {
  assert.deepEqual(S.getUserState(S.emptyState(), 'u1'), S.emptyUserState());
});

test('getUserState is tolerant of null/undefined/malformed state', () => {
  assert.deepEqual(S.getUserState(null, 'u1'), S.emptyUserState());
  assert.deepEqual(S.getUserState(undefined, 'u1'), S.emptyUserState());
  assert.deepEqual(S.getUserState({ users: 'not an object' }, 'u1'), S.emptyUserState());
  assert.deepEqual(S.getUserState({}, 'u1'), S.emptyUserState());
});

test('setUserState stores a slice retrievable by the same userId', () => {
  const state = S.setUserState(S.emptyState(), 'u1', {
    ...S.emptyUserState(),
    firstSyncDone: true,
  });
  assert.equal(S.getUserState(state, 'u1').firstSyncDone, true);
});

test('setUserState does not mutate the state it was given', () => {
  const original = S.emptyState();
  const originalCopy = JSON.parse(JSON.stringify(original));
  S.setUserState(original, 'u1', { ...S.emptyUserState(), firstSyncDone: true });
  assert.deepEqual(original, originalCopy);
});

test('two users keep separate slices', () => {
  let state = S.emptyState();
  state = S.setUserState(state, 'u1', { ...S.emptyUserState(), itemsCursor: 100 });
  state = S.setUserState(state, 'u2', { ...S.emptyUserState(), itemsCursor: 200 });
  assert.equal(S.getUserState(state, 'u1').itemsCursor, 100);
  assert.equal(S.getUserState(state, 'u2').itemsCursor, 200);
});

test('getUserState backfills missing fields on a partial/older slice', () => {
  const state = S.setUserState(S.emptyState(), 'u1', { firstSyncDone: true });
  const userState = S.getUserState(state, 'u1');
  assert.equal(userState.firstSyncDone, true);
  assert.deepEqual(userState.pendingItemIds, []);
  assert.deepEqual(userState.snapshot, { items: {}, logEntryIds: [] });
});

test('normalizeState resets a malformed top-level state to empty', () => {
  assert.deepEqual(S.normalizeState('nonsense'), S.emptyState());
  assert.deepEqual(S.normalizeState({ schema: 999 }), S.emptyState());
});
