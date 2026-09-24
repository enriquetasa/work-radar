'use strict';
/* ============================================================
   WORK RADAR — persisting the Supabase publishable key
   The write side of sync-config.json, called only from main.js's
   syncConfig:saveKey handler after sync/key-validation.js has already
   accepted the key — this module does no validation of its own, just
   the file IO. Reuses sync/atomic-json-file.js for the same
   temp-file-then-rename guarantee every other file in this app gets
   (see that module's own doc comment).

   Only ever writes `url` (preserved from whatever was already in the
   file — never the built-in default, see sync/config.js's
   DEFAULT_SUPABASE_URL, which is applied at *read* time, not persisted)
   and `publishableKey`. A missing or corrupt existing file degrades to
   "no existing url", same tolerant handling as everywhere else this app
   reads a user-editable JSON file, since this is a save path that must
   not fail just because the file happened to be malformed beforehand.

   Never logs the key itself — see test/sync-config-store.test.js's
   "never logs the key" regression test.
   ============================================================ */

const path = require('path');
const { readJsonFile, writeJsonFileAtomic } = require('./atomic-json-file');
const log = require('../logger');

async function saveSyncConfigKey({
  userDataDir,
  publishableKey,
  readJsonFile: readFn = readJsonFile,
  writeJsonFileAtomic: writeFn = writeJsonFileAtomic,
  log: logger = log,
}) {
  const configPath = path.join(userDataDir, 'sync-config.json');
  const existing = (await readFn(configPath, { log: logger })) || {};
  const next = {};
  if (typeof existing.url === 'string' && existing.url.trim()) {
    next.url = existing.url.trim();
  }
  next.publishableKey = publishableKey;
  await writeFn(configPath, next, { log: logger });
  logger.info('sync-config.json publishable key saved', { file: configPath });
  return configPath;
}

module.exports = { saveSyncConfigKey };
