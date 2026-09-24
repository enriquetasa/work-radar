'use strict';
/* ============================================================
   WORK RADAR — keyset pull pagination
   Implements the pull side of the synced_at_trigger migration's
   comment (supabase/migrations/..._synced_at_trigger.sql): a paginated
   pull must key on (synced_at, id) together, never `synced_at` alone,
   or a page boundary landing inside a batch that shared one `synced_at`
   (every row in one push_items/push_log_entries call gets the same
   `now()`) can silently skip the rest of that batch. And the *first*
   page of a pull must start from `cursor - lookback`, not a bare
   `gt(cursor)`, because `now()` is transaction-start time: two
   overlapping pushes can commit out of the order their synced_at
   values suggest, so a row can commit "behind" a cursor already
   advanced past it. Re-pulling the lookback window is safe because
   mergeItem/unionLogs (renderer/domain.js) are idempotent.

   `pageFn` is injected (see sync-engine.js for the real PostgREST-backed
   implementation) so the pagination loop itself — the part with actual
   logic worth testing — is exercised here with a fake, not a live
   database.
   ============================================================ */

const EPOCH_ISO = '1970-01-01T00:00:00.000Z';

// The PostgREST filter for "everything after this (synced_at, id) pair,
// as a compound key" — `synced_at > X`, OR (`synced_at = X` AND
// `id > Y`) — passed to `.or()`. There is no row-value comparison
// operator in PostgREST, so this is the standard two-clause expansion of
// one. Only needed once a page boundary falls *inside* a shared
// synced_at value; the very first page of a pull has no prior row to
// key off, so it uses a plain `gt(synced_at, sinceIso)` instead (see
// sync-engine.js's defaultPullPage).
function keysetOrFilter(sinceIso, afterId) {
  return `synced_at.gt.${sinceIso},and(synced_at.eq.${sinceIso},id.gt.${afterId})`;
}

// Pages through `pageFn` from `cursorMs - lookbackMs` (or the epoch, if
// there is no cursor yet — a brand-new machine's first pull) until a
// short page signals the end. Returns every row pulled plus the new
// cursor: the greatest `synced_at` actually seen, converted back to ms
// — or the unchanged input cursor if nothing came back at all, so a
// pull that finds nothing never *regresses* the persisted cursor.
async function pullAll({ pageFn, cursorMs, lookbackMs, pageSize, isoToMs, msToIso }) {
  const sinceMs = cursorMs == null ? null : Math.max(0, cursorMs - lookbackMs);
  let sinceIso = sinceMs == null ? EPOCH_ISO : msToIso(sinceMs);
  let afterId = null;
  const rows = [];
  let maxSyncedAtMs = cursorMs ?? null;

  for (;;) {
    // Pagination is inherently sequential — each page's cursor depends
    // on the previous page's last row — so this loop cannot parallelize.
    const page = await pageFn({ sinceIso, afterId, limit: pageSize });
    if (!page || !page.length) break;
    rows.push(...page);
    const last = page[page.length - 1];
    sinceIso = last.synced_at;
    afterId = last.id;
    const lastMs = isoToMs(last.synced_at);
    if (maxSyncedAtMs == null || lastMs > maxSyncedAtMs) maxSyncedAtMs = lastMs;
    if (page.length < pageSize) break; // short page => reached the end
  }

  return { rows, cursor: maxSyncedAtMs };
}

module.exports = { EPOCH_ISO, keysetOrFilter, pullAll };
