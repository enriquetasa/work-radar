'use strict';

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
    logger.warn('failed to decrypt/parse session storage file — treating as empty', {
      file: filePath,
      err,
    });
    return {};
  }
}

async function writeStore(filePath, encrypt, store) {
  const encrypted = encrypt(Buffer.from(JSON.stringify(store), 'utf8'));
  // Unique temp paths prevent overlapping auth writes from colliding.
  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tmp, encrypted);
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

function createSessionStorage({ filePath, encrypt, decrypt, log: logger = log }) {
  if (typeof encrypt !== 'function' || typeof decrypt !== 'function') {
    throw new Error('createSessionStorage requires both encrypt and decrypt functions');
  }

  // Serialize whole-file read-modify-write operations.
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
