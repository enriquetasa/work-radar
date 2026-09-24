'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { EPOCH_ISO, keysetOrFilter, pullAll } = require('../sync/keyset.js');
const { msToIso, isoToMs } = require('../sync/mapping.js');

function row(id, syncedAtMs) {
  return { id, synced_at: msToIso(syncedAtMs) };
}

test('keysetOrFilter builds the standard compound-key OR expansion', () => {
  assert.equal(
    keysetOrFilter('2026-01-01T00:00:00.000Z', 'abc'),
    'synced_at.gt.2026-01-01T00:00:00.000Z,and(synced_at.eq.2026-01-01T00:00:00.000Z,id.gt.abc)'
  );
});

test('pullAll with no cursor starts from the epoch', async () => {
  const calls = [];
  const pageFn = async (args) => {
    calls.push(args);
    return [];
  };
  await pullAll({ pageFn, cursorMs: null, lookbackMs: 1000, pageSize: 10, isoToMs, msToIso });
  assert.equal(calls[0].sinceIso, EPOCH_ISO);
  assert.equal(calls[0].afterId, null);
});

test('pullAll with a cursor starts from cursor - lookback, never below zero', async () => {
  const calls = [];
  const pageFn = async (args) => {
    calls.push(args);
    return [];
  };
  await pullAll({ pageFn, cursorMs: 500, lookbackMs: 1000, pageSize: 10, isoToMs, msToIso });
  assert.equal(calls[0].sinceIso, msToIso(0));
});

test('pullAll returns an unchanged cursor when nothing is pulled', async () => {
  const pageFn = async () => [];
  const result = await pullAll({
    pageFn,
    cursorMs: 12345,
    lookbackMs: 1000,
    pageSize: 10,
    isoToMs,
    msToIso,
  });
  assert.deepEqual(result.rows, []);
  assert.equal(result.cursor, 12345);
});

test('pullAll stops after a short page and advances the cursor to the max synced_at seen', async () => {
  const pageFn = async () => [row('a', 100), row('b', 200)];
  const result = await pullAll({
    pageFn,
    cursorMs: null,
    lookbackMs: 0,
    pageSize: 10,
    isoToMs,
    msToIso,
  });
  assert.deepEqual(
    result.rows.map((r) => r.id),
    ['a', 'b']
  );
  assert.equal(result.cursor, 200);
});

test('pullAll pages through a full page using the previous page last row as the next keyset', async () => {
  const pages = [
    [row('a', 100), row('b', 100)], // full page, same synced_at -> must key on id too
    [row('c', 300)], // short page -> end
  ];
  const calls = [];
  const pageFn = async (args) => {
    calls.push(args);
    return pages.shift();
  };
  const result = await pullAll({
    pageFn,
    cursorMs: null,
    lookbackMs: 0,
    pageSize: 2,
    isoToMs,
    msToIso,
  });
  assert.deepEqual(
    result.rows.map((r) => r.id),
    ['a', 'b', 'c']
  );
  assert.equal(calls[1].sinceIso, msToIso(100));
  assert.equal(calls[1].afterId, 'b');
  assert.equal(result.cursor, 300);
});

test('pullAll stops as soon as a page comes back empty, even mid-loop', async () => {
  const pages = [[row('a', 100)], []];
  const pageFn = async () => pages.shift();
  const result = await pullAll({
    pageFn,
    cursorMs: null,
    lookbackMs: 0,
    pageSize: 1,
    isoToMs,
    msToIso,
  });
  assert.deepEqual(
    result.rows.map((r) => r.id),
    ['a']
  );
});
