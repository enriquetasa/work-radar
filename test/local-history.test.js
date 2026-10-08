'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const history = require('../sync/history');

function localSaveHandler(initialData) {
  let data = structuredClone(initialData);
  let save;
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('data:save',");
  const end = source.indexOf("ipcMain.handle('data:import',", start);
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_channel, handler) => (save = handler) },
    history,
    activeProfileId: null,
    syncEngine: null,
    localDataQueue: Promise.resolve(),
    DATA_FILE: () => 'local-profile.json',
    readJSON: async () => structuredClone(data),
    atomicWrite: async (_file, next) => {
      data = structuredClone(next);
    },
    log: { warn() {}, error() {} },
  });
  return (payload) => save(null, payload);
}

test('local saves retain the baseline, ignore log-only edits, and record project changes', async () => {
  const original = { id: 'project', name: 'Before', addedAt: 1, updatedAt: 10, log: [] };
  const save = localSaveHandler({ schema: 3, items: [original], arch: [] });
  const withLog = { ...original, updatedAt: 20, log: [{ id: 'note', text: 'An update' }] };
  const logged = await save({ schema: 3, items: [withLog], arch: [], historyAction: 'log' });

  assert.equal(logged.ok, true);
  assert.equal(logged.data.itemRevisions.length, 1);
  assert.equal(logged.data.itemRevisions[0].action, 'baseline');
  assert.equal(logged.data.itemRevisions[0].snapshot.updatedAt, 10);

  // An older renderer payload must not discard history already saved on disk.
  const edited = await save({
    schema: 3,
    items: [{ ...withLog, name: 'After', updatedAt: 30 }],
    arch: [],
    itemRevisions: [],
    historyAction: 'edit',
  });
  assert.equal(edited.ok, true);
  const revisions = history.historyFor(edited.data, original.id);
  assert.deepEqual(
    revisions.map((revision) => revision.snapshot.name),
    ['After', 'Before']
  );
  assert.deepEqual(edited.data.items[0].log, withLog.log);
  assert.equal(
    revisions.every((revision) => revision.snapshot.log === undefined),
    true
  );
});
