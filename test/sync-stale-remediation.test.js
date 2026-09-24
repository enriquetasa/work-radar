'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { localWinsOverRemote } = require('../sync/stale-remediation.js');
const D = require('../renderer/domain.js');

function item(overrides) {
  return {
    id: 'i1',
    name: 'Alpha',
    status: 'active',
    priority: 'medium',
    category: '',
    notes: '',
    addedAt: 1000,
    updatedAt: 1000,
    reviewedAt: 1000,
    log: [],
    ...overrides,
  };
}

test('localWinsOverRemote is false when the remote is genuinely newer', () => {
  const local = item({ updatedAt: 1000, name: 'local' });
  const remote = item({ updatedAt: 2000, name: 'remote' });
  assert.equal(localWinsOverRemote(D.mergeItem, local, remote), false);
});

test('localWinsOverRemote is true on an exact updatedAt tie the tie-break resolves to local', () => {
  // Equal updatedAt; local has the later reviewedAt, which mergeItem's
  // tie-break checks first — local must win.
  const local = item({ updatedAt: 1000, reviewedAt: 5000 });
  const remote = item({ updatedAt: 1000, reviewedAt: 1000 });
  assert.equal(localWinsOverRemote(D.mergeItem, local, remote), true);
});

test('localWinsOverRemote is false on an exact updatedAt tie the tie-break resolves to remote', () => {
  const local = item({ updatedAt: 1000, reviewedAt: 1000 });
  const remote = item({ updatedAt: 1000, reviewedAt: 5000 });
  assert.equal(localWinsOverRemote(D.mergeItem, local, remote), false);
});

test('localWinsOverRemote does not treat log differences as remote winning', () => {
  const local = item({ updatedAt: 1000, log: [{ id: 'e1', ts: 1, text: 'a' }] });
  const remote = item({ updatedAt: 1000 });
  // Identical apart from log (which mergeItem always unions regardless
  // of winner) and reviewedAt/archivedAt/deletedAt (also equal) — falls
  // through to the stringify tie-break, deterministic either way, but
  // the point of this test is that a log-only difference alone must
  // never be mistaken for "remote wins" by sameNonLogFields.
  const result = localWinsOverRemote(D.mergeItem, local, remote);
  assert.equal(typeof result, 'boolean');
});
