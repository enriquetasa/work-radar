'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const D = require('../renderer/domain.js');

const DAY = 86400000;
const NOW = Date.UTC(2026, 5, 15); // fixed clock for deterministic tests

test('exposes shared constants', () => {
  assert.equal(D.SCHEMA, 3);
  assert.equal(D.STALE_DAYS, 14);
  assert.deepEqual(Object.keys(D.PC), ['critical', 'high', 'medium', 'low']);
  assert.deepEqual(Object.keys(D.SC), ['active', 'watch', 'dormant']);
});

test('daysSince floors to whole days using injected clock', () => {
  assert.equal(D.daysSince(NOW, NOW), 0);
  assert.equal(D.daysSince(NOW - DAY, NOW), 1);
  assert.equal(D.daysSince(NOW - 5 * DAY - 1000, NOW), 5);
});

test('isStale flags items unpinged for >= STALE_DAYS', () => {
  const fresh = { reviewedAt: NOW - 13 * DAY };
  const stale = { reviewedAt: NOW - 14 * DAY };
  assert.equal(D.isStale(fresh, NOW), false);
  assert.equal(D.isStale(stale, NOW), true);
});

test('isStale never flags archived items', () => {
  const item = { reviewedAt: NOW - 100 * DAY, archivedAt: NOW - 90 * DAY };
  assert.equal(D.isStale(item, NOW), false);
});

test('migrate drops nameless rows and applies defaults', () => {
  const out = D.migrate([{ name: 'Alpha' }, {}, null, { notes: 'no name' }], NOW);
  assert.equal(out.length, 1);
  const row = out[0];
  assert.equal(row.name, 'Alpha');
  assert.equal(row.status, 'active');
  assert.equal(row.priority, 'medium');
  assert.equal(row.category, '');
  assert.equal(row.addedAt, NOW);
  assert.equal(row.reviewedAt, NOW);
  assert.ok(row.id, 'assigns an id');
});

test('migrate coerces invalid enums and preserves valid data', () => {
  const out = D.migrate(
    [{ name: 'Bravo', status: 'bogus', priority: 'critical', id: 'x1', addedAt: 1000 }],
    NOW
  );
  assert.equal(out[0].status, 'active'); // invalid -> default
  assert.equal(out[0].priority, 'critical'); // valid -> kept
  assert.equal(out[0].id, 'x1');
  assert.equal(out[0].reviewedAt, 1000); // falls back to addedAt
});

test('selectVisible filters review view to stale items only', () => {
  const state = {
    items: D.migrate(
      [
        { name: 'Stale', id: 's', reviewedAt: NOW - 20 * DAY, addedAt: NOW - 20 * DAY },
        { name: 'Fresh', id: 'f', reviewedAt: NOW, addedAt: NOW },
      ],
      NOW
    ),
    arch: [],
    ui: { view: 'live', filter: 'review', sort: 'name', search: '' },
  };
  const out = D.selectVisible(state, NOW);
  assert.deepEqual(
    out.map((i) => i.name),
    ['Stale']
  );
});

test('selectVisible filters by status and search term', () => {
  const items = D.migrate(
    [
      { name: 'Watcher', id: 'a', status: 'watch', notes: 'urgent', addedAt: NOW },
      { name: 'Worker', id: 'b', status: 'active', category: 'urgent', addedAt: NOW },
    ],
    NOW
  );
  const byStatus = D.selectVisible(
    { items, arch: [], ui: { view: 'live', filter: 'watch', sort: 'name', search: '' } },
    NOW
  );
  assert.deepEqual(
    byStatus.map((i) => i.name),
    ['Watcher']
  );

  const bySearch = D.selectVisible(
    { items, arch: [], ui: { view: 'live', filter: 'all', sort: 'name', search: 'URGENT' } },
    NOW
  );
  assert.equal(bySearch.length, 2, 'search matches notes and category, case-insensitive');
});

test('selectVisible sorts by priority rank then name', () => {
  const items = D.migrate(
    [
      { name: 'Beta', id: '1', priority: 'high', addedAt: NOW },
      { name: 'Alpha', id: '2', priority: 'high', addedAt: NOW },
      { name: 'Zed', id: '3', priority: 'critical', addedAt: NOW },
    ],
    NOW
  );
  const out = D.selectVisible(
    { items, arch: [], ui: { view: 'live', filter: 'all', sort: 'priority', search: '' } },
    NOW
  );
  assert.deepEqual(
    out.map((i) => i.name),
    ['Zed', 'Alpha', 'Beta']
  );
});

test('selectVisible archive view ignores live filters', () => {
  const arch = D.migrate(
    [{ name: 'Old', id: 'o', archivedAt: NOW - DAY, addedAt: NOW - 5 * DAY }],
    NOW
  );
  const out = D.selectVisible(
    { items: [], arch, ui: { view: 'archive', filter: 'review', sort: 'name', search: '' } },
    NOW
  );
  assert.equal(out.length, 1);
});

/* ---------- Mergeable model (Phase 1) ---------- */

test('migrate assigns deterministic ids to legacy log entries missing an id', () => {
  const legacy = [{ name: 'Alpha', id: 'item-1', log: [{ ts: NOW - DAY, text: 'first update' }] }];
  // Two independent "machines" migrating the same legacy data must agree.
  const runA = D.migrate(JSON.parse(JSON.stringify(legacy)), NOW);
  const runB = D.migrate(JSON.parse(JSON.stringify(legacy)), NOW);
  assert.ok(runA[0].log[0].id, 'assigns an id');
  assert.equal(runA[0].log[0].id, runB[0].log[0].id, 'deterministic across runs');
});

test('migrate gives different legacy log entries different ids', () => {
  const legacy = [
    {
      name: 'Alpha',
      id: 'item-1',
      log: [
        { ts: NOW - DAY, text: 'first update' },
        { ts: NOW - DAY, text: 'second update' },
        { ts: NOW - 2 * DAY, text: 'first update' },
      ],
    },
  ];
  const [item] = D.migrate(legacy, NOW);
  const ids = item.log.map((e) => e.id);
  assert.equal(new Set(ids).size, 3, 'distinct content -> distinct ids');
});

test('migrate preserves an existing log entry id', () => {
  const out = D.migrate([{ name: 'Alpha', log: [{ id: 'lg-fixed', ts: NOW, text: 'x' }] }], NOW);
  assert.equal(out[0].log[0].id, 'lg-fixed');
});

test('migrate gives duplicate legacy entries (same ts and text) distinct ids', () => {
  const legacy = [
    {
      name: 'Alpha',
      id: 'item-1',
      log: [
        { ts: 1, text: 'same' },
        { ts: 1, text: 'same' },
      ],
    },
  ];
  const [item] = D.migrate(legacy, NOW);
  const ids = item.log.map((e) => e.id);
  assert.equal(new Set(ids).size, 2, 'exact duplicates still get distinct ids');
  // Two independent migrations of the same file must still agree.
  const [again] = D.migrate(JSON.parse(JSON.stringify(legacy)), NOW);
  assert.deepEqual(
    again.log.map((e) => e.id),
    ids
  );
});

test('migrate drops malformed (null/non-object) log entries instead of throwing', () => {
  const out = D.migrate([{ name: 'Alpha', log: [null, { ts: NOW, text: 'ok' }, 'bad'] }], NOW);
  assert.equal(out[0].log.length, 1);
  assert.equal(out[0].log[0].text, 'ok');
});

test('migrate does not throw on log entries missing ts and/or text, and drops entries it cannot derive a stable id for', () => {
  // A log entry that is an object but has no `text` (or `text: null`) used
  // to crash migrate(): legacyLogId -> hashString(undefined) reads
  // `.length`. v2's migrate passed such entries through untouched, and v2's
  // mergeById import wrote foreign log entries to disk without validating
  // them, so a real data file can contain one. migrate() must not throw —
  // only a finite numeric `ts` lets an entry keep a stable, mergeable id
  // (see legacyLogId); text is coerced to a string rather than dropped.
  const out = D.migrate(
    [
      {
        name: 'Alpha',
        log: [{ ts: 5 }, { text: null, ts: 6 }, { text: 'hi' }, { ts: 7, text: 'ok' }],
      },
    ],
    NOW
  );
  const [item] = out;
  assert.equal(
    item.log.length,
    3,
    'entries with a finite ts survive; the one without ts is dropped'
  );
  assert.deepEqual(
    item.log.map((e) => e.ts),
    [5, 6, 7]
  );
  const noText = item.log.find((e) => e.ts === 5);
  assert.equal(noText.text, '', 'missing text is coerced to an empty string, not left undefined');
  const nullText = item.log.find((e) => e.ts === 6);
  assert.equal(nullText.text, '', 'null text is coerced to an empty string');
});

test('migrate gives identical deterministic ids on two independent runs for a legacy entry with ts but no text', () => {
  const legacy = [{ name: 'Alpha', id: 'item-1', log: [{ ts: 5 }] }];
  const [a] = D.migrate(JSON.parse(JSON.stringify(legacy)), NOW);
  const [b] = D.migrate(JSON.parse(JSON.stringify(legacy)), NOW);
  assert.equal(a.log[0].id, b.log[0].id);
  assert.ok(a.log[0].id);
});

test('migrate falls back to a deterministic updatedAt (not "now") when both updatedAt and addedAt are missing', () => {
  // Two machines migrating the same legacy row that lacks both addedAt and
  // updatedAt must land on the same updatedAt, or the merge winner would
  // depend on which machine happened to migrate later (see docs). Falling
  // back to the max log ts (or 0 with no log) is deterministic; falling
  // back to `now` is not.
  const withLog = D.migrate([{ name: 'Alpha', log: [{ ts: 42, text: 'x' }] }], NOW);
  assert.equal(withLog[0].updatedAt, 42, 'falls back to the newest log ts, not now');

  const noLog = D.migrate([{ name: 'Beta' }], NOW);
  assert.equal(
    noLog[0].updatedAt,
    0,
    'falls back to 0 (deterministic) when there is no signal at all'
  );
});

test('migrate v2 -> v3: legacy rows without deletedAt migrate cleanly', () => {
  // Shape of a v2 row: no deletedAt field at all, log entries without ids.
  const v2Row = {
    id: 'i1',
    name: 'Legacy Co',
    status: 'active',
    priority: 'high',
    addedAt: NOW - 10 * DAY,
    updatedAt: NOW - 5 * DAY,
    reviewedAt: NOW - 5 * DAY,
    log: [{ ts: NOW - 5 * DAY, text: 'kickoff' }],
  };
  const [out] = D.migrate([v2Row], NOW);
  assert.equal(out.deletedAt, undefined);
  assert.ok(out.log[0].id, 'legacy log entry gets an id');
});

test('migrate v2 -> v3: updatedAt catches up to reviewedAt/archivedAt/log entries a v2 ping or archive never bumped', () => {
  // Under v2, ping/archive/restore/addLogEntry did not bump updatedAt, so a
  // legacy row's updatedAt can be older than its reviewedAt, archivedAt, or
  // its newest log entry. migrate() must bring updatedAt up to the max of
  // all of those, or a later merge's "newest updatedAt wins" rule ties two
  // v2-era copies that really differ in time (see the mergeState test below).
  const v2Row = {
    id: 'i1',
    name: 'Legacy Co',
    status: 'active',
    priority: 'high',
    addedAt: 100000,
    updatedAt: 100000, // never bumped by the v2 ping/archive/log below
    reviewedAt: 250000, // a v2 ping happened later
    archivedAt: 300000, // a v2 archive happened even later
    log: [{ ts: 200000, text: 'kickoff' }],
  };
  const [out] = D.migrate([v2Row], 400000);
  assert.equal(
    out.updatedAt,
    300000,
    'updatedAt becomes the max of updatedAt/reviewedAt/archivedAt/log ts, not the stale v2 value'
  );
});

test('migrate v2 -> v3: updatedAt is left alone when it already covers everything (v3 data, or a v2 row with no later signal)', () => {
  const row = {
    id: 'i1',
    name: 'Co',
    addedAt: 1,
    updatedAt: 500,
    reviewedAt: 200,
    log: [{ ts: 300, text: 'x' }],
  };
  const [out] = D.migrate([row], 1000);
  assert.equal(out.updatedAt, 500, 'already the max -> unchanged');
});

test('mergeItem: newest updatedAt wins', () => {
  const older = {
    id: 'x',
    name: 'Old Name',
    status: 'active',
    priority: 'low',
    category: '',
    notes: '',
    addedAt: 1,
    updatedAt: 100,
    reviewedAt: 100,
    log: [],
  };
  const newer = { ...older, name: 'New Name', priority: 'critical', updatedAt: 200 };
  const merged = D.mergeItem(older, newer);
  assert.equal(merged.name, 'New Name');
  assert.equal(merged.priority, 'critical');
  assert.equal(merged.updatedAt, 200);
});

test('mergeItem: tie-break on equal updatedAt is deterministic and order-independent', () => {
  const a = {
    id: 'x',
    name: 'Alpha',
    status: 'active',
    priority: 'low',
    category: '',
    notes: '',
    addedAt: 1,
    updatedAt: 100,
    reviewedAt: 100,
    log: [],
  };
  const b = { ...a, name: 'Bravo' };
  const ab = D.mergeItem(a, b);
  const ba = D.mergeItem(b, a);
  assert.equal(ab.name, ba.name, 'same winner regardless of argument order');
  // Calling it again must reproduce the exact same winner (deterministic, not random).
  const ab2 = D.mergeItem(a, b);
  assert.equal(ab.name, ab2.name);
});

test('mergeItem: tie-break winner does not depend on object key order', () => {
  const base = {
    id: 'x',
    name: 'Alpha',
    status: 'active',
    priority: 'low',
    category: '',
    notes: '',
    addedAt: 1,
    updatedAt: 100,
    reviewedAt: 100,
    log: [],
  };
  // Same content as `base`, but with its keys inserted in a different
  // order — e.g. as a row read back from a database would arrive, where
  // field order isn't guaranteed.
  const baseReordered = {
    reviewedAt: 100,
    updatedAt: 100,
    addedAt: 1,
    notes: '',
    category: '',
    priority: 'low',
    status: 'active',
    name: 'Alpha',
    id: 'x',
    log: [],
  };
  const other = { ...base, name: 'Bravo' }; // different content, same updatedAt -> a real tie

  const winner1 = D.mergeItem(base, other).name;
  const winner2 = D.mergeItem(baseReordered, other).name;
  assert.equal(winner1, winner2, 'the tie-break winner must not flip just because keys differ');
});

test('mergeItem: a tombstone newer than a live edit wins (stays deleted)', () => {
  const liveEdit = {
    id: 'x',
    name: 'Contact',
    status: 'active',
    priority: 'low',
    category: '',
    notes: 'edited notes',
    addedAt: 1,
    updatedAt: 100,
    reviewedAt: 100,
    archivedAt: 50,
    log: [],
  };
  const tombstone = { ...liveEdit, notes: '', updatedAt: 200, deletedAt: 200 };
  const merged = D.mergeItem(liveEdit, tombstone);
  assert.equal(merged.deletedAt, 200);
});

test('mergeItem: an edit newer than a tombstone wins (resurrects the item)', () => {
  const tombstone = {
    id: 'x',
    name: 'Contact',
    status: 'active',
    priority: 'low',
    category: '',
    notes: '',
    addedAt: 1,
    updatedAt: 100,
    reviewedAt: 100,
    archivedAt: 50,
    deletedAt: 100,
    log: [],
  };
  const laterEdit = { ...tombstone, notes: 'brought back', updatedAt: 200, deletedAt: undefined };
  const merged = D.mergeItem(tombstone, laterEdit);
  assert.equal(merged.deletedAt, undefined);
  assert.equal(merged.notes, 'brought back');
});

test('mergeItem: unions log entries from both sides by id, sorted by ts', () => {
  const base = {
    id: 'x',
    name: 'Contact',
    status: 'active',
    priority: 'low',
    category: '',
    notes: '',
    addedAt: 1,
    updatedAt: 100,
    reviewedAt: 100,
  };
  const a = {
    ...base,
    log: [
      { id: 'l1', ts: 10, text: 'one' },
      { id: 'l2', ts: 30, text: 'three' },
    ],
  };
  const b = {
    ...base,
    log: [
      { id: 'l3', ts: 20, text: 'two' },
      { id: 'l1', ts: 10, text: 'one' },
    ],
  };
  const merged = D.mergeItem(a, b);
  assert.deepEqual(
    merged.log.map((e) => e.id),
    ['l1', 'l3', 'l2'],
    'union, de-duplicated by id, sorted by ts'
  );
});

/* ---------- Item mutations bump updatedAt (Phase 1) ---------- */
// These are exactly what makes "newest updatedAt wins" merging correct: a
// mutation that forgot the bump would let a stale copy from another
// machine silently win, or (for purge) let a deleted item come back.

test('pingItem bumps reviewedAt and updatedAt, leaves the rest untouched', () => {
  const item = {
    id: 'x',
    name: 'Co',
    status: 'active',
    priority: 'low',
    category: 'cat',
    notes: 'n',
    addedAt: 1,
    updatedAt: 100,
    reviewedAt: 100,
    log: [],
  };
  const out = D.pingItem(item, 500);
  assert.equal(out.reviewedAt, 500);
  assert.equal(out.updatedAt, 500);
  assert.equal(out.name, 'Co');
  assert.equal(out.notes, 'n');
  assert.notEqual(out, item, 'returns a new object, does not mutate the input');
});

test('archiveItem sets archivedAt and bumps updatedAt', () => {
  const item = { id: 'x', name: 'Co', updatedAt: 100, reviewedAt: 100, log: [] };
  const out = D.archiveItem(item, 500);
  assert.equal(out.archivedAt, 500);
  assert.equal(out.updatedAt, 500);
  assert.equal(item.archivedAt, undefined, 'does not mutate the input');
});

test('restoreItem clears archivedAt and bumps reviewedAt and updatedAt', () => {
  const item = { id: 'x', name: 'Co', archivedAt: 300, updatedAt: 300, reviewedAt: 100, log: [] };
  const out = D.restoreItem(item, 500);
  assert.equal(out.archivedAt, undefined);
  assert.equal(out.reviewedAt, 500);
  assert.equal(out.updatedAt, 500);
});

test('purgeItem sets deletedAt and bumps updatedAt, keeps the record (tombstone, not a delete)', () => {
  const item = {
    id: 'x',
    name: 'Co',
    notes: 'still here',
    archivedAt: 300,
    updatedAt: 300,
    reviewedAt: 100,
    log: [],
  };
  const out = D.purgeItem(item, 500);
  assert.equal(out.deletedAt, 500);
  assert.equal(out.updatedAt, 500);
  assert.equal(out.name, 'Co');
  assert.equal(out.notes, 'still here', 'purge tombstones, it does not scrub the record');
});

test('addLogEntry appends an entry with the given id/ts/text and bumps updatedAt', () => {
  const item = { id: 'x', name: 'Co', updatedAt: 100, reviewedAt: 100, log: [] };
  const out = D.addLogEntry(item, 'status update', 500, () => 'fixed-id');
  assert.equal(out.log.length, 1);
  assert.deepEqual(out.log[0], { id: 'fixed-id', ts: 500, text: 'status update' });
  assert.equal(out.updatedAt, 500);
  assert.deepEqual(item.log, [], 'does not mutate the input log');
});

test('addLogEntry defaults to uid() for the entry id when no id function is given', () => {
  const item = { id: 'x', name: 'Co', updatedAt: 100, reviewedAt: 100, log: [] };
  const out = D.addLogEntry(item, 'hi', 500);
  assert.ok(out.log[0].id, 'assigns an id');
});

/* ---------- Clock-skew-safe updatedAt (Phase 1 review carry-over) ----------
   Machine clocks differ. If a mutation just stamped updatedAt = Date.now(),
   an edit made on this machine right after pulling in a copy from another
   machine whose clock runs ahead would get an updatedAt *older* than the
   row already carries, so mergeItem's "newest updatedAt wins" would keep
   silently discarding this machine's own edit forever. nextUpdatedAt (and
   every mutation below) instead always lands at least one past whatever
   updatedAt the row already has, never actually going backwards — while
   other timestamp fields (reviewedAt, archivedAt, deletedAt, log ts) keep
   recording the real wall-clock time unchanged. */

test('nextUpdatedAt is the wall clock when it is already ahead of the previous updatedAt', () => {
  assert.equal(D.nextUpdatedAt(100, 500), 500);
  assert.equal(D.nextUpdatedAt(undefined, 500), 500);
  assert.equal(D.nextUpdatedAt(0, 500), 500);
});

test('nextUpdatedAt bumps past a future-skewed previous updatedAt even when now is earlier', () => {
  assert.equal(D.nextUpdatedAt(1000, 500), 1001);
});

test('pingItem bumps updatedAt past a skewed-ahead previous updatedAt, but reviewedAt is the real now', () => {
  const item = { id: 'x', name: 'Co', updatedAt: 1000, reviewedAt: 100, log: [] };
  const out = D.pingItem(item, 500);
  assert.equal(out.updatedAt, 1001);
  assert.equal(out.reviewedAt, 500);
});

test('archiveItem bumps updatedAt past a skewed-ahead previous updatedAt', () => {
  const item = { id: 'x', name: 'Co', updatedAt: 1000, reviewedAt: 100, log: [] };
  const out = D.archiveItem(item, 500);
  assert.equal(out.updatedAt, 1001);
  assert.equal(out.archivedAt, 500);
});

test('restoreItem bumps updatedAt past a skewed-ahead previous updatedAt', () => {
  const item = { id: 'x', name: 'Co', archivedAt: 300, updatedAt: 1000, reviewedAt: 100, log: [] };
  const out = D.restoreItem(item, 500);
  assert.equal(out.updatedAt, 1001);
  assert.equal(out.reviewedAt, 500);
});

test('purgeItem bumps updatedAt past a skewed-ahead previous updatedAt', () => {
  const item = { id: 'x', name: 'Co', updatedAt: 1000, reviewedAt: 100, log: [] };
  const out = D.purgeItem(item, 500);
  assert.equal(out.updatedAt, 1001);
  assert.equal(out.deletedAt, 500);
});

test('addLogEntry bumps updatedAt past a skewed-ahead previous updatedAt, but the entry ts is the real now', () => {
  const item = { id: 'x', name: 'Co', updatedAt: 1000, reviewedAt: 100, log: [] };
  const out = D.addLogEntry(item, 'hi', 500, () => 'fixed-id');
  assert.equal(out.updatedAt, 1001);
  assert.equal(out.log[0].ts, 500);
});

test('createItem stamps a brand-new item at now (no previous updatedAt to skew against)', () => {
  const out = D.createItem(
    { name: 'Co', status: 'active', priority: 'low' },
    500,
    () => 'fixed-id'
  );
  assert.equal(out.id, 'fixed-id');
  assert.equal(out.addedAt, 500);
  assert.equal(out.updatedAt, 500);
  assert.equal(out.reviewedAt, 500);
  assert.deepEqual(out.log, []);
  assert.equal(out.name, 'Co');
});

test('updateItem applies the patch and bumps updatedAt past a skewed-ahead previous updatedAt', () => {
  const item = { id: 'x', name: 'Co', notes: 'old', updatedAt: 1000, log: [] };
  const out = D.updateItem(item, { notes: 'new' }, 500);
  assert.equal(out.notes, 'new');
  assert.equal(out.updatedAt, 1001);
  assert.notEqual(out, item, 'returns a new object, does not mutate the input');
});

test('updateItem bumps updatedAt to now when the previous updatedAt is not ahead', () => {
  const item = { id: 'x', name: 'Co', notes: 'old', updatedAt: 100, log: [] };
  const out = D.updateItem(item, { notes: 'new' }, 500);
  assert.equal(out.updatedAt, 500);
});

test('mergeState: item archived on one side and edited (newer) on the other ends up live', () => {
  const archivedSide = {
    items: [],
    arch: [
      {
        id: 'a',
        name: 'Co',
        status: 'active',
        priority: 'low',
        category: '',
        notes: '',
        addedAt: 1,
        updatedAt: 100,
        reviewedAt: 100,
        archivedAt: 100,
        log: [],
      },
    ],
  };
  const editedSide = {
    items: [
      {
        id: 'a',
        name: 'Co',
        status: 'active',
        priority: 'high',
        category: '',
        notes: 'still working this',
        addedAt: 1,
        updatedAt: 200,
        reviewedAt: 200,
        log: [],
      },
    ],
    arch: [],
  };
  const merged = D.mergeState(archivedSide, editedSide);
  assert.equal(merged.items.length, 1, 'newer edit wins -> item is live');
  assert.equal(merged.arch.length, 0);
  assert.equal(merged.items[0].priority, 'high');
});

test('mergeState: item archived on one side (newer) than an older edit ends up archived', () => {
  const editedSide = {
    items: [
      {
        id: 'a',
        name: 'Co',
        status: 'active',
        priority: 'low',
        category: '',
        notes: '',
        addedAt: 1,
        updatedAt: 100,
        reviewedAt: 100,
        log: [],
      },
    ],
    arch: [],
  };
  const archivedSide = {
    items: [],
    arch: [
      {
        id: 'a',
        name: 'Co',
        status: 'active',
        priority: 'low',
        category: '',
        notes: '',
        addedAt: 1,
        updatedAt: 200,
        reviewedAt: 200,
        archivedAt: 200,
        log: [],
      },
    ],
  };
  const merged = D.mergeState(editedSide, archivedSide);
  assert.equal(merged.arch.length, 1, 'newer archive wins -> item stays archived');
  assert.equal(merged.items.length, 0);
});

test('mergeState: unions items present on only one side', () => {
  const a = {
    items: [
      {
        id: 'only-a',
        name: 'A',
        status: 'active',
        priority: 'low',
        category: '',
        notes: '',
        addedAt: 1,
        updatedAt: 1,
        reviewedAt: 1,
        log: [],
      },
    ],
    arch: [],
  };
  const b = { items: [], arch: [] };
  const merged = D.mergeState(a, b);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].id, 'only-a');
});

test('mergeState: a newer tombstone beats an older live copy — export/import round-trips a delete', () => {
  const liveSide = {
    items: [
      {
        id: 'a',
        name: 'Co',
        status: 'active',
        priority: 'low',
        category: '',
        notes: 'working on it',
        addedAt: 1,
        updatedAt: 100,
        reviewedAt: 100,
        log: [],
      },
    ],
    arch: [],
  };
  const tombstoneSide = {
    items: [],
    arch: [
      {
        id: 'a',
        name: 'Co',
        status: 'active',
        priority: 'low',
        category: '',
        notes: '',
        addedAt: 1,
        updatedAt: 200,
        reviewedAt: 100,
        archivedAt: 200,
        deletedAt: 200,
        log: [],
      },
    ],
  };
  const merged = D.mergeState(liveSide, tombstoneSide);
  assert.equal(merged.items.length, 0, 'the item is not live');
  assert.equal(merged.arch.length, 1, 'the tombstone lands in arch');
  assert.equal(merged.arch[0].deletedAt, 200);
  // And it stays hidden everywhere once merged in.
  const visible = D.selectVisible({
    items: [],
    arch: merged.arch,
    ui: { view: 'archive', filter: 'all', sort: 'name', search: '' },
  });
  assert.equal(visible.length, 0, 'hidden from the archive view too');
});

test('mergeState: a v2-era archive + later ping beats an older live backup once both are migrated', () => {
  // Reproduces the review finding: under v2, archiving and pinging an item
  // did not bump updatedAt. Without migrate() catching updatedAt up, this
  // v2-archived-then-pinged row (updatedAt 100, reviewedAt 250, archivedAt
  // 300) ties an older backup where the same item is still live (updatedAt
  // 100), and the text tie-break could pick the older, live copy — undoing
  // both the archive and the newer ping. This is exactly the first import
  // of an old backup, or the Phase 5 first sync of two v2 machines.
  const currentV2 = {
    id: 'i1',
    name: 'Legacy Co',
    status: 'active',
    priority: 'high',
    addedAt: 1,
    updatedAt: 100,
    reviewedAt: 250,
    archivedAt: 300,
    log: [],
  };
  const backupV2 = {
    id: 'i1',
    name: 'Legacy Co',
    status: 'active',
    priority: 'high',
    addedAt: 1,
    updatedAt: 100,
    reviewedAt: 100,
    log: [],
  };
  const current = { items: [], arch: D.migrate([currentV2], 1000) };
  const backup = { items: D.migrate([backupV2], 1000), arch: [] };
  const merged = D.mergeState(current, backup);
  assert.equal(merged.items.length, 0, 'stays archived');
  assert.equal(merged.arch.length, 1);
  assert.equal(merged.arch[0].reviewedAt, 250, 'the newer v2 ping is not undone');
});

test('mergeItem: on an updatedAt tie, breaks on reviewedAt numerically before falling back to the text comparison', () => {
  const a = {
    id: 'x',
    name: 'Alpha',
    status: 'active',
    priority: 'low',
    category: '',
    notes: '',
    addedAt: 1,
    updatedAt: 100,
    reviewedAt: 100,
    log: [],
  };
  const b = { ...a, reviewedAt: 99 }; // "99" sorts higher than "100" as text
  const ab = D.mergeItem(a, b);
  const ba = D.mergeItem(b, a);
  assert.equal(
    ab.reviewedAt,
    100,
    'the numerically newer reviewedAt wins, not the lexicographically larger text'
  );
  assert.equal(ba.reviewedAt, 100, 'order-independent');
});

test('mergeState: migrating the same legacy file on two machines produces no duplicate log entries', () => {
  const legacy = [
    {
      name: 'Alpha',
      id: 'item-1',
      log: [
        { ts: 10, text: 'first' },
        { ts: 20, text: 'second' },
      ],
    },
  ];
  const machineA = { items: D.migrate(JSON.parse(JSON.stringify(legacy)), NOW), arch: [] };
  const machineB = { items: D.migrate(JSON.parse(JSON.stringify(legacy)), NOW), arch: [] };
  const merged = D.mergeState(machineA, machineB);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].log.length, 2, 'one entry per original, not four');
});

test('stripTombstones filters out entries with deletedAt set', () => {
  const list = [{ id: '1', deletedAt: NOW }, { id: '2' }, { id: '3', deletedAt: undefined }];
  assert.deepEqual(
    D.stripTombstones(list).map((i) => i.id),
    ['2', '3']
  );
});

test('selectVisible hides tombstones from both live and archive views', () => {
  const tombstoneInItems = D.migrate(
    [{ name: 'Ghost', id: 'g1', deletedAt: NOW, updatedAt: NOW }],
    NOW
  );
  const tombstoneInArch = D.migrate(
    [{ name: 'Ghost2', id: 'g2', archivedAt: NOW, deletedAt: NOW, updatedAt: NOW }],
    NOW
  );
  const live = D.selectVisible(
    {
      items: tombstoneInItems,
      arch: [],
      ui: { view: 'live', filter: 'all', sort: 'name', search: '' },
    },
    NOW
  );
  const arch = D.selectVisible(
    {
      items: [],
      arch: tombstoneInArch,
      ui: { view: 'archive', filter: 'all', sort: 'name', search: '' },
    },
    NOW
  );
  assert.equal(live.length, 0, 'tombstone hidden from live view');
  assert.equal(arch.length, 0, 'tombstone hidden from archive view');
});

test('buildReportHTML excludes tombstones', () => {
  const items = D.migrate(
    [
      { name: 'Alive', addedAt: NOW },
      { name: 'Ghost', deletedAt: NOW, addedAt: NOW },
    ],
    NOW
  );
  const html = D.buildReportHTML(items, NOW);
  assert.ok(html.includes('ALIVE'));
  assert.ok(!html.includes('GHOST'));
});

test('blipXY is deterministic and scales radius by status ring', () => {
  const active = D.blipXY({ id: 'same', status: 'active' });
  const again = D.blipXY({ id: 'same', status: 'active' });
  const dormant = D.blipXY({ id: 'same', status: 'dormant' });
  assert.deepEqual(active, again);
  const distA = Math.hypot(active.x - D.CX, active.y - D.CY);
  const distD = Math.hypot(dormant.x - D.CX, dormant.y - D.CY);
  assert.ok(distD > distA, 'dormant sits on an outer ring');
});

test('uid returns an RFC 4122 v4 UUID', () => {
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(D.uid(), uuidV4);
});

test('uid produces distinct values across 10,000 calls', () => {
  const ids = new Set(Array.from({ length: 10000 }, () => D.uid()));
  assert.equal(ids.size, 10000);
});

test('migrate initialises log: [] for items without a log', () => {
  const out = D.migrate([{ name: 'Alpha' }], NOW);
  assert.deepEqual(out[0].log, []);
});

test('migrate preserves existing log entries, adding an id to legacy ones', () => {
  const log = [{ ts: NOW - 1000, text: 'first entry' }];
  const out = D.migrate([{ name: 'Beta', log }], NOW);
  assert.equal(out[0].log.length, 1);
  assert.equal(out[0].log[0].ts, log[0].ts);
  assert.equal(out[0].log[0].text, log[0].text);
  assert.ok(out[0].log[0].id, 'legacy entry gets a stable id');
});

test('migrate drops non-array log field', () => {
  const out = D.migrate([{ name: 'Gamma', log: 'bad' }], NOW);
  assert.deepEqual(out[0].log, []);
});

test('buildReportHTML includes item names and log text', () => {
  const items = D.migrate(
    [
      {
        name: 'Alpha Project',
        priority: 'critical',
        log: [{ ts: NOW - 86400000, text: 'first update' }],
        addedAt: NOW,
      },
      { name: 'Beta Work', priority: 'medium', log: [], addedAt: NOW },
    ],
    NOW
  );
  const html = D.buildReportHTML(items, NOW);
  assert.ok(html.includes('ALPHA PROJECT'), 'item name uppercased');
  assert.ok(html.includes('first update'), 'log text included');
  assert.ok(html.includes('BETA WORK'), 'second item included');
});

test('buildReportHTML excludes archived items', () => {
  const items = D.migrate(
    [
      { name: 'Live One', addedAt: NOW },
      { name: 'Gone Away', archivedAt: NOW - 1000, addedAt: NOW - 2000 },
    ],
    NOW
  );
  const html = D.buildReportHTML(items, NOW);
  assert.ok(html.includes('LIVE ONE'), 'live item present');
  assert.ok(!html.includes('GONE AWAY'), 'archived item absent');
});

test('buildReportHTML sorts critical before low', () => {
  const items = D.migrate(
    [
      { name: 'Zed', priority: 'low', addedAt: NOW },
      { name: 'Alpha', priority: 'critical', addedAt: NOW },
    ],
    NOW
  );
  const html = D.buildReportHTML(items, NOW);
  assert.ok(html.indexOf('ALPHA') < html.indexOf('ZED'), 'critical before low');
});

test('buildReportHTML escapes HTML special characters', () => {
  const items = D.migrate([{ name: 'A & B <test>', addedAt: NOW }], NOW);
  const html = D.buildReportHTML(items, NOW);
  assert.ok(html.includes('A &amp; B &lt;TEST&gt;'), 'special chars escaped and uppercased');
});

test('mergeDiskIntoStore: an in-flight renderer edit survives a reload', () => {
  // A save queued before this reload (still in flight, or still sitting
  // in the debounce window) hasn't reached disk yet — the reload must
  // not roll the in-memory edit back to the stale copy on disk.
  const onDisk = {
    items: [
      {
        id: 'a',
        name: 'Old name',
        status: 'active',
        priority: 'low',
        category: '',
        notes: '',
        addedAt: 1,
        updatedAt: 100,
        reviewedAt: 1,
        log: [],
      },
    ],
    arch: [],
    lastExport: 5,
  };
  const store = {
    items: [
      {
        id: 'a',
        name: 'Edited name',
        status: 'active',
        priority: 'low',
        category: '',
        notes: '',
        addedAt: 1,
        updatedAt: 200,
        reviewedAt: 1,
        log: [],
      },
    ],
    arch: [],
    lastExport: 5,
  };
  const merged = D.mergeDiskIntoStore(onDisk, store);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].name, 'Edited name', 'the newer in-memory edit must win');
  assert.equal(merged.items[0].updatedAt, 200);
});

test('mergeDiskIntoStore: a remote change merged to disk overwrites a stale in-memory copy', () => {
  const onDisk = {
    items: [
      {
        id: 'a',
        name: 'From remote',
        status: 'active',
        priority: 'low',
        category: '',
        notes: '',
        addedAt: 1,
        updatedAt: 300,
        reviewedAt: 1,
        log: [],
      },
    ],
    arch: [],
    lastExport: 5,
  };
  const store = {
    items: [
      {
        id: 'a',
        name: 'Stale renderer copy',
        status: 'active',
        priority: 'low',
        category: '',
        notes: '',
        addedAt: 1,
        updatedAt: 100,
        reviewedAt: 1,
        log: [],
      },
    ],
    arch: [],
    lastExport: 5,
  };
  const merged = D.mergeDiskIntoStore(onDisk, store);
  assert.equal(merged.items[0].name, 'From remote');
  assert.equal(merged.items[0].updatedAt, 300);
});

test('mergeDiskIntoStore: migrates a still-schema-2 file on disk before merging', () => {
  const onDisk = {
    schema: 2,
    items: [
      {
        id: 'a',
        name: 'Legacy',
        status: 'active',
        priority: 'low',
        addedAt: 1,
        reviewedAt: 1,
        log: [{ ts: 50, text: 'old note' }], // no id — schema v2
      },
    ],
    arch: [],
    lastExport: 0,
  };
  const merged = D.mergeDiskIntoStore(onDisk, { items: [], arch: [], lastExport: 0 });
  assert.equal(merged.items[0].log.length, 1);
  assert.ok(merged.items[0].log[0].id, 'the legacy log entry must get a stable id');
});

test('mergeDiskIntoStore: falls back to the store’s own lastExport when the disk payload omits it', () => {
  const merged = D.mergeDiskIntoStore(
    { items: [], arch: [] },
    { items: [], arch: [], lastExport: 42 }
  );
  assert.equal(merged.lastExport, 42);
});

test('mergeDiskIntoStore: never rolls lastExport backwards — takes whichever side is newer', () => {
  // A reload landing after an export set Store.lastExport in memory but
  // before that save reached disk must not roll it back (and bring back
  // the "back up your data" nudge) — found in review.
  const merged = D.mergeDiskIntoStore(
    { items: [], arch: [], lastExport: 5 },
    { items: [], arch: [], lastExport: 42 }
  );
  assert.equal(
    merged.lastExport,
    42,
    'the store’s newer lastExport must win over a stale disk value'
  );
});
