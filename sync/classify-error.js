'use strict';
/* ============================================================
   WORK RADAR — sync error classification
   Decides whether a failed push/pull round trip should show as
   OFFLINE (no network — retry quietly, this is expected while
   disconnected) or ERROR (something else — a bug, a server rejection,
   a misconfigured RLS policy — worth a loud log line and, eventually,
   the user's attention) in the header status (see
   docs/supabase-sync-plan.md's Phase 4 notes).

   There's no `navigator.onLine` in the main process, and supabase-js
   doesn't tag its own errors with a stable "this was a network
   failure" flag, so this is a best-effort heuristic over the shapes
   `fetch`/undici and Postgres actually produce. False positives err
   towards OFFLINE (a transient blip retried with backoff) rather than
   ERROR (which reads as "this needs attention"), since a network
   failure is far more likely in practice than a genuinely new failure
   mode. Pure, no IO.
   ============================================================ */

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
  // A bare TypeError with no Postgres-style `code`/`details` is what a
  // failed `fetch()` itself throws (undici wraps the real cause in
  // `err.cause`, but the outer error is just "fetch failed" — already
  // caught above by NETWORK_PATTERN; this is a fallback for older/other
  // fetch implementations that don't use that exact wording).
  if (err instanceof TypeError && !err.code && err.details === undefined) return 'offline';
  return 'error';
}

module.exports = { classifyError };
