'use strict';
const EPOCH_ISO = '1970-01-01T00:00:00.000Z';

// Expand a compound (timestamp, id) cursor into PostgREST predicates.
function keysetOrFilter(sinceIso, afterId, cursorField = 'synced_at') {
  if (!['synced_at', 'server_received_at'].includes(cursorField)) {
    throw new Error('unsupported pull cursor field');
  }
  return `${cursorField}.gt.${sinceIso},and(${cursorField}.eq.${sinceIso},id.gt.${afterId})`;
}

// Pull sequential pages with lookback and return the greatest observed cursor.
async function pullAll({
  pageFn,
  cursorMs,
  lookbackMs,
  pageSize,
  isoToMs,
  msToIso,
  cursorField = 'synced_at',
}) {
  const sinceMs = cursorMs == null ? null : Math.max(0, cursorMs - lookbackMs);
  let sinceIso = sinceMs == null ? EPOCH_ISO : msToIso(sinceMs);
  let afterId = null;
  const rows = [];
  let maxSyncedAtMs = cursorMs ?? null;

  for (;;) {
    const page = await pageFn({ sinceIso, afterId, limit: pageSize });
    if (!page || !page.length) break;
    rows.push(...page);
    const last = page[page.length - 1];
    sinceIso = last[cursorField];
    afterId = last.id;
    const lastMs = isoToMs(last[cursorField]);
    if (maxSyncedAtMs == null || lastMs > maxSyncedAtMs) maxSyncedAtMs = lastMs;
    if (page.length < pageSize) break; // short page => reached the end
  }

  return { rows, cursor: maxSyncedAtMs };
}

module.exports = { EPOCH_ISO, keysetOrFilter, pullAll };
