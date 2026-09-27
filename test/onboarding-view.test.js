'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldShow } = require('../renderer/onboarding-view.js');

test('completed onboarding never reopens', () => {
  assert.equal(shouldShow({ status: 'complete' }, false, false), false);
});

test('unfinished welcome is bypassed for existing data or a valid session', () => {
  assert.equal(shouldShow({ status: 'new' }, true, false), false);
  assert.equal(shouldShow({ status: 'new' }, false, true), false);
  assert.equal(shouldShow({ status: 'new' }, false, false), true);
});
