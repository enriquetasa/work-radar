'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseCallbackRequest, CALLBACK_PATH } = require('../sync/callback-request.js');

test('CALLBACK_PATH is the loopback path from the plan', () => {
  assert.equal(CALLBACK_PATH, '/auth/callback');
});

test('parses a successful code callback', () => {
  const result = parseCallbackRequest('/auth/callback?code=abc123');
  assert.deepEqual(result, { ok: true, code: 'abc123', flowId: null });
});

// supabase-js 2.117 appends ?sb_flow_id=<id> to emailRedirectTo, and
// exchangeCodeForSession(code, { flowId }) needs it back — see
// sync/auth-service.js and docs/supabase-sync-plan.md's Phase 3 notes.
test('parses the sb_flow_id alongside a successful code callback', () => {
  const result = parseCallbackRequest('/auth/callback?code=abc123&sb_flow_id=flow-xyz');
  assert.deepEqual(result, { ok: true, code: 'abc123', flowId: 'flow-xyz' });
});

test('parses a Supabase error callback', () => {
  const result = parseCallbackRequest(
    '/auth/callback?error=access_denied&error_description=Email%20link%20is%20invalid'
  );
  assert.deepEqual(result, {
    ok: false,
    error: 'access_denied',
    errorDescription: 'Email link is invalid',
  });
});

test('an error callback with no description still reports ok:false', () => {
  const result = parseCallbackRequest('/auth/callback?error=access_denied');
  assert.deepEqual(result, { ok: false, error: 'access_denied', errorDescription: '' });
});

test('a callback with neither code nor error is a missing_code failure', () => {
  const result = parseCallbackRequest('/auth/callback');
  assert.deepEqual(result, {
    ok: false,
    error: 'missing_code',
    errorDescription: 'callback had neither a code nor an error parameter',
  });
});

test('any other path is reported as not found, not a callback failure', () => {
  assert.deepEqual(parseCallbackRequest('/favicon.ico'), { ok: false, notFound: true });
  assert.deepEqual(parseCallbackRequest('/'), { ok: false, notFound: true });
});

test('an unparseable url is reported as not found rather than throwing', () => {
  assert.deepEqual(parseCallbackRequest('::::not a url::::'), { ok: false, notFound: true });
});
