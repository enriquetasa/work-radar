'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {
  MAX_ATTACHMENT_BYTES,
  ALLOWED_CONTENT_TYPES,
  attachmentError,
} = require('./attachment-validation');

const FULL_BACKUP_FORMAT = 'work-radar-full-backup';
const FULL_BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 500 * 1024 * 1024;

function safeManifestId(value, label = 'attachment id') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw attachmentError(`Backup contains an invalid ${label}.`, 'INVALID_BACKUP');
  }
  return value;
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function checksum(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function octal(value, width) {
  const text = Math.max(0, value).toString(8);
  return text.padStart(width - 1, '0') + '\0';
}

function tarHeader(name, size, mode = 0o600) {
  const header = Buffer.alloc(512);
  const write = (offset, length, value) =>
    header.write(String(value), offset, Math.min(length, Buffer.byteLength(String(value))), 'utf8');
  if (Buffer.byteLength(name) > 100) throw attachmentError('Backup archive path is too long.');
  write(0, 100, name);
  write(100, 8, octal(mode, 8));
  write(108, 8, octal(0, 8));
  write(116, 8, octal(0, 8));
  write(124, 12, octal(size, 12));
  write(136, 12, octal(Math.floor(Date.now() / 1000), 12));
  header.fill(0x20, 148, 156);
  write(156, 1, '0');
  write(257, 6, 'ustar\0');
  write(263, 2, '00');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(octal(sum, 8), 148, 8, 'ascii');
  return header;
}

function tarEntry(name, bytes) {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([tarHeader(name, content.length), content, padding]);
}

function createTarGz(entries, { gzip = zlib.gzipSync } = {}) {
  const tar = Buffer.concat([
    ...entries.map((entry) => tarEntry(entry.name, entry.bytes)),
    Buffer.alloc(1024),
  ]);
  return gzip(tar, { mtime: 0 });
}

function safeArchivePath(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw attachmentError('Backup archive contains an unsafe path.', 'UNSAFE_BACKUP_PATH');
  }
  return name;
}

function parseOctal(buffer, start, length) {
  const value = buffer
    .toString('ascii', start, start + length)
    .replace(/\0.*$/, '')
    .trim();
  return value ? parseInt(value, 8) : 0;
}

function parseTarGz(input, { gunzip = zlib.gunzipSync, maxBytes = MAX_BACKUP_BYTES } = {}) {
  const compressed = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let tar;
  try {
    tar = gunzip(compressed, { maxOutputLength: maxBytes });
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE')
      throw attachmentError('Backup archive is too large.', 'BACKUP_TOO_LARGE');
    throw error;
  }
  if (tar.length > maxBytes)
    throw attachmentError('Backup archive is too large.', 'BACKUP_TOO_LARGE');
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = safeArchivePath(header.toString('utf8', 0, 100).replace(/\0.*$/, ''));
    const type = header[156];
    if (type !== 0 && type !== 48)
      throw attachmentError('Backup archive contains an unsupported entry.');
    const size = parseOctal(header, 124, 12);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > maxBytes ||
      offset + 512 + size > tar.length
    ) {
      throw attachmentError('Backup archive contains an invalid entry size.');
    }
    if (entries.has(name))
      throw attachmentError(`Backup archive contains duplicate entry: ${name}.`);
    entries.set(name, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function createFullBackupArchive(options = {}) {
  const { data, history = [], attachments = [], readAttachmentBytes, now = Date.now } = options;
  if (!data || typeof data !== 'object') throw new Error('createFullBackupArchive requires data');
  const files = [];
  const manifestAttachments = [];
  const missing = [];
  for (const record of attachments) {
    if (!record || !record.id || record.deletedAt) continue;
    const id = safeManifestId(record.id);
    safeManifestId(record.itemId, 'item id');
    if (!ALLOWED_CONTENT_TYPES.has(String(record.contentType || '').toLowerCase())) {
      throw attachmentError(
        `Backup contains unsupported attachment type for ${id}.`,
        'INVALID_BACKUP'
      );
    }
    let bytes = record.bytes;
    if (!bytes && readAttachmentBytes) bytes = await readAttachmentBytes(record);
    if (!bytes) {
      missing.push(record.id);
      continue;
    }
    bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (bytes.length > MAX_ATTACHMENT_BYTES)
      throw attachmentError(
        'Backup contains an attachment over the size limit.',
        'ATTACHMENT_TOO_LARGE'
      );
    const archivePath = `attachments/${id}`;
    const entry = {
      id,
      itemId: record.itemId,
      displayName: record.displayName,
      contentType: record.contentType,
      byteSize: bytes.length,
      checksum: checksum(bytes),
      path: archivePath,
    };
    manifestAttachments.push(entry);
    files.push({ name: archivePath, bytes });
  }
  if (missing.length) {
    const error = attachmentError(
      'Some attachment bytes are unavailable; backup is incomplete.',
      'INCOMPLETE_BACKUP'
    );
    error.missing = missing;
    throw error;
  }
  const manifest = {
    format: FULL_BACKUP_FORMAT,
    version: FULL_BACKUP_VERSION,
    createdAt: new Date(now()).toISOString(),
    attachments: manifestAttachments,
  };
  const entries = [
    { name: 'manifest.json', bytes: jsonBytes(manifest) },
    { name: 'data.json', bytes: jsonBytes(data) },
    { name: 'history.json', bytes: jsonBytes(history) },
    ...files,
  ];
  return createTarGz(entries);
}

function parseJsonEntry(entries, name) {
  const bytes = entries.get(name);
  if (!bytes) throw attachmentError(`Backup archive is missing ${name}.`, 'INVALID_BACKUP');
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw attachmentError(`Backup archive contains invalid ${name}.`, 'INVALID_BACKUP');
  }
}

function validateManifest(manifest, entries) {
  if (
    !manifest ||
    manifest.format !== FULL_BACKUP_FORMAT ||
    manifest.version !== FULL_BACKUP_VERSION ||
    !Array.isArray(manifest.attachments)
  ) {
    throw attachmentError('Unsupported full backup archive.', 'INVALID_BACKUP');
  }
  const attachments = [];
  const ids = new Set();
  for (const item of manifest.attachments) {
    if (!item || typeof item !== 'object')
      throw attachmentError('Backup contains an invalid attachment manifest.', 'INVALID_BACKUP');
    const id = safeManifestId(item.id);
    safeManifestId(item.itemId, 'item id');
    if (ids.has(id))
      throw attachmentError(
        'Backup contains duplicate or invalid attachment ids.',
        'INVALID_BACKUP'
      );
    ids.add(id);
    if (
      typeof item.displayName !== 'string' ||
      !item.displayName ||
      item.displayName.length > 255
    ) {
      throw attachmentError(`Backup contains an invalid filename for ${id}.`, 'INVALID_BACKUP');
    }
    if (!ALLOWED_CONTENT_TYPES.has(String(item.contentType || '').toLowerCase())) {
      throw attachmentError(
        `Backup contains an unsupported attachment type for ${id}.`,
        'INVALID_BACKUP'
      );
    }
    if (
      !Number.isSafeInteger(item.byteSize) ||
      item.byteSize < 0 ||
      item.byteSize > MAX_ATTACHMENT_BYTES
    ) {
      throw attachmentError(`Backup contains an invalid size for ${id}.`, 'INVALID_BACKUP');
    }
    if (typeof item.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(item.checksum)) {
      throw attachmentError(`Backup contains an invalid checksum for ${id}.`, 'INVALID_BACKUP');
    }
    const expectedPath = `attachments/${id}`;
    if (item.path !== expectedPath)
      throw attachmentError(`Backup path does not match attachment ${id}.`, 'INVALID_BACKUP');
    safeArchivePath(item.path);
    const bytes = entries.get(item.path);
    if (!bytes || bytes.length !== item.byteSize || checksum(bytes) !== item.checksum) {
      throw attachmentError(
        `Backup attachment ${item.id} failed checksum validation.`,
        'BACKUP_CHECKSUM_MISMATCH'
      );
    }
    attachments.push({ ...item, bytes });
  }
  for (const name of entries.keys()) {
    if (name.startsWith('attachments/') && !attachments.some((item) => item.path === name)) {
      throw attachmentError(`Backup has an unlisted attachment entry: ${name}.`, 'INVALID_BACKUP');
    }
  }
  return attachments;
}

function parseFullBackupArchive(input, options = {}) {
  const entries = parseTarGz(input, options);
  const manifest = parseJsonEntry(entries, 'manifest.json');
  const attachments = validateManifest(manifest, entries);
  return {
    manifest,
    data: parseJsonEntry(entries, 'data.json'),
    history: parseJsonEntry(entries, 'history.json'),
    attachments,
  };
}

async function importFullBackupArchive(
  input,
  { writeAttachment, removeAttachment, ...options } = {}
) {
  const backup = parseFullBackupArchive(input, options);
  const written = [];
  if (writeAttachment) {
    try {
      for (const attachment of backup.attachments) {
        // A caller can report that a validated attachment already exists with
        // identical bytes. Such records are intentionally skipped so a
        // repeated full backup import remains idempotent and rollback only
        // removes records created by this import.
        const result = await writeAttachment(attachment);
        if (result?.created !== false) written.push(attachment);
      }
    } catch (error) {
      if (removeAttachment) {
        for (const attachment of written.reverse()) {
          await removeAttachment(attachment).catch(() => {});
        }
      }
      throw error;
    }
  }
  return backup;
}

module.exports = {
  FULL_BACKUP_FORMAT,
  FULL_BACKUP_VERSION,
  MAX_BACKUP_BYTES,
  checksum,
  createTarGz,
  parseTarGz,
  createFullBackupArchive,
  parseFullBackupArchive,
  importFullBackupArchive,
  restoreFullBackupArchive: importFullBackupArchive,
};
