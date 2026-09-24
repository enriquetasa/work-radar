'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isValidEmail } = require('../sync/validate.js');

test('accepts ordinary addresses', () => {
  assert.equal(isValidEmail('person@example.com'), true);
  assert.equal(isValidEmail('  person@example.com  '), true);
  assert.equal(isValidEmail('first.last+tag@sub.example.co'), true);
});

test('rejects non-strings', () => {
  assert.equal(isValidEmail(undefined), false);
  assert.equal(isValidEmail(null), false);
  assert.equal(isValidEmail(42), false);
  assert.equal(isValidEmail({}), false);
});

test('rejects obviously malformed addresses', () => {
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidEmail('missing-domain@'), false);
  assert.equal(isValidEmail('@missing-local.com'), false);
  assert.equal(isValidEmail('two@at@signs.com'), false);
  assert.equal(isValidEmail('has spaces@example.com'), false);
});

test('rejects absurdly long input', () => {
  assert.equal(isValidEmail('a'.repeat(400) + '@example.com'), false);
});
