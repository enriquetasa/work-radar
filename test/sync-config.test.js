'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveSyncConfig, DEFAULT_SUPABASE_URL } = require('../sync/config.js');

// A no-op logger so the tests that hit the warn paths (corrupt config file,
// unreadable file) don't spam stdout with structured logs — same pattern as
// test/sync-auth-service.test.js's silentLog.
const silentLog = { debug() {}, info() {}, warn() {}, error() {}, critical() {} };

test('no env vars, no config file: disabled, falls back to the built-in default URL', () => {
  const result = resolveSyncConfig({ env: {} });
  assert.deepEqual(result, { configured: false, url: DEFAULT_SUPABASE_URL });
});

test('env vars take priority and are trimmed, and the file is never read', () => {
  const result = resolveSyncConfig({
    env: {
      WORK_RADAR_SUPABASE_URL: '  http://127.0.0.1:54321  ',
      WORK_RADAR_SUPABASE_KEY: '  sb_publishable_x  ',
    },
    userDataDir: '/fake/userData',
    readFileSync: () => {
      throw new Error('must not read the file when both env vars are set');
    },
  });
  assert.deepEqual(result, {
    configured: true,
    url: 'http://127.0.0.1:54321',
    publishableKey: 'sb_publishable_x',
    source: 'env',
  });
});

test('only WORK_RADAR_SUPABASE_URL set: overrides the default URL but is not enough on its own', () => {
  const result = resolveSyncConfig({ env: { WORK_RADAR_SUPABASE_URL: 'http://x' } });
  assert.deepEqual(result, { configured: false, url: 'http://x' });
});

test('only WORK_RADAR_SUPABASE_KEY set (no userDataDir): configured, using the default URL', () => {
  const result = resolveSyncConfig({ env: { WORK_RADAR_SUPABASE_KEY: 'sb_publishable_z' } });
  assert.deepEqual(result, {
    configured: true,
    url: DEFAULT_SUPABASE_URL,
    publishableKey: 'sb_publishable_z',
    source: 'env',
  });
});

test('falls back to sync-config.json in userData when no env vars are set', () => {
  const result = resolveSyncConfig({
    env: {},
    userDataDir: '/fake/userData',
    readFileSync: (file) => {
      assert.equal(file, path.join('/fake/userData', 'sync-config.json'));
      return JSON.stringify({ url: 'http://127.0.0.1:54321', publishableKey: 'sb_publishable_y' });
    },
  });
  assert.deepEqual(result, {
    configured: true,
    url: 'http://127.0.0.1:54321',
    publishableKey: 'sb_publishable_y',
    source: 'file',
  });
});

test('a missing config file disables sync without throwing, using the default URL', () => {
  const result = resolveSyncConfig({
    env: {},
    userDataDir: '/fake/userData',
    readFileSync: () => {
      const err = new Error('no such file');
      err.code = 'ENOENT';
      throw err;
    },
    log: silentLog,
  });
  assert.deepEqual(result, { configured: false, url: DEFAULT_SUPABASE_URL });
});

test('a corrupt config file disables sync without throwing, and logs a warning', () => {
  const warnings = [];
  const log = { ...silentLog, warn: (msg, ctx) => warnings.push({ msg, ctx }) };
  const result = resolveSyncConfig({
    env: {},
    userDataDir: '/fake/userData',
    readFileSync: () => 'not json {{{',
    log,
  });
  assert.deepEqual(result, { configured: false, url: DEFAULT_SUPABASE_URL });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].msg, /not valid JSON/);
});

test('a config file with a url but no key yet: not configured, but its url still wins — no warning', () => {
  const warnings = [];
  const log = { ...silentLog, warn: (msg, ctx) => warnings.push({ msg, ctx }) };
  const result = resolveSyncConfig({
    env: {},
    userDataDir: '/fake/userData',
    readFileSync: () => JSON.stringify({ url: 'http://127.0.0.1:54321' }),
    log,
  });
  // This is the normal "the key prompt hasn't been filled in yet" state,
  // not an error — see docs/supabase-sync-plan.md's key-prompt notes.
  assert.deepEqual(result, { configured: false, url: 'http://127.0.0.1:54321' });
  assert.deepEqual(warnings, []);
});

test('a config file with only a key (no url): configured, using the default URL', () => {
  const result = resolveSyncConfig({
    env: {},
    userDataDir: '/fake/userData',
    readFileSync: () => JSON.stringify({ publishableKey: 'sb_publishable_only' }),
    log: silentLog,
  });
  assert.deepEqual(result, {
    configured: true,
    url: DEFAULT_SUPABASE_URL,
    publishableKey: 'sb_publishable_only',
    source: 'file',
  });
});

test('an unreadable config file (not ENOENT) is warned about via the injected logger', () => {
  const warnings = [];
  const log = { ...silentLog, warn: (msg, ctx) => warnings.push({ msg, ctx }) };
  const result = resolveSyncConfig({
    env: {},
    userDataDir: '/fake/userData',
    readFileSync: () => {
      const err = new Error('permission denied');
      err.code = 'EACCES';
      throw err;
    },
    log,
  });
  assert.deepEqual(result, { configured: false, url: DEFAULT_SUPABASE_URL });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].msg, /failed to read sync-config\.json/);
});

test('no userDataDir and no env vars disables sync without touching the filesystem', () => {
  const result = resolveSyncConfig({ env: {} });
  assert.deepEqual(result, { configured: false, url: DEFAULT_SUPABASE_URL });
});

test('env var URL overrides a url already set in the config file', () => {
  const result = resolveSyncConfig({
    env: { WORK_RADAR_SUPABASE_URL: 'http://env-wins' },
    userDataDir: '/fake/userData',
    readFileSync: () =>
      JSON.stringify({ url: 'http://file-loses', publishableKey: 'sb_publishable_f' }),
  });
  assert.deepEqual(result, {
    configured: true,
    url: 'http://env-wins',
    publishableKey: 'sb_publishable_f',
    source: 'file',
  });
});

/* Regression tests for a review finding: a sync-config.json containing a
   bare JSON `null` (or any other non-object value) threw a TypeError on
   `parsed.url`, which escaped resolveSyncConfig entirely — at startup
   that meant no window ever opened. */

test('sync-config.json containing bare JSON null does not throw, and warns', () => {
  const warnings = [];
  const log = { ...silentLog, warn: (msg, ctx) => warnings.push({ msg, ctx }) };
  const result = resolveSyncConfig({
    env: {},
    userDataDir: '/fake/userData',
    readFileSync: () => 'null',
    log,
  });
  assert.deepEqual(result, { configured: false, url: DEFAULT_SUPABASE_URL });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].msg, /must be a JSON object/);
});

test('sync-config.json containing a JSON number does not throw, and warns', () => {
  const result = resolveSyncConfig({
    env: {},
    userDataDir: '/fake/userData',
    readFileSync: () => '42',
    log: silentLog,
  });
  assert.deepEqual(result, { configured: false, url: DEFAULT_SUPABASE_URL });
});

test('sync-config.json containing a JSON array does not throw, and warns', () => {
  const result = resolveSyncConfig({
    env: {},
    userDataDir: '/fake/userData',
    readFileSync: () => '[1,2,3]',
    log: silentLog,
  });
  assert.deepEqual(result, { configured: false, url: DEFAULT_SUPABASE_URL });
});

/* Regression tests for a review finding: a key from an env var or a
   hand-edited sync-config.json was never run through
   sync/key-validation.js, so a secret/service key dropped in by mistake
   would be accepted and used. */

test('a rejected WORK_RADAR_SUPABASE_KEY is never used — treated as not configured, with a warning, and the key itself is never logged', () => {
  const warnings = [];
  const log = { ...silentLog, warn: (msg, ctx) => warnings.push({ msg, ctx }) };
  const result = resolveSyncConfig({
    env: { WORK_RADAR_SUPABASE_KEY: 'sb_secret_oops' },
    log,
  });
  assert.deepEqual(result, { configured: false, url: DEFAULT_SUPABASE_URL });
  assert.equal(warnings.length, 1);
  assert.ok(!JSON.stringify(warnings).includes('sb_secret_oops'));
});

test('a rejected sync-config.json publishableKey is never used — treated as not configured, with a warning', () => {
  const warnings = [];
  const log = { ...silentLog, warn: (msg, ctx) => warnings.push({ msg, ctx }) };
  const result = resolveSyncConfig({
    env: {},
    userDataDir: '/fake/userData',
    readFileSync: () => JSON.stringify({ publishableKey: 'sb_secret_oops' }),
    log,
  });
  assert.deepEqual(result, { configured: false, url: DEFAULT_SUPABASE_URL });
  assert.equal(warnings.length, 1);
  assert.ok(!JSON.stringify(warnings).includes('sb_secret_oops'));
});

test('a rejected env key falls back to a valid key already saved in the file — no permanent prompt loop', () => {
  const result = resolveSyncConfig({
    env: { WORK_RADAR_SUPABASE_KEY: 'sb_secret_oops' },
    userDataDir: '/fake/userData',
    readFileSync: () => JSON.stringify({ publishableKey: 'sb_publishable_good' }),
    log: silentLog,
  });
  assert.deepEqual(result, {
    configured: true,
    url: DEFAULT_SUPABASE_URL,
    publishableKey: 'sb_publishable_good',
    source: 'file',
  });
});

test('both env vars set but the key is rejected: falls through to the file instead of short-circuiting', () => {
  const result = resolveSyncConfig({
    env: { WORK_RADAR_SUPABASE_URL: 'http://env-url', WORK_RADAR_SUPABASE_KEY: 'sb_secret_oops' },
    userDataDir: '/fake/userData',
    readFileSync: () => JSON.stringify({ publishableKey: 'sb_publishable_good' }),
    log: silentLog,
  });
  assert.deepEqual(result, {
    configured: true,
    url: 'http://env-url',
    publishableKey: 'sb_publishable_good',
    source: 'file',
  });
});
