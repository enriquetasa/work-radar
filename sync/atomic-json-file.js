'use strict';
/* ============================================================
   WORK RADAR — atomic JSON file IO
   Generic read/write for any JSON file the sync engine owns
   (sync-state.json, and the main data file when the engine itself —
   not an IPC handler — needs to read/merge/write it, e.g. on a
   timer-driven pull). Same atomic pattern as main.js's own data-file
   helpers and sync/session-storage.js: write to a unique temp file,
   then rename — a crash mid-write can never leave a half-written file,
   and a unique temp name (pid + random) means two overlapping writes to
   the same path can't collide on it (see session-storage.js's
   writeStore for the same reasoning).

   Real fs by default; no injected filesystem, unlike config.js/
   session-storage.js's encrypt/decrypt — there is nothing here that
   needs faking for a unit test, only real temp files (see
   test/sync-atomic-json-file.test.js).
   ============================================================ */

const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const log = require('../logger');

// Returns the parsed JSON, or null if the file doesn't exist yet (the
// normal first-run case) or fails to parse (corrupt file) — logged as a
// warning either way except ENOENT, never thrown, so a missing/corrupt
// sync-state.json degrades to "start fresh" rather than crashing sync.
// Only ever used for sync-state.json (a rebuildable cache): degrading a
// corrupt file to "start fresh" there just re-marks everything pending,
// harmless. See readJsonFileStrict below for why the main data file
// needs different (non-tolerant) handling.
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

// Same ENOENT-tolerance as readJsonFile (a missing file is the normal
// first-run case — returns null), but a read/parse *failure* (corrupt
// file, permissions error) is thrown rather than silently degraded to
// "treat as missing". This is what sync-engine.js uses for the main data
// file: turning a corrupt file into "empty" there — the same way it's
// safe to do for the rebuildable sync-state.json — would let the very
// next merge/write overwrite the user's real data with remote-only (or
// empty) data, permanently, with no way back short of the daily backup.
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
