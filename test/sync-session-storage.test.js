'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const { createSessionStorage } = require('../sync/session-storage.js');

// A reversible fake encryptor standing in for Electron's safeStorage, per
// the plan: "Electron safeStorage in production, a fake in tests". XORs
// every byte against a fixed key (not real security, just enough to prove
// the adapter doesn't write plaintext) behind a marker prefix so corrupt/
// unmarked input can be told apart from the real thing.
const PREFIX = Buffer.from('FAKE-ENC:');
const XOR_KEY = 0x5a;
function xor(buf) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ XOR_KEY;
  return out;
}
function fakeEncrypt(buf) {
  return Buffer.concat([PREFIX, xor(buf)]);
}
function fakeDecrypt(buf) {
  if (!buf.slice(0, PREFIX.length).equals(PREFIX)) {
    throw new Error('not encrypted with the fake scheme');
  }
  return xor(buf.slice(PREFIX.length));
}

async function tmpFile() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wr-session-storage-'));
  return path.join(dir, 'session.enc');
}

test('getItem returns null when no file has ever been written', async () => {
  const filePath = await tmpFile();
  const storage = createSessionStorage({ filePath, encrypt: fakeEncrypt, decrypt: fakeDecrypt });
  assert.equal(await storage.getItem('sb-session'), null);
});

test('setItem then getItem round-trips a value', async () => {
  const filePath = await tmpFile();
  const storage = createSessionStorage({ filePath, encrypt: fakeEncrypt, decrypt: fakeDecrypt });
  const value = JSON.stringify({ access_token: 't1', refresh_token: 'r1' });
  await storage.setItem('sb-session', value);
  assert.equal(await storage.getItem('sb-session'), value);
});

test('the file on disk is not plaintext — encrypt was actually applied', async () => {
  const filePath = await tmpFile();
  const storage = createSessionStorage({ filePath, encrypt: fakeEncrypt, decrypt: fakeDecrypt });
  await storage.setItem('sb-session', JSON.stringify({ access_token: 'super-secret-token' }));
  const raw = await fsp.readFile(filePath, 'utf8');
  assert.ok(
    !raw.includes('super-secret-token'),
    'the raw file must not contain the plaintext value'
  );
  assert.ok(raw.startsWith('FAKE-ENC:'), 'the raw file must carry the encryption marker');
});

test('multiple keys coexist in the same encrypted file', async () => {
  const filePath = await tmpFile();
  const storage = createSessionStorage({ filePath, encrypt: fakeEncrypt, decrypt: fakeDecrypt });
  await storage.setItem('key-a', 'value-a');
  await storage.setItem('key-b', 'value-b');
  assert.equal(await storage.getItem('key-a'), 'value-a');
  assert.equal(await storage.getItem('key-b'), 'value-b');
});

test('removeItem deletes only the given key', async () => {
  const filePath = await tmpFile();
  const storage = createSessionStorage({ filePath, encrypt: fakeEncrypt, decrypt: fakeDecrypt });
  await storage.setItem('key-a', 'value-a');
  await storage.setItem('key-b', 'value-b');
  await storage.removeItem('key-a');
  assert.equal(await storage.getItem('key-a'), null);
  assert.equal(await storage.getItem('key-b'), 'value-b');
});

test('removeItem on a key that was never set is a harmless no-op', async () => {
  const filePath = await tmpFile();
  const storage = createSessionStorage({ filePath, encrypt: fakeEncrypt, decrypt: fakeDecrypt });
  await assert.doesNotReject(storage.removeItem('never-set'));
  assert.equal(fs.existsSync(filePath), false, 'must not create a file just to remove nothing');
});

// A no-op logger so this doesn't print a WARNING line to stdout during
// `npm test` (found in review — see the injected-logger test below for
// why that's now possible).
const silentLog = { debug() {}, info() {}, warn() {}, error() {}, critical() {} };

test('a corrupt/undecryptable file is treated as empty, not thrown', async () => {
  const filePath = await tmpFile();
  await fsp.writeFile(filePath, 'not encrypted at all');
  const storage = createSessionStorage({
    filePath,
    encrypt: fakeEncrypt,
    decrypt: fakeDecrypt,
    log: silentLog,
  });
  assert.equal(await storage.getItem('sb-session'), null);
});

// Found in review: this module used the module-level logger directly,
// unlike config.js/callback-server.js/auth-service.js, which all accept an
// injected `log` — so a test exercising the warn path always printed to
// stdout regardless of what it passed in. Asserts the injected logger is
// actually the one used, not just accepted and ignored.
test('a corrupt/undecryptable file logs via the injected logger, not the module default', async () => {
  const filePath = await tmpFile();
  await fsp.writeFile(filePath, 'not encrypted at all');
  const warnCalls = [];
  const capturingLog = { ...silentLog, warn: (...args) => warnCalls.push(args) };
  const storage = createSessionStorage({
    filePath,
    encrypt: fakeEncrypt,
    decrypt: fakeDecrypt,
    log: capturingLog,
  });
  assert.equal(await storage.getItem('sb-session'), null);
  assert.equal(warnCalls.length, 1);
  const [message, context] = warnCalls[0];
  assert.match(message, /decrypt\/parse/);
  assert.equal(context.file, filePath);
});

test('writes atomically: no leftover .tmp file after setItem', async () => {
  const filePath = await tmpFile();
  const storage = createSessionStorage({ filePath, encrypt: fakeEncrypt, decrypt: fakeDecrypt });
  await storage.setItem('sb-session', 'v');
  assert.equal(fs.existsSync(filePath + '.tmp'), false);
  assert.equal(fs.existsSync(filePath), true);
});

test('concurrent setItem calls for different keys both survive', async () => {
  const filePath = await tmpFile();
  const storage = createSessionStorage({ filePath, encrypt: fakeEncrypt, decrypt: fakeDecrypt });
  // Fired without awaiting between them, the way an auto-refresh save can
  // race a sign-out's removal in the real auth-js client — without the
  // per-instance queue in sync/session-storage.js, the second write's
  // read-modify-write cycle can start from a store that doesn't yet
  // reflect the first one, and drop it.
  await Promise.all([
    storage.setItem('key-a', 'value-a'),
    storage.setItem('key-b', 'value-b'),
    storage.setItem('key-c', 'value-c'),
  ]);
  assert.equal(await storage.getItem('key-a'), 'value-a');
  assert.equal(await storage.getItem('key-b'), 'value-b');
  assert.equal(await storage.getItem('key-c'), 'value-c');
});

test('a concurrent setItem and removeItem never leave a stray .tmp file behind', async () => {
  const filePath = await tmpFile();
  const storage = createSessionStorage({ filePath, encrypt: fakeEncrypt, decrypt: fakeDecrypt });
  await storage.setItem('key-a', 'value-a');
  await Promise.all([storage.setItem('key-b', 'value-b'), storage.removeItem('key-a')]);
  const dir = path.dirname(filePath);
  const leftoverTmp = (await fsp.readdir(dir)).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftoverTmp, []);
});

test('requires both encrypt and decrypt to be functions', () => {
  assert.throws(() => createSessionStorage({ filePath: '/tmp/x', encrypt: fakeEncrypt }));
  assert.throws(() => createSessionStorage({ filePath: '/tmp/x', decrypt: fakeDecrypt }));
});
