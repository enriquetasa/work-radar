'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatPreview } = require('../renderer/briefing-view.js');

test('briefing preview has a useful empty state', () => {
  assert.deepEqual(formatPreview({ projects: [] }), {
    heading: 'Nothing needs your attention today.',
    rows: [],
  });
});
