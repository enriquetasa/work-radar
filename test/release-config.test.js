'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { releaseConfig, writeReleaseConfig } = require('../scripts/prepare-build');
const { resolveSyncConfig } = require('../sync/config');
const silentLog = { warn() {} };
const releaseEnv = {
  WORK_RADAR_RELEASE_SUPABASE_URL: 'https://release.supabase.co/',
  WORK_RADAR_RELEASE_SUPABASE_KEY: 'sb_publishable_example',
};

test('a packaged install resolves generated sync config without user setup', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeReleaseConfig(dir, releaseEnv);
  assert.deepEqual(resolveSyncConfig({ env: {}, bundledConfigDir: path.join(dir, 'build') }), {
    configured: true,
    url: 'https://release.supabase.co',
    publishableKey: 'sb_publishable_example',
    source: 'bundle',
  });
  // A later local-only build must not accidentally retain hosted configuration.
  writeReleaseConfig(dir, {});
  assert.equal(
    resolveSyncConfig({ env: {}, bundledConfigDir: path.join(dir, 'build') }).configured,
    false
  );
});

test('incomplete or secret release configuration fails and removes stale output', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const env of [
    { WORK_RADAR_REQUIRE_SYNC: '1' },
    { WORK_RADAR_RELEASE_SUPABASE_URL: releaseEnv.WORK_RADAR_RELEASE_SUPABASE_URL },
    { ...releaseEnv, WORK_RADAR_RELEASE_SUPABASE_KEY: 'sb_secret_never_ship' },
    {
      ...releaseEnv,
      WORK_RADAR_RELEASE_SUPABASE_KEY: `e30.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`,
    },
  ]) {
    writeReleaseConfig(dir, releaseEnv);
    assert.throws(() => writeReleaseConfig(dir, env));
    assert.equal(fs.existsSync(path.join(dir, 'build', 'release-sync-config.json')), false);
  }
});

test('release configuration rejects insecure URLs, credentials, and paths', () => {
  for (const url of [
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com/api',
    'https://example.com?key=x',
    'not a url',
  ]) {
    assert.throws(() => releaseConfig({ ...releaseEnv, WORK_RADAR_RELEASE_SUPABASE_URL: url }));
  }
});

function resolveWithBundle(env = {}, saved = {}, bundled = releaseConfig(releaseEnv)) {
  return resolveSyncConfig({
    env,
    userDataDir: '/user',
    bundledConfigDir: '/resources',
    log: silentLog,
    readFileSync: (file) =>
      JSON.stringify(path.basename(file) === 'release-sync-config.json' ? bundled : saved),
  });
}

test('runtime and saved overrides take precedence over the release bundle', () => {
  const saved = { url: 'https://custom.supabase.co', publishableKey: 'sb_publishable_saved' };
  assert.deepEqual(resolveWithBundle({}, saved), { configured: true, ...saved, source: 'file' });
  assert.equal(resolveWithBundle({ WORK_RADAR_SUPABASE_KEY: 'sb_publishable_env' }).source, 'env');
});

test('a URL-only custom backend cannot inherit the bundled project key', () => {
  for (const result of [
    resolveWithBundle({ WORK_RADAR_SUPABASE_URL: 'https://custom.supabase.co' }),
    resolveWithBundle({}, { url: 'https://custom.supabase.co' }),
  ]) {
    assert.deepEqual(result, { configured: false, url: 'https://custom.supabase.co' });
  }
  assert.equal(
    resolveWithBundle({ WORK_RADAR_SUPABASE_URL: 'https://release.supabase.co/' }).configured,
    true
  );
});

test('secret keys in a tampered bundle never enable sync', () => {
  assert.equal(
    resolveWithBundle(
      {},
      {},
      { url: 'https://release.supabase.co', publishableKey: 'sb_secret_no' }
    ).configured,
    false
  );
});
