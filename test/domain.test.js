'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const D = require('../renderer/domain.js');

const DAY = 86400000;
const NOW = Date.UTC(2026, 5, 15); // fixed clock for deterministic tests

test('exposes shared constants', () => {
  assert.equal(D.SCHEMA, 2);
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

test('mergeById overwrites matching ids and appends new ones', () => {
  const base = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ];
  const inc = [
    { id: 'b', name: 'B2' },
    { id: 'c', name: 'C' },
  ];
  const out = D.mergeById(base, inc);
  assert.equal(out.length, 3);
  assert.equal(out.find((i) => i.id === 'b').name, 'B2');
  assert.ok(out.find((i) => i.id === 'c'));
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

test('uid produces distinct values', () => {
  const ids = new Set(Array.from({ length: 100 }, () => D.uid()));
  assert.equal(ids.size, 100);
});

test('migrate initialises log: [] for items without a log', () => {
  const out = D.migrate([{ name: 'Alpha' }], NOW);
  assert.deepEqual(out[0].log, []);
});

test('migrate preserves existing log entries', () => {
  const log = [{ ts: NOW - 1000, text: 'first entry' }];
  const out = D.migrate([{ name: 'Beta', log }], NOW);
  assert.deepEqual(out[0].log, log);
});

test('migrate drops non-array log field', () => {
  const out = D.migrate([{ name: 'Gamma', log: 'bad' }], NOW);
  assert.deepEqual(out[0].log, []);
});
