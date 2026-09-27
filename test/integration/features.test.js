'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const requireFromPackage = createRequire(require.resolve('../../package.json'));
const { createClient } = requireFromPackage('@supabase/supabase-js');
const { createAttachmentService } = require('../../sync/attachments.js');

function localSupabase() {
  const status = JSON.parse(
    execFileSync('npx', ['supabase', 'status', '-o', 'json'], { encoding: 'utf8' })
  );
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  return {
    url: status.API_URL,
    admin: createClient(status.API_URL, status.SECRET_KEY, options),
    key: status.PUBLISHABLE_KEY,
    options,
  };
}

async function withUsers(run) {
  const { url, admin, key, options } = localSupabase();
  const users = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      const email = `work-radar-feature-${crypto.randomUUID()}@example.invalid`;
      const password = crypto.randomUUID();
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      assert.equal(created.error, null, created.error?.message);
      const client = createClient(url, key, options);
      const login = await client.auth.signInWithPassword({ email, password });
      assert.equal(login.error, null, login.error?.message);
      users.push({ id: created.data.user.id, client });
    }
    return await run({ url, admin, users });
  } finally {
    await Promise.all(users.map((user) => admin.auth.admin.deleteUser(user.id)));
  }
}

test('briefing delivery payload is service-only, stable across retries, and clears on completion', async () => {
  await withUsers(async ({ admin, users }) => {
    const [owner, other] = users;
    const id = crypto.randomUUID();
    const lease = new Date(Date.now() + 600000).toISOString();
    const inserted = await admin.from('briefing_deliveries').insert({
      id,
      owner_id: owner.id,
      local_date: new Date().toISOString().slice(0, 10),
      state: 'claimed',
      lease_until: lease,
      attempt_count: 1,
    });
    assert.equal(inserted.error, null, inserted.error?.message);
    const payload = {
      recipient: 'fixture@example.invalid',
      from: 'sender@example.invalid',
      subject: 'Fixture',
      html: '<p>private</p>',
      text: 'private',
    };
    const first = await admin.rpc('prepare_briefing_delivery', {
      p_delivery_id: id,
      p_lease_until: lease,
      p_payload: payload,
    });
    assert.equal(first.error, null, first.error?.message);
    assert.deepEqual(first.data, payload);
    const retry = await admin.rpc('prepare_briefing_delivery', {
      p_delivery_id: id,
      p_lease_until: lease,
      p_payload: { ...payload, text: 'changed' },
    });
    assert.deepEqual(retry.data, payload);
    assert.ok(
      (
        await admin.rpc('prepare_briefing_delivery', {
          p_delivery_id: id,
          p_lease_until: new Date(Date.now() + 5000).toISOString(),
          p_payload: payload,
        })
      ).error
    );
    assert.ok(
      (await owner.client.from('briefing_deliveries').select('payload').eq('id', id)).error
    );
    assert.equal(
      (await owner.client.from('briefing_deliveries').select('id,state').eq('id', id)).error,
      null
    );
    assert.deepEqual(
      (await other.client.from('briefing_deliveries').select('id,state').eq('id', id)).data,
      []
    );
    const done = await admin.rpc('finish_briefing_delivery', {
      p_delivery_id: id,
      p_lease_until: lease,
      p_state: 'sent',
    });
    assert.equal(done.data, true);
    const after = await admin
      .from('briefing_deliveries')
      .select('payload,state')
      .eq('id', id)
      .single();
    assert.equal(after.data.payload, null);
    assert.equal(after.data.state, 'sent');
  });
});

test('revision trigger preserves provenance, idempotency, ownership, and immutability', async () => {
  await withUsers(async ({ users }) => {
    const [owner, other] = users;
    const itemId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const item = {
      id: itemId,
      name: 'Feature smoke',
      status: 'active',
      priority: 'high',
      addedAt: now,
      updatedAt: now,
      reviewedAt: now,
      revisionId,
      revisionAction: 'restore',
      revisionSourceDevice: 'smoke',
      revisionRestoredFrom: 'old-revision',
    };
    const pushed = await owner.client.rpc('push_items', { items: [item] });
    assert.equal(pushed.data[0].accepted, true, pushed.data[0].reason);
    const rows = await owner.client.from('item_revisions').select('*').eq('item_id', itemId);
    assert.equal(rows.data.length, 1);
    assert.equal(rows.data[0].id, revisionId);
    assert.equal(rows.data[0].action, 'restore');
    assert.equal(rows.data[0].restored_from_revision_id, 'old-revision');
    const duplicate = await owner.client.rpc('push_item_revisions', {
      revisions: [{ id: revisionId, itemId, snapshot: item, clientTime: now }],
    });
    assert.equal(duplicate.data[0].reason, 'duplicate');
    assert.deepEqual(
      (await other.client.from('item_revisions').select('*').eq('item_id', itemId)).data,
      []
    );
    const forged = await other.client.rpc('push_item_revisions', {
      revisions: [{ id: crypto.randomUUID(), itemId, snapshot: item, clientTime: now }],
    });
    assert.equal(forged.data[0].accepted, false);
    assert.ok(
      (await owner.client.from('item_revisions').update({ action: 'forged' }).eq('id', revisionId))
        .error
    );
  });
});

test('Storage retry and cross-owner policy remain enforced', async () => {
  await withUsers(async ({ users }) => {
    const [owner, other] = users;
    const itemId = crypto.randomUUID();
    const now = new Date().toISOString();
    const pushed = await owner.client.rpc('push_items', {
      items: [
        {
          id: itemId,
          name: 'Storage smoke',
          status: 'active',
          priority: 'medium',
          addedAt: now,
          updatedAt: now,
          reviewedAt: now,
        },
      ],
    });
    assert.equal(pushed.data[0].accepted, true, pushed.data[0].reason);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'work-radar-storage-smoke-'));
    try {
      const source = path.join(root, 'fixture.txt');
      await fs.writeFile(source, 'Storage policy fixture');
      const service = createAttachmentService({
        rootDir: root,
        accountId: owner.id,
        client: owner.client,
      });
      const record = await service.add({ itemId, sourcePath: source });
      assert.equal(
        (await owner.client.from('item_attachments').insert(service.toCloudRow(record))).error,
        null
      );
      const upload = await owner.client.storage
        .from('project-attachments')
        .upload(record.objectKey, await fs.readFile(source), {
          contentType: record.contentType,
          upsert: false,
        });
      assert.equal(upload.error, null, upload.error?.message);
      assert.equal((await service.processQueue())[0].ok, true);
      assert.ok(
        (await other.client.storage.from('project-attachments').download(record.objectKey)).error
      );
      assert.deepEqual(
        (await other.client.from('item_attachments').select('*').eq('id', record.id)).data,
        []
      );
      assert.ok(
        (
          await other.client
            .from('item_attachments')
            .insert({ ...service.toCloudRow(record), id: crypto.randomUUID(), owner_id: other.id })
        ).error
      );
      assert.ok(
        (
          await owner.client.storage
            .from('project-attachments')
            .update(record.objectKey, Buffer.from('tampered'), { contentType: record.contentType })
        ).error
      );
      await service.remove(record.id);
      await service.processQueue();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
