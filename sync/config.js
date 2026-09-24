'use strict';

const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { validatePublishableKey } = require('./key-validation');

const DEFAULT_SUPABASE_URL = 'https://kqoudumymsmvstrfrxyz.supabase.co';

// This file is user-editable, so malformed input disables sync instead of crashing startup.
function readSyncConfigFile(userDataDir, readFileSync, logger) {
  if (!userDataDir) return { url: '', publishableKey: '' };
  const configPath = path.join(userDataDir, 'sync-config.json');
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn('failed to read sync-config.json — ignoring it', { file: configPath, err });
    }
    return { url: '', publishableKey: '' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    logger.warn('sync-config.json is not valid JSON — ignoring it', {
      file: configPath,
      err: parseErr,
    });
    return { url: '', publishableKey: '' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn('sync-config.json must be a JSON object — ignoring it', { file: configPath });
    return { url: '', publishableKey: '' };
  }
  return {
    url: typeof parsed.url === 'string' ? parsed.url.trim() : '',
    publishableKey: typeof parsed.publishableKey === 'string' ? parsed.publishableKey.trim() : '',
  };
}

// Log the source and validation error, never the key.
function validateCandidateKey(candidate, source, logger) {
  if (!candidate) return '';
  const validation = validatePublishableKey(candidate);
  if (!validation.ok) {
    logger.warn(`${source} publishableKey failed validation — ignoring it`, {
      reason: validation.error,
    });
    return '';
  }
  return validation.key;
}

function resolveSyncConfig({
  env = process.env,
  userDataDir,
  readFileSync = fs.readFileSync,
  log: logger = log,
} = {}) {
  const envUrl = (env.WORK_RADAR_SUPABASE_URL || '').trim();
  // An invalid environment key must not mask a valid saved key.
  const envKey = validateCandidateKey(
    (env.WORK_RADAR_SUPABASE_KEY || '').trim(),
    'WORK_RADAR_SUPABASE_KEY',
    logger
  );
  if (envUrl && envKey) {
    return { configured: true, url: envUrl, publishableKey: envKey, source: 'env' };
  }

  const file = readSyncConfigFile(userDataDir, readFileSync, logger);
  const fileKey = validateCandidateKey(file.publishableKey, 'sync-config.json', logger);
  const url = envUrl || file.url || DEFAULT_SUPABASE_URL;
  const publishableKey = envKey || fileKey;

  if (publishableKey) {
    return { configured: true, url, publishableKey, source: envKey ? 'env' : 'file' };
  }
  return { configured: false, url };
}

module.exports = { resolveSyncConfig, DEFAULT_SUPABASE_URL };
