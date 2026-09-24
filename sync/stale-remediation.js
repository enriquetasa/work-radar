'use strict';

// mergeItem unions logs, so winner checks compare every other field.
function sameNonLogFields(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete('log');
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function localWinsOverRemote(mergeItem, local, remote) {
  const merged = mergeItem(local, remote);
  return sameNonLogFields(merged, local);
}

// Avoid spreading timestamp-only updates for harmless retries.
function sameContentIgnoringUpdatedAt(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete('log');
  keys.delete('updatedAt');
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

// Re-stamp only a real content conflict whose exact-timestamp tie favors local.
function decideStaleRemediation(mergeItem, local, remote) {
  if (sameContentIgnoringUpdatedAt(local, remote)) return 'resolve';
  return localWinsOverRemote(mergeItem, local, remote) ? 'restamp' : 'resolve';
}

module.exports = { localWinsOverRemote, sameContentIgnoringUpdatedAt, decideStaleRemediation };
