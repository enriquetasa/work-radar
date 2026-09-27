'use strict';

const path = require('node:path');

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_DISPLAY_NAME_LENGTH = 255;
const DEFAULT_CACHE_BYTES = 250 * 1024 * 1024;

// Keep this list deliberately small. In particular, HTML and executable MIME
// types are absent because attachments are opened by the operating system,
// never rendered in the Electron page.
const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/markdown',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const EXTENSION_CONTENT_TYPES = new Map([
  ['.pdf', 'application/pdf'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.csv', 'text/csv'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.txt', 'text/plain'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]);

function attachmentError(message, code = 'INVALID_ATTACHMENT') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeDisplayName(value, fallback = 'attachment') {
  const raw = typeof value === 'string' ? value : '';
  // basename handles both separators because a Windows path may be supplied
  // to a Linux test runner (and vice versa).
  const name = path
    .basename(raw.replaceAll(String.fromCharCode(92), String.fromCharCode(47)))
    .split('')
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim();
  return (name || fallback).slice(0, MAX_DISPLAY_NAME_LENGTH);
}

function inferContentType(displayName) {
  return EXTENSION_CONTENT_TYPES.get(path.extname(displayName).toLowerCase()) || '';
}

function normalizeContentType(contentType, displayName) {
  const supplied =
    typeof contentType === 'string' ? contentType.split(';', 1)[0].trim().toLowerCase() : '';
  const inferred = inferContentType(displayName);
  if (supplied && ALLOWED_CONTENT_TYPES.has(supplied)) return supplied;
  if (!supplied && inferred) return inferred;
  return supplied;
}

function validateAttachmentInput({ itemId, displayName, contentType, byteSize, sourcePath } = {}) {
  if (typeof itemId !== 'string' || !itemId.trim())
    throw attachmentError('An item id is required.');
  const name = normalizeDisplayName(displayName);
  if (!name || name === '.' || name === '..')
    throw attachmentError('A display filename is required.');
  const type = normalizeContentType(contentType, name);
  if (!ALLOWED_CONTENT_TYPES.has(type)) {
    throw attachmentError(
      `Unsupported attachment type: ${type || 'unknown'}.`,
      'UNSUPPORTED_ATTACHMENT_TYPE'
    );
  }
  if (!Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > MAX_ATTACHMENT_BYTES) {
    throw attachmentError(
      `Attachments must be at most ${MAX_ATTACHMENT_BYTES} bytes.`,
      'ATTACHMENT_TOO_LARGE'
    );
  }
  if (
    sourcePath !== undefined &&
    (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath))
  ) {
    throw attachmentError('Attachment source paths must be absolute.');
  }
  return { itemId: itemId.trim(), displayName: name, contentType: type, byteSize };
}

function isOpenableAttachment(record) {
  return Boolean(
    record && ALLOWED_CONTENT_TYPES.has(String(record.contentType || '').toLowerCase())
  );
}

function isValidScope(scope) {
  return scope === 'local' || (typeof scope === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(scope));
}

function assertScope(scope) {
  if (!isValidScope(scope)) throw attachmentError('Invalid attachment account scope.');
  return scope;
}

module.exports = {
  MAX_ATTACHMENT_BYTES,
  MAX_DISPLAY_NAME_LENGTH,
  DEFAULT_CACHE_BYTES,
  ALLOWED_CONTENT_TYPES,
  EXTENSION_CONTENT_TYPES,
  attachmentError,
  normalizeDisplayName,
  inferContentType,
  normalizeContentType,
  validateAttachmentInput,
  isOpenableAttachment,
  isValidScope,
  assertScope,
};
