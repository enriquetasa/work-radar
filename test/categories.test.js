'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../renderer/domain');

test('initial categories come from active and archived projects without blanks or duplicates', () => {
  assert.deepEqual(
    D.categoryOptions({
      items: [
        { category: ' Engineering ' },
        { category: 'engineering' },
        { category: '' },
        { category: null },
        { category: 'Deleted', deletedAt: 1 },
      ],
      arch: [{ category: 'Personal' }],
    }),
    ['Engineering', 'Personal']
  );
});

test('configured categories replace inferred choices, including an explicitly empty list', () => {
  const project = { id: 'p', name: 'Project', category: 'Legacy' };
  const state = { items: [project], arch: [], categoryOptions: ['New', ' new ', 'Other'] };
  assert.deepEqual(D.categoryOptions(state), ['New', 'Other']);
  assert.deepEqual(D.categoryOptions({ ...state, categoryOptions: [] }), []);
  assert.equal(project.category, 'Legacy', 'editing choices must not rewrite project labels');
});

test('backups and disk reloads preserve an emptied catalog without resurrecting old options', () => {
  const state = { items: [], arch: [], lastExport: 0, categoryOptions: [] };
  assert.deepEqual(D.serialize(state).categoryOptions, []);
  const merged = D.mergeDiskIntoStore({ ...state, categoryOptions: ['Removed'] }, state);
  assert.deepEqual(merged.categoryOptions, []);
  assert.deepEqual(
    D.mergeDiskIntoStore(
      { ...state, categoryOptions: ['Saved'] },
      { ...state, categoryOptions: null }
    ).categoryOptions,
    ['Saved']
  );
});
