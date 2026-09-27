'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { assertScope, attachmentError, MAX_ATTACHMENT_BYTES } = require('./attachment-validation');

function safeId(value, label = 'attachment id') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw attachmentError(`Invalid ${label}.`);
  }
  return value;
}

function safePath(rootDir, ...parts) {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...parts);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw attachmentError('Attachment path escapes managed storage.');
  }
  return target;
}

async function hashFile(filePath, { maxBytes = MAX_ATTACHMENT_BYTES, fsModule = fs } = {}) {
  const hash = crypto.createHash('sha256');
  let total = 0;
  const stream = fsModule.createReadStream(filePath);
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > maxBytes)
        throw attachmentError(
          `Attachments must be at most ${maxBytes} bytes.`,
          'ATTACHMENT_TOO_LARGE'
        );
      hash.update(chunk);
    }
  } finally {
    stream.destroy();
  }
  return { byteSize: total, checksum: hash.digest('hex') };
}

function createAttachmentStorage(options = {}) {
  const { rootDir, scope, fsModule = fs, randomUUID = crypto.randomUUID, now = Date.now } = options;
  if (!rootDir) throw new Error('createAttachmentStorage requires rootDir');
  assertScope(scope);

  const filesDir = safePath(rootDir, scope, 'files');
  const cacheDir = safePath(rootDir, scope, 'cache');

  async function ensureDirs() {
    await fsp.mkdir(filesDir, { recursive: true });
    await fsp.mkdir(cacheDir, { recursive: true });
  }

  function managedPath(attachmentId) {
    return safePath(filesDir, `${safeId(attachmentId)}.bin`);
  }

  function cachedPath(attachmentId) {
    return safePath(cacheDir, `${safeId(attachmentId)}.bin`);
  }

  async function copyIn(sourcePath, attachmentId = randomUUID()) {
    if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
      throw attachmentError('Attachment source paths must be absolute.');
    }
    const source = await fsp.stat(sourcePath);
    if (!source.isFile()) throw attachmentError('Attachment source is not a regular file.');
    if (source.size > MAX_ATTACHMENT_BYTES) {
      throw attachmentError(
        `Attachments must be at most ${MAX_ATTACHMENT_BYTES} bytes.`,
        'ATTACHMENT_TOO_LARGE'
      );
    }
    await ensureDirs();
    const destination = managedPath(attachmentId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsp.copyFile(sourcePath, temporary, fsModule.constants.COPYFILE_EXCL);
      const digest = await hashFile(temporary, { fsModule, maxBytes: MAX_ATTACHMENT_BYTES });
      await fsp.rename(temporary, destination);
      return { attachmentId, localPath: destination, ...digest, copiedAt: now() };
    } catch (error) {
      await fsp.unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async function writeCache(attachmentId, bytes) {
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
    if (bytes.length > MAX_ATTACHMENT_BYTES)
      throw attachmentError(
        'Downloaded attachment exceeds the size limit.',
        'ATTACHMENT_TOO_LARGE'
      );
    await ensureDirs();
    const destination = cachedPath(attachmentId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await fsp.writeFile(temporary, bytes, { flag: 'wx' });
    try {
      await fsp.rename(temporary, destination);
    } catch (error) {
      await fsp.unlink(temporary).catch(() => {});
      throw error;
    }
    return destination;
  }

  async function localPath(attachmentId) {
    const managed = managedPath(attachmentId);
    try {
      await fsp.access(managed, fs.constants.R_OK);
      return managed;
    } catch {
      /* managed copy absent; try the cache */
    }
    const cached = cachedPath(attachmentId);
    try {
      await fsp.access(cached, fs.constants.R_OK);
      return cached;
    } catch {
      return null;
    }
  }

  async function read(attachmentId) {
    const filePath = await localPath(attachmentId);
    if (!filePath) return null;
    return { filePath, bytes: await fsp.readFile(filePath) };
  }

  async function remove(attachmentId, { removeCache = true } = {}) {
    await fsp.unlink(managedPath(attachmentId)).catch(() => {});
    if (removeCache) await fsp.unlink(cachedPath(attachmentId)).catch(() => {});
  }

  async function usage() {
    let totalBytes = 0;
    let files = 0;
    await ensureDirs();
    for (const dir of [filesDir, cacheDir]) {
      for (const name of await fsp.readdir(dir)) {
        const candidate = safePath(dir, name);
        const stat = await fsp.stat(candidate).catch(() => null);
        if (stat?.isFile()) {
          files += 1;
          totalBytes += stat.size;
        }
      }
    }
    return { files, totalBytes };
  }

  return {
    scope,
    filesDir,
    cacheDir,
    ensureDirs,
    managedPath,
    cachedPath,
    copyIn,
    hashFile: (filePath) => hashFile(filePath, { fsModule }),
    writeCache,
    localPath,
    read,
    remove,
    usage,
  };
}

module.exports = { createAttachmentStorage, hashFile, safePath, safeId };
