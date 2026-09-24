'use strict';
/* ============================================================
   WORK RADAR — stale-push remediation
   Known gap called out in supabase/migrations/..._push_rpc_functions.sql
   and docs/supabase-sync-plan.md's Phase 2 notes: push_items rejects a
   push as `stale_or_not_owned` purely on `updated_at`, but the client's
   own mergeItem (renderer/domain.js) breaks a tie on an *equal*
   updated_at with a further chain (reviewedAt, then archivedAt, then
   deletedAt, then a stable stringify). On that rare exact-millisecond
   tie, the server and a client's local merge can disagree about which
   side should have won — the row lands in Supabase with the remote
   content, but this client's own mergeItem still prefers its local
   copy.

   `localWinsOverRemote` answers "does mergeItem, given both versions,
   actually still prefer the local one?" — the sync engine (see
   sync-engine.js) only re-stamps and retries a rejected push when this
   is true, rather than for every rejection (which would just be "always
   prefer local", defeating the newest-wins point of the push RPC in
   the first place).

   Pure — takes domain.js's own mergeItem as a parameter rather than
   requiring it, so this has no dependency of its own on renderer/.
   ============================================================ */

// mergeItem returns `{ ...winner, log }` — the winner's own fields
// (everything except the unioned `log`) survive untouched, so comparing
// every non-log field against `local` tells us which side (by content,
// not by reference — mergeItem may have spread a new object) actually
// won.
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

// Same idea as sameNonLogFields, but also ignores `updatedAt` — used to
// tell "this is genuinely the same edit, just seen twice" (an
// already-accepted push retried after a mid-batch failure, or two
// machines' first sync overlapping on identical data) apart from "the
// content actually differs". Two rows can have every visible field
// (name, status, notes, reviewedAt, archivedAt, deletedAt, ...) equal
// while updatedAt itself differs (or is exactly equal) — that's exactly
// what push_items's stale_or_not_owned rejection looks like for a
// harmless retry, and content-identical rows must never be re-stamped
// (found in review: re-stamping one just to push the same content again
// spreads a content-free updatedAt bump to every machine, forever).
function sameContentIgnoringUpdatedAt(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete('log');
  keys.delete('updatedAt');
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

// The single decision sync-engine.js's remediateStaleItems needs for a
// stale_or_not_owned rejection where the remote row does exist and is
// owned by this user: 'resolve' (remove from the outbox — the remote
// copy wins, or the two are the same content already) or 'restamp'
// (bump local's updatedAt strictly past remote's and retry — the rare
// exact-updated_at tie where mergeItem's own tie-break, given both
// versions, still prefers local, AND the content actually differs).
// Content-equality is checked first and short-circuits to 'resolve'
// specifically so a harmless retry/overlap never re-stamps, even though
// localWinsOverRemote alone would say "local wins" for it (mergeItem
// trivially prefers `a` on a full tie — see its own tie-break comment).
function decideStaleRemediation(mergeItem, local, remote) {
  if (sameContentIgnoringUpdatedAt(local, remote)) return 'resolve';
  return localWinsOverRemote(mergeItem, local, remote) ? 'restamp' : 'resolve';
}

module.exports = { localWinsOverRemote, sameContentIgnoringUpdatedAt, decideStaleRemediation };
