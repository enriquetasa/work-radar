'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validatePublishableKey } = require('../sync/key-validation.js');

function fakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesignature`;
}

test('accepts a well-formed sb_publishable_ key', () => {
  const result = validatePublishableKey('sb_publishable_abc123');
  assert.deepEqual(result, { ok: true, key: 'sb_publishable_abc123' });
});

test('trims surrounding whitespace before validating', () => {
  const result = validatePublishableKey('  sb_publishable_abc123  ');
  assert.deepEqual(result, { ok: true, key: 'sb_publishable_abc123' });
});

test('accepts a legacy anon JWT', () => {
  const jwt = fakeJwt({ role: 'anon', ref: 'kqoudumymsmvstrfrxyz' });
  const result = validatePublishableKey(jwt);
  assert.deepEqual(result, { ok: true, key: jwt });
});

test('rejects an empty or whitespace-only key', () => {
  assert.equal(validatePublishableKey('').ok, false);
  assert.equal(validatePublishableKey('   ').ok, false);
  assert.equal(validatePublishableKey(undefined).ok, false);
  assert.equal(validatePublishableKey(null).ok, false);
});

test('rejects an sb_secret_ key with a clear message and never returns it as ok', () => {
  const result = validatePublishableKey('sb_secret_thisisasecret');
  assert.equal(result.ok, false);
  assert.match(result.error, /secret/i);
});

test('rejects a service_role JWT with a clear message', () => {
  const jwt = fakeJwt({ role: 'service_role', ref: 'kqoudumymsmvstrfrxyz' });
  const result = validatePublishableKey(jwt);
  assert.equal(result.ok, false);
  assert.match(result.error, /service_role/);
});

test('rejects a JWT with an unrecognized role', () => {
  const jwt = fakeJwt({ role: 'authenticated' });
  const result = validatePublishableKey(jwt);
  assert.equal(result.ok, false);
  assert.match(result.error, /authenticated/);
});

test('rejects garbage that is neither an sb_ key nor a parsable JWT', () => {
  const result = validatePublishableKey('not-a-real-key-at-all');
  assert.equal(result.ok, false);
});

test('rejects a JWT-shaped string with an unparsable payload', () => {
  const result = validatePublishableKey('aaaa.not-valid-base64url-json.bbbb');
  assert.equal(result.ok, false);
});

/* Regression tests for a review finding: the old prefix/suffix checks
   (startsWith/decodeJwtPayload-or-not) could all be bypassed by smuggling
   extra content alongside an otherwise-accepted shape. Every case here
   must be rejected. */

test('rejects a publishable-looking key with a secret key smuggled in after a newline', () => {
  const result = validatePublishableKey('sb_publishable_abc\nsb_secret_def');
  assert.equal(result.ok, false);
});

test('rejects a publishable-looking key with a secret key smuggled in after a space', () => {
  const result = validatePublishableKey('sb_publishable_abc sb_secret_def');
  assert.equal(result.ok, false);
});

test('rejects a bare "sb_publishable_" with nothing after the prefix', () => {
  const result = validatePublishableKey('sb_publishable_');
  assert.equal(result.ok, false);
});

test('rejects an otherwise-valid anon JWT with a secret key appended', () => {
  const jwt = fakeJwt({ role: 'anon' });
  const result = validatePublishableKey(jwt + '\nsb_secret_zzz');
  assert.equal(result.ok, false);
});

test('rejects a JWT shape with a near-empty header and an empty signature', () => {
  const jwt = fakeJwt({ role: 'anon' });
  const payloadOnly = jwt.split('.')[1];
  const result = validatePublishableKey(`a.${payloadOnly}.`);
  assert.equal(result.ok, false);
});

test('rejects a key longer than the 2 KB cap even if otherwise well-formed', () => {
  const result = validatePublishableKey('sb_publishable_' + 'a'.repeat(2100));
  assert.equal(result.ok, false);
});

test('accepts a key right at the boundary of the 2 KB cap', () => {
  // 'sb_publishable_' (15 bytes) + filler, total exactly 2048 bytes.
  const key = 'sb_publishable_' + 'a'.repeat(2048 - 'sb_publishable_'.length);
  assert.equal(Buffer.byteLength(key, 'utf8'), 2048);
  const result = validatePublishableKey(key);
  assert.equal(result.ok, true);
});
