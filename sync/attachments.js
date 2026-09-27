'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fsp = require('node:fs').promises;
const { readJsonFile, writeJsonFileAtomic } = require('./atomic-json-file');
const { createAttachmentStorage } = require('./attachment-storage');
const { createAttachmentQueue } = require('./attachment-queue');
const {
  DEFAULT_CACHE_BYTES,
  assertScope,
  attachmentError,
  isOpenableAttachment,
  normalizeContentType,
  normalizeDisplayName,
  validateAttachmentInput,
} = require('./attachment-validation');

const ATTACHMENT_SCHEMA = 1;
const BUCKET = 'project-attachments';

function emptyState() {
  return { schema: ATTACHMENT_SCHEMA, accounts: {} };
}

function normalizeState(raw) {
  if (
    !raw ||
    raw.schema !== ATTACHMENT_SCHEMA ||
    !raw.accounts ||
    typeof raw.accounts !== 'object'
  ) {
    return emptyState();
  }
  const accounts = {};
  for (const [scope, value] of Object.entries(raw.accounts)) {
    try {
      assertScope(scope);
      const records =
        value && value.records && typeof value.records === 'object' ? value.records : {};
      accounts[scope] = { records };
    } catch {
      continue;
    }
  }
  return { schema: ATTACHMENT_SCHEMA, accounts };
}

function scopeFor(accountId) {
  return accountId ? assertScope(String(accountId)) : 'local';
}

function assertObjectSegment(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw attachmentError(`Invalid ${label}.`);
  return value;
}

function objectKey(ownerId, itemId, attachmentId) {
  if (!ownerId) return null;
  return `${assertObjectSegment(ownerId, 'owner id')}/${assertObjectSegment(itemId, 'item id')}/${assertObjectSegment(attachmentId, 'attachment id')}`;
}

function publicRecord(record) {
  if (!record) return null;
  return { ...record };
}

function toCloudRow(record) {
  const status = record.deletedAt
    ? 'deleted'
    : record.status === 'available'
      ? 'ready'
      : record.status === 'failed'
        ? 'failed'
        : 'pending';
  return {
    id: record.id,
    item_id: record.itemId,
    owner_id: record.ownerId,
    display_filename: record.displayName,
    object_key: record.objectKey,
    content_type: record.contentType,
    byte_size: record.byteSize,
    checksum: record.checksum,
    created_at: new Date(record.createdAt).toISOString(),
    status,
    deleted_at: record.deletedAt ? new Date(record.deletedAt).toISOString() : null,
  };
}

function fromCloudRow(row) {
  return {
    id: row.id,
    itemId: row.item_id,
    ownerId: row.owner_id,
    displayName: row.display_filename,
    objectKey: row.object_key,
    contentType: row.content_type,
    byteSize: row.byte_size,
    checksum: row.checksum,
    createdAt: Date.parse(row.created_at) || Date.now(),
    syncedAt: row.synced_at ? Date.parse(row.synced_at) || null : null,
    deletedAt: row.deleted_at ? Date.parse(row.deleted_at) || null : null,
    status: row.deleted_at
      ? 'deleted'
      : row.status === 'ready'
        ? 'available'
        : row.status === 'failed'
          ? 'failed'
          : 'pending',
  };
}

function createAttachmentService(options = {}) {
  const {
    rootDir,
    accountId = null,
    metadataFilePath = rootDir && path.join(rootDir, 'attachments-state.json'),
    queueFilePath = rootDir && path.join(rootDir, 'attachments-queue.json'),
    bucket = BUCKET,
    now = Date.now,
    randomUUID = crypto.randomUUID,
    readFile = readJsonFile,
    writeFile = writeJsonFileAtomic,
    cacheLimitBytes = DEFAULT_CACHE_BYTES,
    storageFactory = createAttachmentStorage,
    queue: suppliedQueue,
    log = { debug() {}, info() {}, warn() {}, error() {} },
    uploadObject,
    downloadObject,
    removeObject,
    objectExists,
    listObjects,
    retryBaseMs,
    retryMaxMs,
  } = options;
  if (!rootDir) throw new Error('createAttachmentService requires rootDir');
  if (!metadataFilePath || !queueFilePath) throw new Error('attachment state paths are required');
  let client = options.client || null;
  let currentScope = scopeFor(accountId);
  let operationGeneration = 0;
  let metadataQueue = Promise.resolve();

  function assertCurrent(scope, generation) {
    if (generation !== operationGeneration || scope !== currentScope) {
      throw attachmentError(
        'Attachment operation was cancelled after account change.',
        'ATTACHMENT_CANCELLED'
      );
    }
  }
  const storageByScope = new Map();
  const queue =
    suppliedQueue ||
    createAttachmentQueue({
      filePath: queueFilePath,
      now,
      readFile,
      writeFile,
      ...(retryBaseMs !== undefined ? { retryBaseMs } : {}),
      ...(retryMaxMs !== undefined ? { retryMaxMs } : {}),
    });

  function storage(scope = currentScope) {
    if (!storageByScope.has(scope))
      storageByScope.set(scope, storageFactory({ rootDir, scope, now, randomUUID }));
    return storageByScope.get(scope);
  }

  function transaction(mutator) {
    const run = metadataQueue.then(async () => {
      await fsp.mkdir(path.dirname(metadataFilePath), { recursive: true });
      const state = normalizeState((await readFile(metadataFilePath)) || emptyState());
      const result = await mutator(state);
      await writeFile(metadataFilePath, state);
      return result;
    });
    metadataQueue = run.catch(() => {});
    return run;
  }

  function account(state, scope = currentScope) {
    assertScope(scope);
    return (state.accounts[scope] ||= { records: {} });
  }

  async function get(id, { scope = currentScope, includeDeleted = false } = {}) {
    const record = await transaction((state) => account(state, scope).records[id] || null);
    if (record?.deletedAt && !includeDeleted) return null;
    return publicRecord(record);
  }

  async function list({ itemId, scope = currentScope, includeDeleted = false } = {}) {
    return transaction((state) =>
      Object.values(account(state, scope).records)
        .filter(
          (record) => (!itemId || record.itemId === itemId) && (includeDeleted || !record.deletedAt)
        )
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(publicRecord)
    );
  }

  async function persist(scope, record) {
    return transaction((state) => {
      account(state, scope).records[record.id] = record;
      return publicRecord(record);
    });
  }

  async function add({ itemId, sourcePath, displayName, contentType, scope = currentScope } = {}) {
    assertScope(scope);
    if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
      throw attachmentError('Attachment source paths must be absolute.');
    }
    const stat = await fsp.stat(sourcePath);
    const id = String(randomUUID());
    const name = normalizeDisplayName(displayName || path.basename(sourcePath));
    const type = normalizeContentType(contentType, name);
    validateAttachmentInput({
      itemId,
      displayName: name,
      contentType: type,
      byteSize: stat.size,
      sourcePath,
    });
    const copied = await storage(scope).copyIn(sourcePath, id);
    const ownerId = scope === 'local' ? null : scope;
    const record = {
      id,
      itemId: itemId.trim(),
      ownerId,
      displayName: name,
      objectKey: objectKey(ownerId, itemId.trim(), id),
      contentType: type,
      byteSize: copied.byteSize,
      checksum: copied.checksum,
      createdAt: now(),
      syncedAt: null,
      deletedAt: null,
      status: ownerId ? 'pending' : 'available',
      localPath: copied.localPath,
      cachePath: null,
    };
    await persist(scope, record);
    if (ownerId) await queue.enqueue(scope, { id, op: 'upload' });
    return publicRecord(record);
  }

  async function importBytes({ record, bytes, scope = currentScope, deferQueue = false } = {}) {
    assertScope(scope);
    if (!record || typeof record.id !== 'string' || !Buffer.isBuffer(bytes))
      throw attachmentError('Invalid backup attachment.');
    validateAttachmentInput({
      itemId: record.itemId,
      displayName: record.displayName,
      contentType: record.contentType,
      byteSize: bytes.length,
    });
    const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
    if (record.checksum && record.checksum !== checksum)
      throw attachmentError('Backup attachment checksum mismatch.', 'BACKUP_CHECKSUM_MISMATCH');
    await storage(scope).ensureDirs();
    const destination = storage(scope).managedPath(record.id);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await fsp.writeFile(temporary, bytes, { flag: 'wx' });
    await fsp.rename(temporary, destination);
    const ownerId = scope === 'local' ? null : scope;
    const metadata = { ...record };
    delete metadata.bytes;
    const next = {
      ...metadata,
      ownerId,
      objectKey: ownerId ? objectKey(ownerId, record.itemId, record.id) : null,
      byteSize: bytes.length,
      checksum,
      createdAt: Number(record.createdAt) || now(),
      syncedAt: null,
      deletedAt: null,
      status: ownerId ? 'pending' : 'available',
      localPath: destination,
      cachePath: null,
    };
    await persist(scope, next);
    if (ownerId && !deferQueue) await queue.enqueue(scope, { id: next.id, op: 'upload' });
    return publicRecord(next);
  }

  async function enqueueImported(id, { scope = currentScope } = {}) {
    const record = await get(id, { scope, includeDeleted: true });
    if (!record || record.deletedAt) return null;
    if (record.ownerId && record.objectKey)
      await queue.enqueue(scope, { id: record.id, op: 'upload' });
    return publicRecord(record);
  }

  // Permanently discard a record created by an import. Unlike remove(), this
  // does not create a tombstone or a delete job, so retrying the same backup
  // can recreate the attachment with the same ID.
  async function discardImport(id, { scope = currentScope } = {}) {
    assertScope(scope);
    const record = await get(id, { scope, includeDeleted: true });
    if (!record) {
      await queue.acknowledge(scope, id);
      return null;
    }
    await transaction((state) => {
      delete account(state, scope).records[id];
      return null;
    });
    await queue.acknowledge(scope, id);
    await storage(scope).remove(id);
    // Deferred imports never have a remote object yet. Keep this cleanup for
    // callers using the older immediate-queue import path.
    if (record.ownerId && record.objectKey)
      await removeRemoteObject({ name: record.objectKey }, scope).catch(() => {});
    return record;
  }

  const discardImported = discardImport;

  async function remove(id, { scope = currentScope } = {}) {
    const record = await get(id, { scope, includeDeleted: true });
    if (!record) return null;
    const next = { ...record, deletedAt: now(), status: 'deleted' };
    await persist(scope, next);
    if (!record.ownerId) {
      await storage(scope).remove(id);
      await persist(scope, { ...next, localPath: null, cachePath: null });
    }
    // A tombstone is durable before any object deletion is attempted. Keep
    // the local bytes until the queue acknowledges removal for retry safety.
    if (record.ownerId && record.objectKey) await queue.enqueue(scope, { id, op: 'delete' });
    return publicRecord(next);
  }

  async function objectAlreadyUploaded(record) {
    if (objectExists) return !!(await objectExists(record));
    if (!client) return false;
    try {
      const { data, error } = await client.storage.from(bucket).download(record.objectKey);
      if (error || !data) return false;
      const bytes = Buffer.from(await data.arrayBuffer());
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== record.byteSize || digest !== record.checksum) {
        throw attachmentError(
          'Remote attachment checksum does not match metadata.',
          'ATTACHMENT_CHECKSUM_MISMATCH'
        );
      }
      return true;
    } catch (error) {
      if (error?.code === 'ATTACHMENT_CHECKSUM_MISMATCH') throw error;
      return false;
    }
  }

  function isAlreadyExistsError(error) {
    return Boolean(
      error &&
      (error.status === 409 ||
        error.statusCode === 409 ||
        error.code === '409' ||
        /already exists|duplicate|asset exists/i.test(String(error.message || error)))
    );
  }

  async function uploadViaClient(record, bytes) {
    // Check first so a successful object upload followed by a failed metadata
    // update is idempotent on retry, even when the caller did not provide a
    // custom objectExists hook.
    if (await objectAlreadyUploaded(record)) return;
    try {
      if (uploadObject) return await uploadObject(record, bytes);
      if (!client) throw new Error('No attachment upload transport is configured.');
      const { error } = await client.storage.from(bucket).upload(record.objectKey, bytes, {
        contentType: record.contentType,
        upsert: false,
      });
      if (error) throw error;
    } catch (error) {
      if ((await objectAlreadyUploaded(record)) || isAlreadyExistsError(error)) return;
      throw error;
    }
  }

  async function downloadViaClient(record) {
    if (downloadObject) return Buffer.from(await downloadObject(record));
    if (!client) throw new Error('No attachment download transport is configured.');
    const { data, error } = await client.storage.from(bucket).download(record.objectKey);
    if (error) throw error;
    return Buffer.from(await data.arrayBuffer());
  }

  async function removeViaClient(record) {
    if (removeObject) return removeObject(record);
    if (!client) throw new Error('No attachment deletion transport is configured.');
    const { error } = await client.storage.from(bucket).remove([record.objectKey]);
    if (error) throw error;
  }

  async function reserveRemote(record) {
    if (!client) return;
    const { error } = await client.from('item_attachments').insert(toCloudRow(record));
    if (error && !['23505', 'PGRST116'].includes(error.code)) throw error;
  }

  async function markRemote(record, patch) {
    if (!client) return;
    const { error } = await client
      .from('item_attachments')
      .update(patch)
      .eq('id', record.id)
      .eq('owner_id', record.ownerId);
    if (error) throw error;
  }

  async function uploadRecord(record, scope) {
    if (!record.ownerId || !record.objectKey || record.deletedAt) return;
    const local = await storage(scope).read(record.id);
    if (!local) throw new Error('local attachment bytes are unavailable');
    if (local.bytes.length !== record.byteSize) throw new Error('local attachment size changed');
    const digest = crypto.createHash('sha256').update(local.bytes).digest('hex');
    if (digest !== record.checksum) throw new Error('local attachment checksum changed');
    await reserveRemote(record);
    await uploadViaClient(record, local.bytes);
    await markRemote(record, { status: 'ready', synced_at: new Date(now()).toISOString() });
    await persist(scope, { ...record, status: 'available', syncedAt: now() });
  }

  async function deleteRecord(record, scope) {
    if (record.ownerId && record.objectKey) {
      await markRemote(record, {
        status: 'deleted',
        deleted_at: new Date(record.deletedAt || now()).toISOString(),
      });
      await removeViaClient(record);
    }
    await storage(scope).remove(record.id);
    await persist(scope, { ...record, status: 'deleted', localPath: null, cachePath: null });
  }

  async function processQueue({ scope = currentScope, limit = 20, at = now() } = {}) {
    assertScope(scope);
    const generation = operationGeneration;
    const jobs = await queue.list(scope, { dueOnly: true, at });
    const results = [];
    for (const job of jobs.slice(0, limit)) {
      const record = await get(job.id, { scope, includeDeleted: true });
      try {
        assertCurrent(scope, generation);
        if (!record) {
          await queue.acknowledge(scope, job.id, job.op);
        } else if (job.op === 'upload') {
          if (record.deletedAt) await queue.acknowledge(scope, job.id, job.op);
          else {
            await persist(scope, { ...record, status: 'uploading' });
            await uploadRecord({ ...record, status: 'uploading' }, scope);
            assertCurrent(scope, generation);
            await queue.acknowledge(scope, job.id, job.op);
          }
        } else if (job.op === 'delete') {
          await deleteRecord(record, scope);
          assertCurrent(scope, generation);
          await queue.acknowledge(scope, job.id, job.op);
        } else {
          await queue.acknowledge(scope, job.id, job.op);
        }
        results.push({ id: job.id, op: job.op, ok: true });
      } catch (error) {
        if (error?.code === 'ATTACHMENT_CANCELLED') {
          results.push({ id: job.id, op: job.op, ok: false, cancelled: true, error });
          break;
        }
        log.warn('attachment transfer failed; queued for retry', { id: job.id, op: job.op, error });
        if (record)
          await persist(scope, { ...record, status: record.deletedAt ? 'deleted' : 'failed' });
        await queue.fail(scope, job.id, job.op, error, { at });
        results.push({ id: job.id, op: job.op, ok: false, error });
      }
    }
    return results;
  }

  async function download(id, { scope = currentScope } = {}) {
    const generation = operationGeneration;
    const record = await get(id, { scope });
    assertCurrent(scope, generation);
    if (!record || record.deletedAt)
      throw attachmentError('Attachment is unavailable.', 'ATTACHMENT_UNAVAILABLE');
    if (!isOpenableAttachment(record))
      throw attachmentError('Attachment type cannot be opened.', 'UNSUPPORTED_ATTACHMENT_TYPE');
    const local = await storage(scope).read(id);
    if (local) {
      const digest = crypto.createHash('sha256').update(local.bytes).digest('hex');
      if (digest === record.checksum && local.bytes.length === record.byteSize)
        return local.filePath;
      await storage(scope).remove(id, { removeCache: true });
    }
    if (record.status !== 'available' && record.status !== 'ready') {
      throw attachmentError('Attachment is unavailable offline.', 'ATTACHMENT_OFFLINE');
    }
    const bytes = await downloadViaClient(record);
    assertCurrent(scope, generation);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== record.byteSize || digest !== record.checksum) {
      throw attachmentError(
        'Downloaded attachment failed checksum validation.',
        'ATTACHMENT_CHECKSUM_MISMATCH'
      );
    }
    const filePath = await storage(scope).writeCache(id, bytes);
    assertCurrent(scope, generation);
    await persist(scope, { ...record, cachePath: filePath });
    await evictCache(scope, id);
    return filePath;
  }

  async function evictCache(scope = currentScope, keepId = null) {
    const records = await list({ scope, includeDeleted: true });
    const entries = [];
    for (const record of records) {
      if (!record.cachePath || record.id === keepId || record.localPath) continue;
      const stat = await fsp.stat(record.cachePath).catch(() => null);
      if (stat?.isFile()) entries.push({ record, size: stat.size, mtime: stat.mtimeMs });
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const entry of entries) {
      if (total <= cacheLimitBytes) break;
      await fsp.unlink(entry.record.cachePath).catch(() => {});
      total -= entry.size;
      await persist(scope, { ...entry.record, cachePath: null });
    }
    return { bytes: total, files: entries.length };
  }

  async function setAccount(nextAccountId) {
    operationGeneration += 1;
    currentScope = scopeFor(nextAccountId);
    return currentScope;
  }

  // Explicitly associate a local-only profile with an account. It copies bytes
  // into the account's private directory before queueing uploads, so a later
  // account switch cannot expose or upload the local profile by accident.
  async function associateLocalAccount(nextAccountId) {
    const targetScope = scopeFor(nextAccountId);
    if (targetScope === 'local')
      throw new Error('An account id is required to associate local attachments.');
    const generation = operationGeneration;
    const locals = await list({ scope: 'local', includeDeleted: true });
    for (const record of locals) {
      assertCurrent('local', generation);
      const source = await storage('local').localPath(record.id);
      if (!source) continue;
      const copied = await storage(targetScope).copyIn(source, record.id);
      const next = {
        ...record,
        ownerId: targetScope,
        objectKey: objectKey(targetScope, record.itemId, record.id),
        localPath: copied.localPath,
        checksum: copied.checksum,
        byteSize: copied.byteSize,
        status: record.deletedAt ? 'deleted' : 'pending',
      };
      await persist(targetScope, next);
      if (!record.deletedAt && next.ownerId && next.objectKey) {
        await queue.enqueue(targetScope, { id: next.id, op: 'upload' });
      }
    }
    currentScope = targetScope;
  }

  async function pullMetadata({ scope = currentScope, since = null } = {}) {
    assertScope(scope);
    // Local-only attachments have no cloud owner and must never query the
    // account metadata table with the literal `local` scope.
    if (!client || scope === 'local') return [];
    const generation = operationGeneration;
    const pendingDeletes = new Set(
      (await queue.list(scope)).filter((job) => job.op === 'delete').map((job) => job.id)
    );
    const merged = [];
    let offset = 0;
    while (true) {
      let query = client.from('item_attachments').select('*').eq('owner_id', scope);
      if (since != null) query = query.gt('synced_at', new Date(since).toISOString());
      query = query.order('synced_at', { ascending: true }).order('id', { ascending: true });
      if (typeof query.range === 'function') query = query.range(offset, offset + 999);
      const { data, error } = await query;
      if (error) throw error;
      const rows = data || [];
      for (const row of rows) {
        assertCurrent(scope, generation);
        const remote = fromCloudRow(row);
        const local = await get(remote.id, { scope, includeDeleted: true });
        if (remote.deletedAt || remote.status === 'deleted') {
          const tombstone = {
            ...(local || {}),
            ...remote,
            ownerId: scope,
            status: 'deleted',
            deletedAt: remote.deletedAt || now(),
            localPath: null,
            cachePath: null,
          };
          await persist(scope, tombstone);
          await storage(scope).remove(remote.id);
          merged.push(publicRecord(tombstone));
          continue;
        }
        // A live remote row can be older than an offline local deletion. Keep
        // that tombstone until the remote metadata confirms deletion.
        if (local?.deletedAt || pendingDeletes.has(remote.id)) {
          merged.push(publicRecord(local));
          continue;
        }
        // Cloud metadata must not erase a local managed copy or a still-pending
        // transfer. The server status only advances the transfer state.
        const next = {
          ...(local || {}),
          ...remote,
          ownerId: scope,
          localPath: local?.localPath || null,
          cachePath: local?.cachePath || null,
          status: local?.localPath && local.status === 'pending' ? local.status : remote.status,
        };
        await persist(scope, next);
        merged.push(publicRecord(next));
      }
      offset += rows.length;
      if (rows.length < 1000 || typeof query.range !== 'function') break;
    }
    return merged;
  }

  async function listRemoteObjects(scope) {
    if (listObjects) return listObjects(scope);
    const storageApi = client?.storage?.from?.(bucket);
    if (!storageApi || typeof storageApi.list !== 'function') return [];
    async function listPath(prefix) {
      const entries = [];
      let offset = 0;
      while (true) {
        const result = await storageApi.list(prefix, { limit: 1000, offset });
        if (result.error) throw result.error;
        const page = result.data || [];
        entries.push(...page);
        offset += page.length;
        if (page.length < 1000) break;
      }
      return entries;
    }
    const objects = [];
    for (const folder of await listPath(scope)) {
      if (folder.id && folder.metadata) {
        objects.push({ ...folder, name: scope + '/' + folder.name });
        continue;
      }
      const prefix = scope + '/' + folder.name;
      for (const object of await listPath(prefix)) {
        objects.push({
          ...object,
          name: prefix + '/' + object.name,
          created_at: object.created_at || object.updated_at,
        });
      }
    }
    return objects;
  }

  async function removeRemoteObject(object, scope) {
    const name = typeof object === 'string' ? object : object?.name;
    if (!name || !name.startsWith(scope + '/')) return false;
    if (removeObject) {
      await removeObject({ objectKey: name, ownerId: scope });
      return true;
    }
    const storageApi = client?.storage?.from?.(bucket);
    if (!storageApi || typeof storageApi.remove !== 'function') return false;
    const { error } = await storageApi.remove([name]);
    if (error) throw error;
    return true;
  }

  async function reconcile({
    scope = currentScope,
    graceMs = 60 * 60 * 1000,
    cleanupOrphans = false,
  } = {}) {
    if (!client || scope === 'local') return { reservations: 0, orphanObjects: 0 };
    const cutoff = new Date(now() - graceMs).toISOString();
    let reservations = 0;
    const pending = await client
      .from('item_attachments')
      .select('*')
      .eq('owner_id', scope)
      .eq('status', 'pending')
      .lt('created_at', cutoff);
    if (pending.error) throw pending.error;
    for (const row of pending.data || []) {
      const result = await client
        .from('item_attachments')
        .update({ status: 'failed' })
        .eq('id', row.id)
        .eq('owner_id', scope);
      if (result.error) throw result.error;
      reservations += 1;
    }
    let orphanObjects = 0;
    if (cleanupOrphans && client) {
      const objects = await listRemoteObjects(scope);
      for (const object of objects || []) {
        const known = await client
          .from('item_attachments')
          .select('id')
          .eq('owner_id', scope)
          .eq('object_key', object.name)
          .maybeSingle();
        const noRow =
          !known.data && (!known.error || ['PGRST116', '404'].includes(String(known.error.code)));
        if (known.error && !noRow) throw known.error;
        if (noRow) {
          const created = Date.parse(object.created_at || '');
          // An object without provider creation metadata is not safe to
          // classify as an old orphan; leave it for a trusted operator.
          if (Number.isFinite(created) && created < now() - graceMs) {
            if (await removeRemoteObject(object, scope)) orphanObjects += 1;
          }
        }
      }
    }
    return { reservations, orphanObjects };
  }

  return {
    get currentScope() {
      return currentScope;
    },
    setClient(nextClient) {
      client = nextClient;
    },
    add,
    importBytes,
    enqueueImported,
    discardImport,
    discardImported,
    get,
    list,
    remove,
    download,
    processQueue,
    setAccount,
    associateLocalAccount,
    pullMetadata,
    reconcile,
    evictCache,
    usage: (scope = currentScope) => storage(scope).usage(),
    storage: (scope = currentScope) => storage(scope),
    queue,
  };
}

module.exports = {
  ATTACHMENT_SCHEMA,
  BUCKET,
  emptyState,
  normalizeState,
  scopeFor,
  objectKey,
  toCloudRow,
  fromCloudRow,
  createAttachmentService,
};
