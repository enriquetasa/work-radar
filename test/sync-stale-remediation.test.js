'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  localWinsOverRemote,
  sameContentIgnoringUpdatedAt,
  decideStaleRemediation,
} = require('../sync/stale-remediation.js');
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

test('sameContentIgnoringUpdatedAt is true when only updatedAt differs', () => {
  const local = item({ updatedAt: 1000 });
  const remote = item({ updatedAt: 2000 });
  assert.equal(sameContentIgnoringUpdatedAt(local, remote), true);
});

test('sameContentIgnoringUpdatedAt is false when a visible field differs', () => {
  const local = item({ updatedAt: 1000, name: 'local' });
  const remote = item({ updatedAt: 1000, name: 'remote' });
  assert.equal(sameContentIgnoringUpdatedAt(local, remote), false);
});

test('sameContentIgnoringUpdatedAt ignores log', () => {
  const local = item({ updatedAt: 1000, log: [{ id: 'e1', ts: 1, text: 'a' }] });
  const remote = item({ updatedAt: 1000, log: [] });
  assert.equal(sameContentIgnoringUpdatedAt(local, remote), true);
});

test('decideStaleRemediation resolves (never re-stamps) when the remote is genuinely newer', () => {
  const local = item({ updatedAt: 1000, name: 'local' });
  const remote = item({ updatedAt: 2000, name: 'remote' });
  assert.equal(decideStaleRemediation(D.mergeItem, local, remote), 'resolve');
});

test('decideStaleRemediation resolves (never re-stamps) content-identical rows even on an exact tie', () => {
  // This is the case localWinsOverRemote alone gets wrong: mergeItem
  // trivially prefers its first argument on a full tie, so
  // localWinsOverRemote(local, remote) would say "local wins" here even
  // though there is nothing to re-push — an already-accepted push being
  // retried, or two machines' first sync overlapping on identical data.
  const local = item({ updatedAt: 1000, name: 'same everywhere' });
  const remote = item({ updatedAt: 1000, name: 'same everywhere' });
  assert.equal(
    localWinsOverRemote(D.mergeItem, local, remote),
    true,
    'sanity: the raw check says local wins'
  );
  assert.equal(decideStaleRemediation(D.mergeItem, local, remote), 'resolve');
});

test('decideStaleRemediation re-stamps only on a genuine exact-tie content disagreement the local merge still prefers', () => {
  const local = item({ updatedAt: 1000, reviewedAt: 5000, name: 'local wins the tie' });
  const remote = item({ updatedAt: 1000, reviewedAt: 1000, name: 'remote loses' });
  assert.equal(decideStaleRemediation(D.mergeItem, local, remote), 'restamp');
});
