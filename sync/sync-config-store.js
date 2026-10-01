'use strict';
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
