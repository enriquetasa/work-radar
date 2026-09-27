'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = mainSource.indexOf("ipcMain.handle('auth:status',");
const end = mainSource.indexOf("ipcMain.handle('auth:signIn',", start);

async function snapshot({ status, activeUserId = null, localData = true }) {
  let handler;
  vm.runInNewContext(mainSource.slice(start, end), {
    ipcMain: { handle: (_channel, callback) => (handler = callback) },
    authService: status ? { getStatus: async () => status } : null,
    profileState: async () => ({ activeUserId }),
    hasLocalProjectData: async () => localData,
  });
  return handler();
}

test('restored sign-in with unassociated local projects still requires a profile choice', async () => {
  const result = await snapshot({ status: { signedIn: true, userId: 'account-a' } });
  assert.equal(result.configured, true);
  assert.equal(result.profileRequired, true);
});

test('restored sign-in with an already associated account does not block on local projects', async () => {
  const result = await snapshot({
    status: { signedIn: true, userId: 'account-a' },
    activeUserId: 'account-a',
  });
  assert.equal(result.profileRequired, false);
});

test('signed-out and empty installations do not require association', async () => {
  assert.equal((await snapshot({ status: { signedIn: false } })).profileRequired, false);
  assert.equal(
    (await snapshot({ status: { signedIn: true, userId: 'account-a' }, localData: false }))
      .profileRequired,
    false
  );
  assert.equal((await snapshot({ status: null })).configured, false);
});
