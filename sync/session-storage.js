'use strict';
/* ============================================================
   WORK RADAR — encrypted session storage adapter
   The storage backend supabase-js's auth client persists its session
   into (see docs/supabase-sync-plan.md → "Architecture": "The auth
   session is persisted encrypted with Electron safeStorage"). All of
   supabase-js's keyed values live together as one JSON object inside a
   single encrypted file, written atomically (temp file + rename), same
   pattern as main.js's data file.

   `encrypt`/`decrypt` are injected: Electron's `safeStorage` in
   production, a reversible fake in tests — this module never touches
   Electron itself, so it's testable under node:test on its own.
   ============================================================ */

const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const log = require('../logger');

async function readStore(filePath, decrypt, logger) {
  let raw;
  try {
    raw = await fsp.readFile(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    logger.warn('failed to read session storage file', { file: filePath, err });
    return {};
  }
  try {
    const decrypted = decrypt(raw);
    const parsed = JSON.parse(decrypted.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    // A corrupt or undecryptable file must not crash sign-in — treat it
    // like "no session persisted" and log loudly so it's not a silent
    // swallow.
    logger.warn('failed to decrypt/parse session storage file — treating as empty', {
      file: filePath,
      err,
    });
    return {};
  }
}

async function writeStore(filePath, encrypt, store) {
  const encrypted = encrypt(Buffer.from(JSON.stringify(store), 'utf8'));
  // Unique per call (pid + random), not a fixed `${filePath}.tmp` — two
  // overlapping writes (e.g. an auto-refresh save racing a sign-out) must
  // never share a tmp path, or one can interleave bytes into the other's
  // file, or rename out from under it (ENOENT on the second rename).
  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tmp, encrypted);
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

// Returns a storage object matching the shape supabase-js's `auth.storage`
// option expects: async getItem/setItem/removeItem, keyed by string.
// `log` is injectable — same pattern as config.js, callback-server.js and
// auth-service.js — so tests exercising the warn paths (e.g. a corrupt
// file) don't spam stdout.
function createSessionStorage({ filePath, encrypt, decrypt, log: logger = log }) {
  if (typeof encrypt !== 'function' || typeof decrypt !== 'function') {
    throw new Error('createSessionStorage requires both encrypt and decrypt functions');
  }

  // auth-js is lockless in Node and expects to be able to run overlapping
  // storage calls (e.g. an auto-refresh save racing a sign-out's removal —
  // see its own _sessionRemovalEpoch). Each of getItem/setItem/removeItem
  // is a read-modify-write over the *whole* file, so without serialising
  // them here, two overlapping calls can each read the same starting
  // store and the second write to finish would silently drop whatever the
  // first one added or removed. This per-instance queue chains every call
  // so each one's read-modify-write cycle finishes before the next starts;
  // it never rejects itself (a failed op still lets the queue move on), so
  // one failing operation can't wedge every operation after it.
  let tail = Promise.resolve();
  function enqueue(fn) {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  }

  return {
    getItem(key) {
      return enqueue(async () => {
        const store = await readStore(filePath, decrypt, logger);
        return key in store ? store[key] : null;
      });
    },
    setItem(key, value) {
      return enqueue(async () => {
        const store = await readStore(filePath, decrypt, logger);
        store[key] = value;
        try {
          await writeStore(filePath, encrypt, store);
        } catch (err) {
          logger.error('failed to persist session storage file', { file: filePath, err });
          throw err;
        }
      });
    },
    removeItem(key) {
      return enqueue(async () => {
        const store = await readStore(filePath, decrypt, logger);
        if (!(key in store)) return;
        delete store[key];
        try {
          await writeStore(filePath, encrypt, store);
        } catch (err) {
          logger.error('failed to persist session storage file', { file: filePath, err });
          throw err;
        }
      });
    },
  };
}

module.exports = { createSessionStorage };
