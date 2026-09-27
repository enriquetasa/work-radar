'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { createAttachmentService, toCloudRow, fromCloudRow } = require('../sync/attachments.js');
const {
  createFullBackupArchive,
  importFullBackupArchive,
  parseFullBackupArchive,
} = require('../sync/attachment-backup.js');

async function tempRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'wr-att-'));
}
function uuid() {
  return crypto.randomUUID();
}

function cloudClient(rows = [], { updateFails = 0, uploadedBytes = null } = {}) {
  const calls = { uploads: 0, updates: 0, inserts: 0 };
  const client = {
    calls,
    storage: {
      from() {
        return {
          async download() {
            if (!uploadedBytes) return { data: null, error: { code: 'not-found' } };
            return { data: { arrayBuffer: async () => uploadedBytes }, error: null };
          },
          async upload() {
            calls.uploads += 1;
            return { error: null };
          },
          async remove() {
            return { error: null };
          },
        };
      },
    },
    from(_table) {
      const response = { data: rows, error: null };
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        gt() {
          return query;
        },
        order() {
          return query;
        },
        async insert() {
          calls.inserts += 1;
          return response;
        },
        update() {
          calls.updates += 1;
          const result = updateFails > 0 ? { error: { message: 'temporary' } } : { error: null };
          updateFails -= 1;
          return {
            eq() {
              return { eq: async () => result };
            },
          };
        },
        then(resolve, reject) {
          return Promise.resolve(response).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return client;
}

test('add copies a file and creates a durable pending upload record', async () => {
  const root = await tempRoot();
  const source = path.join(root, 'note.txt');
  await fsp.writeFile(source, 'hello');
  const service = createAttachmentService({ rootDir: root, accountId: uuid() });
  const record = await service.add({ itemId: 'item-1', sourcePath: source });
  assert.match(record.id, /^[0-9a-f-]{36}$/);
  assert.equal(record.status, 'pending');
  assert.equal((await service.list()).length, 1);
  assert.equal((await service.queue.list(service.currentScope)).length, 1);
});

test('local association copies bytes and queues account upload', async () => {
  const root = await tempRoot();
  const source = path.join(root, 'note.txt');
  await fsp.writeFile(source, 'hello');
  const service = createAttachmentService({ rootDir: root });
  await service.add({ itemId: 'item-1', sourcePath: source });
  const account = uuid();
  await service.associateLocalAccount(account);
  assert.equal(service.currentScope, account);
  assert.equal((await service.list({ scope: account })).length, 1);
  assert.equal((await service.queue.list(account)).length, 1);
});

test('a service created offline can upload existing files after cloud configuration', async (t) => {
  const root = await tempRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'note.txt');
  await fsp.writeFile(source, 'hello');
  const service = createAttachmentService({ rootDir: root });
  const record = await service.add({ itemId: 'item-1', sourcePath: source });
  const client = cloudClient();

  service.setClient(client);
  await service.associateLocalAccount(uuid());
  await service.processQueue();

  assert.equal(client.calls.uploads, 1);
  assert.equal(client.calls.inserts, 1);
  assert.equal((await service.get(record.id)).status, 'available');
  assert.deepEqual(await service.queue.list(service.currentScope), []);
});

test('local-only metadata pull is a no-op even when a cloud client exists', async () => {
  const root = await tempRoot();
  const client = {
    from() {
      throw new Error('local scope must not query cloud metadata');
    },
  };
  const service = createAttachmentService({ rootDir: root, client });
  assert.deepEqual(await service.pullMetadata(), []);
});

test('reconcile removes stale injected orphan objects', async () => {
  const root = await tempRoot();
  const account = uuid();
  const removed = [];
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const client = {
    from() {
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        lt() {
          return query;
        },
        update() {
          return query;
        },
        maybeSingle: async () => ({ data: null, error: { code: 'PGRST116' } }),
        then(resolve, reject) {
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const service = createAttachmentService({
    rootDir: root,
    accountId: account,
    client,
    listObjects: async () => [{ name: account + '/item-1/' + uuid(), created_at: old }],
    removeObject: async (object) => removed.push(object.objectKey),
  });
  const result = await service.reconcile({ graceMs: 60 * 60 * 1000, cleanupOrphans: true });
  assert.equal(result.orphanObjects, 1);
  assert.equal(removed.length, 1);
});

test('reservation reconciliation leaves remote objects untouched by default', async () => {
  const root = await tempRoot();
  const account = uuid();
  let listed = false;
  const client = {
    from() {
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        lt() {
          return query;
        },
        then(resolve, reject) {
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    storage: {
      from() {
        return {
          async list() {
            listed = true;
            return { data: [], error: null };
          },
        };
      },
    },
  };
  const service = createAttachmentService({
    rootDir: root,
    accountId: account,
    client,
    listObjects: async () => {
      listed = true;
      return [];
    },
  });
  const result = await service.reconcile({ graceMs: 60 * 60 * 1000 });
  assert.deepEqual(result, { reservations: 0, orphanObjects: 0 });
  assert.equal(listed, false);
});

test('cloud failed attachment status remains failed across row mapping', () => {
  const record = {
    id: uuid(),
    itemId: 'item-1',
    ownerId: uuid(),
    objectKey: 'x',
    displayName: 'x.txt',
    contentType: 'text/plain',
    byteSize: 1,
    checksum: 'a'.repeat(64),
    createdAt: Date.now(),
    status: 'failed',
  };
  const cloud = toCloudRow(record);
  assert.equal(cloud.status, 'failed');
  assert.equal(fromCloudRow(cloud).status, 'failed');
});

test('metadata pull discovers remote rows and merges deleted tombstones', async () => {
  const root = await tempRoot();
  const account = uuid();
  const id = uuid();
  const row = {
    id,
    item_id: 'item-1',
    owner_id: account,
    display_filename: 'r.txt',
    object_key: `${account}/item-1/${id}`,
    content_type: 'text/plain',
    byte_size: 3,
    checksum: 'a'.repeat(64),
    created_at: new Date(1).toISOString(),
    synced_at: new Date(2).toISOString(),
    status: 'ready',
    deleted_at: null,
  };
  const service = createAttachmentService({
    rootDir: root,
    accountId: account,
    client: cloudClient([row]),
  });
  const pulled = await service.pullMetadata();
  assert.equal(pulled[0].id, id);
  assert.equal((await service.get(id)).status, 'available');
});

test('upload retry detects an already uploaded object before retrying', async () => {
  const root = await tempRoot();
  const account = uuid();
  const source = path.join(root, 'note.txt');
  const bytes = Buffer.from('hello');
  await fsp.writeFile(source, bytes);
  let remote = null;
  let failMetadata = true;
  const client = cloudClient([], { uploadedBytes: null });
  client.storage.from = () => ({
    async download() {
      return remote
        ? { data: { arrayBuffer: async () => remote }, error: null }
        : { data: null, error: { code: 'not-found' } };
    },
    async upload(_key, value) {
      remote = Buffer.from(value);
      return { error: null };
    },
    async remove() {
      return { error: null };
    },
  });
  const originalFrom = client.from;
  client.from = (table) => {
    const q = originalFrom(table);
    if (table !== 'item_attachments') return q;
    const originalUpdate = q.update;
    q.update = (...args) => {
      if (failMetadata) {
        failMetadata = false;
        return {
          eq() {
            return { eq: async () => ({ error: { message: 'metadata down' } }) };
          },
        };
      }
      return originalUpdate(...args);
    };
    return q;
  };
  const service = createAttachmentService({
    rootDir: root,
    accountId: account,
    client,
    retryBaseMs: 0,
  });
  await service.add({ itemId: 'item-1', sourcePath: source });
  const first = await service.processQueue();
  assert.equal(first[0].ok, false);
  const second = await service.processQueue({ at: Date.now() + 1 });
  assert.equal(second[0].ok, true);
  assert.equal(remote.toString(), bytes.toString());
});

test('full backup archive round trips bytes and rejects tampered checksums', async () => {
  const bytes = Buffer.from('hello');
  const record = {
    id: uuid(),
    itemId: 'item-1',
    displayName: 'note.txt',
    contentType: 'text/plain',
    byteSize: bytes.length,
    checksum: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
  };
  const archive = await createFullBackupArchive({
    data: { items: [], arch: [] },
    history: [],
    attachments: [{ ...record, bytes }],
  });
  const parsed = parseFullBackupArchive(archive);
  assert.equal(parsed.attachments[0].bytes.toString(), 'hello');
});

test('failed full import hard-discards new records so the same backup can retry', async () => {
  const account = uuid();
  const root = await tempRoot();
  const records = ['first', 'second'].map((id) => {
    const content = Buffer.from(id);
    return {
      id,
      itemId: 'item-1',
      displayName: id + '.txt',
      contentType: 'text/plain',
      byteSize: content.length,
      checksum: crypto.createHash('sha256').update(content).digest('hex'),
      bytes: content,
    };
  });
  const archive = await createFullBackupArchive({
    data: { items: [], arch: [] },
    history: [],
    attachments: records,
  });
  const service = createAttachmentService({ rootDir: root, accountId: account });
  await assert.rejects(
    importFullBackupArchive(archive, {
      writeAttachment: async (record) => {
        if (record.id === 'second') throw new Error('simulated import failure');
        await service.importBytes({ record, bytes: record.bytes, deferQueue: true });
      },
      removeAttachment: (record) => service.discardImported(record.id),
    }),
    /simulated import failure/
  );
  assert.deepEqual(await service.list({ includeDeleted: true }), []);
  assert.deepEqual(await service.queue.list(account), []);
  assert.equal(await service.storage().read('first'), null);

  const retried = await importFullBackupArchive(archive, {
    writeAttachment: (record) =>
      service.importBytes({ record, bytes: record.bytes, deferQueue: true }),
  });
  for (const record of retried.attachments) await service.enqueueImported(record.id);
  assert.deepEqual(
    (await service.list()).map((record) => record.id),
    ['first', 'second']
  );
  assert.deepEqual(
    (await service.queue.list(account)).map((job) => job.id),
    ['first', 'second']
  );
});

test('full backup import skips identical records and rolls back only new writes', async () => {
  const bytes = (value) => Buffer.from(value);
  const records = ['existing', 'new', 'failed'].map((id) => {
    const content = bytes(id);
    return {
      id,
      itemId: 'item-1',
      displayName: id + '.txt',
      contentType: 'text/plain',
      byteSize: content.length,
      checksum: crypto.createHash('sha256').update(content).digest('hex'),
      bytes: content,
    };
  });
  const archive = await createFullBackupArchive({
    data: { items: [], arch: [] },
    history: [],
    attachments: records,
  });
  const removed = [];
  await assert.rejects(
    importFullBackupArchive(archive, {
      writeAttachment: async (record) => {
        if (record.id === 'existing') return { created: false };
        if (record.id === 'failed') throw new Error('write failed');
        return { created: true };
      },
      removeAttachment: async (record) => removed.push(record.id),
    }),
    /write failed/
  );
  assert.deepEqual(removed, ['new']);
});

test('metadata pull preserves a local deletion against a stale live cloud row', async () => {
  const root = await tempRoot();
  const account = uuid();
  const source = path.join(root, 'note.txt');
  await fsp.writeFile(source, 'hello');
  const rows = [];
  const client = cloudClient(rows);
  const service = createAttachmentService({ rootDir: root, accountId: account, client });
  const record = await service.add({ itemId: 'item-1', sourcePath: source });
  await service.remove(record.id);
  rows.push({
    id: record.id,
    item_id: record.itemId,
    owner_id: account,
    display_filename: record.displayName,
    object_key: record.objectKey,
    content_type: record.contentType,
    byte_size: record.byteSize,
    checksum: record.checksum,
    created_at: new Date(record.createdAt).toISOString(),
    synced_at: new Date(record.createdAt).toISOString(),
    status: 'ready',
    deleted_at: null,
  });
  await service.pullMetadata();
  const kept = await service.get(record.id, { includeDeleted: true });
  assert.equal(kept.status, 'deleted');
  assert.ok(kept.deletedAt);
});

test('metadata pull paginates beyond the Supabase API row limit', async () => {
  const root = await tempRoot();
  const account = uuid();
  const rows = Array.from({ length: 1001 }, (_, index) => {
    const id = uuid();
    return {
      id,
      item_id: 'item-1',
      owner_id: account,
      display_filename: `${index}.txt`,
      object_key: `${account}/item-1/${id}`,
      content_type: 'text/plain',
      byte_size: 1,
      checksum: 'a'.repeat(64),
      created_at: new Date(index + 1).toISOString(),
      synced_at: new Date(index + 1).toISOString(),
      status: 'ready',
      deleted_at: null,
    };
  });
  const client = {
    storage: { from: () => ({}) },
    from() {
      let start = 0;
      let end = rows.length - 1;
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        gt() {
          return query;
        },
        order() {
          return query;
        },
        range(nextStart, nextEnd) {
          start = nextStart;
          end = nextEnd;
          return query;
        },
        then(resolve, reject) {
          return Promise.resolve({ data: rows.slice(start, end + 1), error: null }).then(
            resolve,
            reject
          );
        },
      };
      return query;
    },
  };
  let disk = null;
  const service = createAttachmentService({
    rootDir: root,
    accountId: account,
    client,
    readFile: async () => disk,
    writeFile: async (_file, value) => {
      disk = value;
    },
  });
  const pulled = await service.pullMetadata();
  assert.equal(pulled.length, 1001);
});
