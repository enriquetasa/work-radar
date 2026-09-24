'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeSyncView } = require('../renderer/sync-view.js');

test('hides the indicator when there is no status yet', () => {
  assert.deepEqual(computeSyncView(undefined), { hidden: true, label: '', className: '' });
});

test('hides the indicator when state is null (sync not configured / signed out)', () => {
  assert.deepEqual(computeSyncView({ state: null }), { hidden: true, label: '', className: '' });
});

test('shows SYNCED in the synced colour class', () => {
  assert.deepEqual(computeSyncView({ state: 'synced' }), {
    hidden: false,
    label: '● Synced',
    className: 'sync-synced',
  });
});

test('shows PENDING, OFFLINE and SYNC ERROR for the other three states', () => {
  assert.equal(computeSyncView({ state: 'pending' }).label, '◌ Syncing');
  assert.equal(
    computeSyncView({ state: 'offline' }).label,
    '● Offline · changes stay on this device'
  );
  assert.equal(
    computeSyncView({ state: 'error' }).label,
    '⚠ Sync error · changes stay on this device'
  );
  assert.equal(computeSyncView({ state: 'pending' }).className, 'sync-pending');
  assert.equal(computeSyncView({ state: 'offline' }).className, 'sync-offline');
  assert.equal(computeSyncView({ state: 'error' }).className, 'sync-error');
});

test('an unrecognised state hides the indicator rather than showing garbage', () => {
  assert.deepEqual(computeSyncView({ state: 'bogus' }), { hidden: true, label: '', className: '' });
});
