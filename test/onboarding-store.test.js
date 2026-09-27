'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createOnboardingStore } = require('../onboarding-store.js');

test('onboarding state is versioned, durable, and local-only choice is complete', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-radar-onboarding-'));
  const file = path.join(dir, 'onboarding.json');
  const first = createOnboardingStore({ filePath: file });
  assert.equal((await first.get()).status, 'new');
  await first.update({ status: 'in_progress', step: 'signin' });
  const second = createOnboardingStore({ filePath: file });
  assert.equal((await second.get()).step, 'signin');
  const done = await second.chooseLocal();
  assert.equal(done.status, 'complete');
  assert.equal(done.mode, 'local');
});
