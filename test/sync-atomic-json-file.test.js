'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const { readJsonFile, writeJsonFileAtomic } = require('../sync/atomic-json-file.js');

async function tmpFile() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wr-atomic-json-'));
  return path.join(dir, 'data.json');
}

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, critical() {} };

test('readJsonFile returns null when the file does not exist', async () => {
  const filePath = await tmpFile();
  assert.equal(await readJsonFile(filePath, { log: silentLog }), null);
});

test('writeJsonFileAtomic then readJsonFile round-trips an object', async () => {
  const filePath = await tmpFile();
  await writeJsonFileAtomic(filePath, { a: 1, b: [1, 2, 3] });
  assert.deepEqual(await readJsonFile(filePath), { a: 1, b: [1, 2, 3] });
});

test('writeJsonFileAtomic leaves no leftover temp file', async () => {
  const filePath = await tmpFile();
  await writeJsonFileAtomic(filePath, { a: 1 });
  const dir = path.dirname(filePath);
  const leftovers = (await fsp.readdir(dir)).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('readJsonFile treats corrupt JSON as missing, logging a warning', async () => {
  const filePath = await tmpFile();
  await fsp.writeFile(filePath, 'not json at all');
  const warnCalls = [];
  const capturingLog = { ...silentLog, warn: (...args) => warnCalls.push(args) };
  assert.equal(await readJsonFile(filePath, { log: capturingLog }), null);
  assert.equal(warnCalls.length, 1);
});

test('concurrent writes to the same path both survive without colliding on the temp name', async () => {
  const filePath = await tmpFile();
  await Promise.all([
    writeJsonFileAtomic(filePath, { who: 'first' }),
    writeJsonFileAtomic(filePath, { who: 'second' }),
  ]);
  const result = await readJsonFile(filePath);
  assert.ok(result.who === 'first' || result.who === 'second');
});

test('writeJsonFileAtomic rejects and cleans up its temp file on a write failure', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wr-atomic-json-'));
  const filePath = path.join(dir, 'missing-subdir', 'data.json');
  const errorCalls = [];
  const capturingLog = { ...silentLog, error: (...args) => errorCalls.push(args) };
  await assert.rejects(writeJsonFileAtomic(filePath, { a: 1 }, { log: capturingLog }));
  assert.equal(errorCalls.length, 1);
  const leftovers = (await fsp.readdir(dir)).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});
