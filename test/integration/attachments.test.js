'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createClient } = require('@supabase/supabase-js');
const { createAttachmentService } = require('../../sync/attachments.js');

let admin;
let config;
let user;

function localConfig() {
  const status = JSON.parse(
    execFileSync('npx', ['supabase', 'status', '-o', 'json'], { encoding: 'utf8' })
  );
  return {
    url: status.API_URL,
    publishableKey: status.PUBLISHABLE_KEY,
    secretKey: status.SECRET_KEY,
  };
}

before(async () => {
  config = localConfig();
  admin = createClient(config.url, config.secretKey);
  const email = `work-radar-attachments-${crypto.randomUUID()}@example.com`;
  const password = crypto.randomBytes(24).toString('hex');
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  user = { email, password, id: data.user.id };
});

after(async () => {
  if (user) await admin.auth.admin.deleteUser(user.id);
});

async function clientForUser() {
  const client = createClient(config.url, config.publishableKey);
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (error) throw error;
  return client;
}

test('local Storage attachment upload, metadata pull, download, and tombstone', async () => {
  const itemId = crypto.randomUUID();
  const item = {
    id: itemId,
    name: 'Attachment parent',
    status: 'active',
    priority: 'medium',
    category: '',
    notes: '',
    addedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    reviewedAt: new Date().toISOString(),
    reviewIntervalDays: 14,
    nextReviewOn: '',
    waitingOn: '',
    checkpoint: '',
    checkpointOn: '',
    archivedAt: null,
    deletedAt: null,
  };
  const clientA = await clientForUser();
  const pushed = await clientA.rpc('push_items', { items: [item] });
  assert.equal(pushed.error, null, pushed.error?.message);
  assert.equal(pushed.data[0].accepted, true, pushed.data[0].reason);
  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'wr-att-it-a-'));
  const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'wr-att-it-b-'));
  const source = path.join(rootA, 'hello.txt');
  await fs.writeFile(source, 'hello from storage');
  const serviceA = createAttachmentService({ rootDir: rootA, accountId: user.id, client: clientA });
  const record = await serviceA.add({ itemId, sourcePath: source });
  const uploaded = await serviceA.processQueue();
  assert.equal(uploaded[0].ok, true, uploaded[0].error?.message);
  const clientB = await clientForUser();
  const serviceB = createAttachmentService({ rootDir: rootB, accountId: user.id, client: clientB });
  const pulled = await serviceB.pullMetadata();
  assert.equal(
    pulled.some((entry) => entry.id === record.id),
    true
  );
  const downloaded = await serviceB.download(record.id);
  assert.equal(await fs.readFile(downloaded, 'utf8'), 'hello from storage');
  await serviceA.remove(record.id);
  const deleted = await serviceA.processQueue();
  assert.equal(deleted[0].ok, true, deleted[0].error?.message);
  await serviceB.pullMetadata();
  assert.equal(await serviceB.get(record.id), null);
  await fs.rm(rootA, { recursive: true, force: true });
  await fs.rm(rootB, { recursive: true, force: true });
  await admin.from('items').delete().eq('id', itemId);
});
