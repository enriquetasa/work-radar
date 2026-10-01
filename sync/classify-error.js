'use strict';
const NETWORK_PATTERN =
  /fetch failed|network|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|socket hang up/i;
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNRESET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function classifyError(err) {
  if (!err) return 'error';
  if (NETWORK_CODES.has(err.code)) return 'offline';
  const message = String(err.message || err.reason || err);
  if (NETWORK_PATTERN.test(message)) return 'offline';
  // Browser-style fetch failures may only expose a bare TypeError.
  if (err instanceof TypeError && !err.code && err.details === undefined) return 'offline';
  return 'error';
}

module.exports = { classifyError };
