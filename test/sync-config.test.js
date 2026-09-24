'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveSyncConfig } = require('../sync/config.js');

// A no-op logger so the tests that hit the warn paths (corrupt/incomplete
// config file, unreadable file) don't spam stdout with structured logs —
// same pattern as test/sync-auth-service.test.js's silentLog.
const silentLog = { debug() {}, info() {}, warn() {}, error() {}, critical() {} };

test('disabled when neither env vars nor a config file are present', () => {
  const result = resolveSyncConfig({ env: {} });
  assert.deepEqual(result, { configured: false });
});

test('env vars take priority and are trimmed', () => {
  const result = resolveSyncConfig({
    env: {
      WORK_RADAR_SUPABASE_URL: '  http://127.0.0.1:54321  ',
      WORK_RADAR_SUPABASE_KEY: '  sb_publishable_x  ',
    },
    userDataDir: '/fake/userData',
    readFileSync: () => {
      throw new Error('must not read the file when env vars are set');
    },
  });
  assert.deepEqual(result, {
    configured: true,
    url: 'http://127.0.0.1:54321',
    publishableKey: 'sb_publishable_x',
    source: 'env',
  });
});

test('one env var without the other is not enough', () => {
  const result = resolveSyncConfig({ env: { WORK_RADAR_SUPABASE_URL: 'http://x' } });
  assert.equal(result.configured, false);
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

test('a missing config file disables sync without throwing', () => {
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
  assert.deepEqual(result, { configured: false });
});

test('a corrupt config file disables sync without throwing', () => {
  const result = resolveSyncConfig({
    env: {},
    userDataDir: '/fake/userData',
    readFileSync: () => 'not json {{{',
    log: silentLog,
  });
  assert.deepEqual(result, { configured: false });
});

test('a config file missing required fields disables sync', () => {
  const result = resolveSyncConfig({
    env: {},
    userDataDir: '/fake/userData',
    readFileSync: () => JSON.stringify({ url: 'http://127.0.0.1:54321' }),
    log: silentLog,
  });
  assert.deepEqual(result, { configured: false });
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
  assert.deepEqual(result, { configured: false });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].msg, /failed to read sync-config\.json/);
});

test('no userDataDir and no env vars disables sync without touching the filesystem', () => {
  const result = resolveSyncConfig({ env: {} });
  assert.deepEqual(result, { configured: false });
});
