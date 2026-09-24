'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const { saveSyncConfigKey } = require('../sync/sync-config-store.js');

async function tmpUserDataDir() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'wr-sync-config-store-'));
}

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, critical() {} };

test('writes a fresh sync-config.json with just the publishable key', async () => {
  const userDataDir = await tmpUserDataDir();
  await saveSyncConfigKey({
    userDataDir,
    publishableKey: 'sb_publishable_new',
    log: silentLog,
  });
  const written = JSON.parse(
    await fsp.readFile(path.join(userDataDir, 'sync-config.json'), 'utf8')
  );
  assert.deepEqual(written, { publishableKey: 'sb_publishable_new' });
});

test('preserves an existing url field already in the file', async () => {
  const userDataDir = await tmpUserDataDir();
  await fsp.writeFile(
    path.join(userDataDir, 'sync-config.json'),
    JSON.stringify({ url: 'https://custom.supabase.co', publishableKey: 'sb_publishable_old' }),
    'utf8'
  );
  await saveSyncConfigKey({
    userDataDir,
    publishableKey: 'sb_publishable_new',
    log: silentLog,
  });
  const written = JSON.parse(
    await fsp.readFile(path.join(userDataDir, 'sync-config.json'), 'utf8')
  );
  assert.deepEqual(written, {
    url: 'https://custom.supabase.co',
    publishableKey: 'sb_publishable_new',
  });
});

test('an existing file with no url field stays without one', async () => {
  const userDataDir = await tmpUserDataDir();
  await fsp.writeFile(
    path.join(userDataDir, 'sync-config.json'),
    JSON.stringify({ publishableKey: 'sb_publishable_old' }),
    'utf8'
  );
  await saveSyncConfigKey({ userDataDir, publishableKey: 'sb_publishable_new', log: silentLog });
  const written = JSON.parse(
    await fsp.readFile(path.join(userDataDir, 'sync-config.json'), 'utf8')
  );
  assert.deepEqual(written, { publishableKey: 'sb_publishable_new' });
});

test('a corrupt existing file is treated as having no url, and gets overwritten cleanly', async () => {
  const userDataDir = await tmpUserDataDir();
  await fsp.writeFile(path.join(userDataDir, 'sync-config.json'), 'not json {{{', 'utf8');
  await saveSyncConfigKey({ userDataDir, publishableKey: 'sb_publishable_new', log: silentLog });
  const written = JSON.parse(
    await fsp.readFile(path.join(userDataDir, 'sync-config.json'), 'utf8')
  );
  assert.deepEqual(written, { publishableKey: 'sb_publishable_new' });
});

test('the write is atomic — no leftover temp file afterwards', async () => {
  const userDataDir = await tmpUserDataDir();
  await saveSyncConfigKey({ userDataDir, publishableKey: 'sb_publishable_new', log: silentLog });
  const leftovers = (await fsp.readdir(userDataDir)).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('never logs the key itself, in any log call', async () => {
  const userDataDir = await tmpUserDataDir();
  const calls = [];
  const capturingLog = {
    debug: (...a) => calls.push(a),
    info: (...a) => calls.push(a),
    warn: (...a) => calls.push(a),
    error: (...a) => calls.push(a),
    critical: (...a) => calls.push(a),
  };
  await saveSyncConfigKey({
    userDataDir,
    publishableKey: 'sb_publishable_super_secret_value',
    log: capturingLog,
  });
  const serialized = JSON.stringify(calls);
  assert.ok(!serialized.includes('sb_publishable_super_secret_value'));
});
