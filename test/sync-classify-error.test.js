'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyError } = require('../sync/classify-error.js');

test('a nullish error classifies as error (should never happen, but must not throw)', () => {
  assert.equal(classifyError(null), 'error');
  assert.equal(classifyError(undefined), 'error');
});

test('a fetch-failure TypeError classifies as offline', () => {
  assert.equal(classifyError(new TypeError('fetch failed')), 'offline');
});

test('a bare connection-refused error (Node net code) classifies as offline', () => {
  const err = new Error('connect ECONNREFUSED 127.0.0.1:54321');
  err.code = 'ECONNREFUSED';
  assert.equal(classifyError(err), 'offline');
});

test('DNS/timeout style codes classify as offline', () => {
  for (const code of ['ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET']) {
    const err = new Error('boom');
    err.code = code;
    assert.equal(classifyError(err), 'offline', code);
  }
});

test('a Postgres/PostgREST error (has a code but not a network one) classifies as error', () => {
  const err = new Error('duplicate key value violates unique constraint');
  err.code = '23505';
  err.details = 'Key already exists.';
  assert.equal(classifyError(err), 'error');
});

test('a generic thrown string/Error with no network signal classifies as error', () => {
  assert.equal(classifyError(new Error('push_items: no authenticated user')), 'error');
});

test('a plain TypeError from an unexpected shape bug also reads as offline', () => {
  // Same shape a failed fetch() throws (bare TypeError, no code/details) —
  // classifyError can't distinguish this from an actual network failure
  // without more information, and errs towards offline (see module doc).
  assert.equal(classifyError(new TypeError('Cannot read properties of undefined')), 'offline');
});
