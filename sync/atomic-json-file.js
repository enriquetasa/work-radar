'use strict';

const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const log = require('../logger');

// Tolerant reader for rebuildable state such as sync-state.json.
async function readJsonFile(filePath, { log: logger = log } = {}) {
  let raw;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    logger.warn('failed to read JSON file', { file: filePath, err });
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    logger.warn('failed to parse JSON file — treating as missing', { file: filePath, err });
    return null;
  }
}

// Strict reader for user data: corruption must never be treated as an empty file.
async function readJsonFileStrict(filePath, { log: logger = log } = {}) {
  let raw;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    logger.error('failed to read JSON file', { file: filePath, err });
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    logger.error('failed to parse JSON file — refusing to treat it as empty', {
      file: filePath,
      err,
    });
    throw err;
  }
}

async function writeJsonFileAtomic(filePath, obj, { log: logger = log } = {}) {
  // Unique temp paths allow overlapping writes without collisions.
  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
    await fsp.rename(tmp, filePath);
  } catch (err) {
    logger.error('failed to atomically write JSON file', { file: filePath, err });
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

module.exports = { readJsonFile, readJsonFileStrict, writeJsonFileAtomic };
