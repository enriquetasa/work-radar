'use strict';
/* ============================================================
   WORK RADAR — sync engine (Phases 4-5)
   Push dirty items/log entries, pull rows changed since the last
   cursor, merge them into the local data file with the Phase 1 domain
   merge, and tell the renderer to reload. See docs/supabase-sync-plan.md
   → "Phase 4 notes" / "Phase 5 notes" for the design this implements.

   Everything that isn't Electron lives here as a plain, dependency-
   injected module — same split as sync/auth-service.js. `client` is the
   one supabase-js instance main.js already built for auth (see
   main.js's buildAuthService()); the four push/pull functions default
   to real implementations built from it, but can be overridden
   directly in tests, which is far easier to fake convincingly than the
   full `.from(...).select(...)...` PostgREST builder chain — see
   test/sync-engine.test.js.

   main.js is the only caller: it builds this once (alongside
   authService), starts it when signed in and stops it on sign-out, and
   wires its onStatus/onReload callbacks to IPC pushes.
   ============================================================ */

const crypto = require('crypto');
const domain = require('../renderer/domain.js');
const defaultLog = require('../logger');
const mapping = require('./mapping');
const outbox = require('./outbox');
const syncState = require('./sync-state');
const atomicJsonFile = require('./atomic-json-file');
const { classifyError } = require('./classify-error');
const { decideStaleRemediation } = require('./stale-remediation');
const { pullAll, keysetOrFilter } = require('./keyset');

function emptyData() {
  return { schema: domain.SCHEMA, items: [], arch: [], lastExport: 0 };
}

// Real implementations of the four injectable push/pull functions,
// built from the shared supabase-js client. `argKey` is 'items' or
// 'entries' — the push RPCs' own jsonb parameter name (see
// supabase/migrations/..._push_rpc_functions.sql).
function buildDefaultPushRpc(client, fnName, argKey) {
  return async (rows) => {
    const { data, error } = await client.rpc(fnName, { [argKey]: rows });
    if (error) throw error;
    return data;
  };
}

// The first page of a pull has no prior row to key off, so it's a plain
// `gt(synced_at, sinceIso)`; every later page uses the compound
// (synced_at, id) keyset — see sync/keyset.js's module doc for why a
// bare synced_at cursor alone isn't safe to paginate on.
function buildDefaultPullPage(client, table) {
  return async ({ sinceIso, afterId, limit }) => {
    let q = client.from(table).select('*');
    q = afterId ? q.or(keysetOrFilter(sinceIso, afterId)) : q.gt('synced_at', sinceIso);
    q = q.order('synced_at', { ascending: true }).order('id', { ascending: true }).limit(limit);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  };
}

// Used only by the stale-push remediation path (see remediateStaleItems
// below) to fetch the remote row that beat a rejected push.
function buildDefaultGetItemById(client) {
  return async (id) => {
    const { data, error } = await client.from('items').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  };
}

function replaceItemInData(data, id, nextItem) {
  const replace = (list) => list.map((i) => (i.id === id ? nextItem : i));
  return { ...data, items: replace(data.items || []), arch: replace(data.arch || []) };
}

function findLocalItem(data, id) {
  return [...(data.items || []), ...(data.arch || [])].find((i) => i.id === id);
}

function createSyncEngine(options = {}) {
  const {
    client,
    dataFilePath,
    syncStateFilePath,
    log = defaultLog,
    now = Date.now,
    onStatus = () => {},
    onReload = () => {},
    intervalMs = 60_000,
    saveDebounceMs = 3_000,
    pushBatchSize = 200,
    pullPageSize = 500,
    lookbackMs = 5 * 60_000,
    backoffBaseMs = 2_000,
    backoffMaxMs = 5 * 60_000,
    readJsonFile = atomicJsonFile.readJsonFile,
    // The main data file gets the *strict* reader (throws on a corrupt/
    // unparseable file instead of degrading to "empty") — see
    // sync/atomic-json-file.js's own doc comment on why that file can't
    // tolerate the same "treat as missing" fallback sync-state.json can.
    readDataFile = atomicJsonFile.readJsonFileStrict,
    writeJsonFileAtomic = atomicJsonFile.writeJsonFileAtomic,
  } = options;

  if (!dataFilePath || !syncStateFilePath) {
    throw new Error('createSyncEngine requires dataFilePath and syncStateFilePath');
  }

  // Each defaults to a real supabase-js-backed implementation built
  // from `client` unless a test (or a future caller) injects its own —
  // computed here rather than as destructuring defaults, since those
  // would need to reference `client` from earlier in the same pattern.
  const pushItemsRpc = options.pushItemsRpc || buildDefaultPushRpc(client, 'push_items', 'items');
  const pushLogEntriesRpc =
    options.pushLogEntriesRpc || buildDefaultPushRpc(client, 'push_log_entries', 'entries');
  const pullItemsPage = options.pullItemsPage || buildDefaultPullPage(client, 'items');
  const pullLogEntriesPage =
    options.pullLogEntriesPage || buildDefaultPullPage(client, 'log_entries');
  const getItemById = options.getItemById || (client && buildDefaultGetItemById(client));

  let intervalHandle = null;
  let debounceHandle = null;
  let retryHandle = null;
  let cycleRunning = false;
  let rerunRequested = false;
  let backoffAttempts = 0;
  let currentStatus = null;
  // Bumped by stop() to invalidate any cycle already in flight at that
  // moment (see stop()/runCycle below) — a plain "stopped" boolean isn't
  // enough because triggerNow()/runCycle are also called directly by
  // tests (and by recordLocalSave's debounce) without start() ever
  // having run, and those calls must still work normally.
  let generation = 0;
  // Serializes every read-modify-write of sync-state.json, the same way
  // sync/session-storage.js serializes its own file — recordLocalSave
  // (from data:save) and runCycle (from the timer/focus/debounce) can
  // both want to touch it, and this queue is what stops one clobbering
  // the other's write.
  let stateQueue = Promise.resolve();
  // Serializes every read-modify-write of the main data file itself —
  // recordLocalSave, the two pull-and-merge functions and stale-push
  // remediation all used to do their own unserialized read/merge/write
  // of this file, so two of them interleaving could lose whichever
  // wrote last read the file before the other's write landed (found in
  // review). Every touch of dataFilePath now goes through withDataFile.
  let dataQueue = Promise.resolve();

  function setStatus(next) {
    if (next === currentStatus) return;
    currentStatus = next;
    try {
      onStatus(next);
    } catch (err) {
      log.error('sync status listener threw', { err });
    }
  }

  function notifyReload() {
    try {
      onReload();
    } catch (err) {
      log.error('sync reload listener threw', { err });
    }
  }

  async function getUserId() {
    const { data, error } = await client.auth.getSession();
    if (error) {
      log.warn('sync engine: failed to read current session', { err: error });
      return null;
    }
    return data.session?.user?.id ?? null;
  }

  // `mutator(userState)` may be async; it returns `{ userState, result }`
  // — pass `userState: null` to skip persisting (a pure "peek" read).
  function withUserState(userId, mutator) {
    const run = stateQueue.then(async () => {
      const state = (await readJsonFile(syncStateFilePath)) || syncState.emptyState();
      const userState = syncState.getUserState(state, userId);
      const { userState: nextUserState, result } = await mutator(userState);
      if (nextUserState) {
        const nextState = syncState.setUserState(state, userId, nextUserState);
        await writeJsonFileAtomic(syncStateFilePath, nextState);
      }
      return result;
    });
    stateQueue = run.catch(() => {});
    return run;
  }

  function peekUserState(userId) {
    return withUserState(userId, (userState) => ({ userState: null, result: userState }));
  }

  // `mutator(currentData)` may be async; it returns `{ data, result }` —
  // pass `data: null` to skip writing (a pure "peek" read, e.g. to
  // compute a diff or look up a single item without touching the file).
  // Every read of dataFilePath — not just every write — goes through
  // this queue, so a peek can never observe a half-applied concurrent
  // write, and every write is serialized against every other read-
  // modify-write of the same file.
  function withDataFile(mutator) {
    const run = dataQueue.then(async () => {
      const current = (await readDataFile(dataFilePath)) || emptyData();
      const { data: nextData, result } = await mutator(current);
      if (nextData) await writeJsonFileAtomic(dataFilePath, nextData);
      return { data: nextData, result };
    });
    dataQueue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  function peekDataFile() {
    return withDataFile(async (data) => ({ data: null, result: data }));
  }

  /* ---------- local save (see docs/supabase-sync-plan.md's "the save
     race" note): merges the incoming payload with what's currently on
     disk instead of blindly overwriting it, so a renderer save that was
     queued before a background pull just merged in a remote change
     can't stomp on it — the merge is the Phase 1 domain merge, the same
     "newest updatedAt wins" rule that already reconciles two machines,
     applied here to reconcile "the renderer's view" against "what main
     just wrote". Also does this phase's outbox diffing (never trusts
     the renderer to report what changed, only compares the merged
     result against the last snapshot this engine saw). ---------- */
  async function recordLocalSave(payload) {
    const userId = await getUserId();
    const { data: mergedPayload } = await withDataFile(async (current) => {
      const merged = domain.mergeState(
        { items: current.items || [], arch: current.arch || [] },
        { items: payload.items || [], arch: payload.arch || [] }
      );
      return {
        data: {
          schema: domain.SCHEMA,
          items: merged.items,
          arch: merged.arch,
          lastExport: payload.lastExport ?? current.lastExport ?? 0,
        },
        result: null,
      };
    });

    if (!userId) {
      // Shouldn't happen — main.js only keeps this engine started while
      // signed in — but the merge above (which stops the save race) is
      // unconditional; only the outbox bookkeeping below actually needs
      // a user id, so a transient getSession() failure never falls back
      // to an unmerged overwrite (found in review — this used to skip
      // the merge entirely on this path).
      log.warn('recordLocalSave: no signed-in user — merged to disk but skipped outbox bookkeeping');
      return mergedPayload;
    }

    let diff = null;
    await withUserState(userId, (userState) => {
      const nextSnapshot = outbox.snapshotOf(mergedPayload);
      diff = outbox.diffSnapshot(userState.snapshot, nextSnapshot);
      return {
        userState: {
          ...userState,
          pendingItemIds: outbox.unionIds(userState.pendingItemIds, diff.changedItemIds),
          pendingLogEntryIds: outbox.unionIds(userState.pendingLogEntryIds, diff.newLogEntryIds),
          snapshot: nextSnapshot,
        },
        result: null,
      };
    });

    if (diff.changedItemIds.length || diff.newLogEntryIds.length) {
      setStatus('pending');
      clearTimeout(debounceHandle);
      debounceHandle = setTimeout(() => triggerNow(), saveDebounceMs);
    }

    return mergedPayload;
  }

  /* ---------- outbox diffing at the start of every cycle: never trusts
     recordLocalSave to be the only way an id ends up needing a push.
     Comparing the data file against the persisted snapshot on every
     cycle (not just on a data:save) is what catches an edit that never
     went through recordLocalSave at all — a plain atomicWrite made
     while signed out or before the session was restored, or (this is
     the same mechanism) an item this engine has simply never seen
     before. An empty snapshot marks every existing item/log entry
     pending, which is exactly first sync (Phase 5) — so this single
     function is also all "first sync" needs to be: bootstrapping is
     just "the snapshot started empty", not a separate code path.
     firstSyncDone is kept only as an observability flag (logged once)
     — nothing downstream branches on it any more. ---------- */
  async function diffLocalChangesIntoOutbox(userId, cycleId) {
    const { data } = await peekDataFile();
    await withUserState(userId, (userState) => {
      const nextSnapshot = outbox.snapshotOf(data);
      const diff = outbox.diffSnapshot(userState.snapshot, nextSnapshot);
      if (!userState.firstSyncDone) {
        log.info('first sync: marking all local data pending', {
          cycleId,
          userId,
          items: diff.changedItemIds.length,
          logEntries: diff.newLogEntryIds.length,
        });
      } else if (diff.changedItemIds.length || diff.newLogEntryIds.length) {
        log.debug('cycle start: outbox diff found local changes not seen via recordLocalSave', {
          cycleId,
          userId,
          items: diff.changedItemIds.length,
          logEntries: diff.newLogEntryIds.length,
        });
      }
      return {
        userState: {
          ...userState,
          pendingItemIds: outbox.unionIds(userState.pendingItemIds, diff.changedItemIds),
          pendingLogEntryIds: outbox.unionIds(userState.pendingLogEntryIds, diff.newLogEntryIds),
          snapshot: nextSnapshot,
          firstSyncDone: true,
        },
        result: null,
      };
    });
  }

  /* ---------- push ---------- */

  async function pushPendingItems(userId, cycleId, counts) {
    const { data } = await peekDataFile();
    const { itemsById } = outbox.indexData(data);
    const userState = await peekUserState(userId);
    const toPush = [];
    const missingIds = [];
    userState.pendingItemIds.forEach((id) => {
      const item = itemsById.get(id);
      if (item) toPush.push(item);
      else missingIds.push(id);
    });

    // Remember the updatedAt actually pushed for each id — see the
    // withUserState call below for why this is what stops a
    // recordLocalSave that writes a newer version of this same item
    // mid-push from having its edit silently dropped from the outbox.
    const pushedUpdatedAtById = new Map(toPush.map((it) => [it.id, it.updatedAt]));
    const acceptedIds = new Set();
    const staleIds = [];
    for (const batch of outbox.chunk(toPush, pushBatchSize)) {
      const rows = batch.map(mapping.itemToPushRow);
      const results = await pushItemsRpc(rows);
      counts.pushedItems += rows.length;
      results.forEach((r) => {
        if (r.accepted) {
          acceptedIds.add(r.row_id);
          counts.pushedItemsAccepted += 1;
        } else if (r.reason === 'stale_or_not_owned') {
          staleIds.push(r.row_id);
        } else {
          log.warn('push_items row rejected', { cycleId, id: r.row_id, reason: r.reason });
        }
      });
    }

    await withUserState(userId, (us) => {
      // Only clear an id whose outbox snapshot still matches what was
      // actually pushed. If recordLocalSave wrote a newer version of
      // this same item while the RPC above was in flight, its own
      // withUserState call already re-added the id (or left it) with a
      // *new* snapshot entry — clearing it here regardless would drop
      // that newer edit from the outbox forever, since the file on
      // disk (and the snapshot) already reflect it and nothing else
      // would ever flag it as changed again. `missingIds` never had a
      // pushedUpdatedAt recorded at all, so they're always safe to
      // clear (there was nothing to push in the first place).
      const stillMatchesWhatWasPushed = (id) => {
        const pushedAt = pushedUpdatedAtById.get(id);
        return pushedAt === undefined || us.snapshot.items[id] === pushedAt;
      };
      const toRemove = [...acceptedIds, ...missingIds].filter(stillMatchesWhatWasPushed);
      return {
        userState: { ...us, pendingItemIds: outbox.removeIds(us.pendingItemIds, toRemove) },
        result: null,
      };
    });

    if (staleIds.length) await remediateStaleItems(userId, staleIds, cycleId);
  }

  // Known gap in push_items (see supabase/migrations/..._push_rpc_functions.sql
  // and docs/supabase-sync-plan.md's Phase 2 notes): the RPC's "newest
  // wins" only compares updated_at, but the client's own mergeItem
  // breaks an exact tie with a further chain the RPC can't reproduce in
  // SQL. `decideStaleRemediation` (sync/stale-remediation.js) is the
  // full decision: resolve (drop from the outbox, no re-push) whenever
  // the remote copy wins outright *or* the two are the same content
  // already (an already-accepted push being retried, or two machines'
  // first sync overlapping on identical data — re-stamping either of
  // those would spread a content-free updatedAt bump to every machine,
  // forever); re-stamp only on the rare exact-updated_at tie where the
  // content genuinely differs and mergeItem still prefers local.
  async function remediateStaleItems(userId, staleIds, cycleId) {
    if (!getItemById) return;
    const resolvedIds = [];
    // The local updatedAt each id was actually compared against, read
    // fresh from disk inside withDataFile below (never the pre-push
    // snapshot from pushPendingItems, which can be stale by the time
    // remediation runs) — used the same way pushPendingItems uses
    // pushedUpdatedAtById, to avoid dropping a concurrent newer local
    // edit from the outbox out from under it.
    const comparedUpdatedAtById = new Map();
    let didReStamp = false;

    for (const id of staleIds) {
      let remoteRow;
      try {
        remoteRow = await getItemById(id);
      } catch (err) {
        log.warn('stale-push remediation: failed to fetch remote row', { cycleId, id, err });
        continue; // leave pending — retried next cycle
      }
      // No row (not owned by this user, or genuinely gone) — nothing to
      // reconcile against; leave pending rather than guess. (Turning
      // this into a terminal, non-retried rejection is a further
      // improvement tracked separately, not done here.)
      if (!remoteRow) continue;
      const remoteItem = mapping.rowToItem(remoteRow);

      await withDataFile(async (current) => {
        const local = findLocalItem(current, id);
        if (!local) {
          // The local item vanished between the push and now — nothing
          // left to reconcile or re-push.
          resolvedIds.push(id);
          return { data: null, result: null };
        }
        comparedUpdatedAtById.set(id, local.updatedAt);

        const decision = decideStaleRemediation(domain.mergeItem, local, remoteItem);
        if (decision === 'resolve') {
          resolvedIds.push(id);
          return { data: null, result: null };
        }

        const bumpedUpdatedAt = Math.max(remoteItem.updatedAt || 0, local.updatedAt || 0) + 1;
        log.warn('re-stamped a locally-preferred item after a stale push rejection', {
          cycleId,
          id,
          updatedAt: bumpedUpdatedAt,
        });
        didReStamp = true;
        return {
          data: replaceItemInData(current, id, { ...local, updatedAt: bumpedUpdatedAt }),
          result: null,
        };
      });
    }

    // A re-stamp changes the data file, so the renderer's Store (which
    // is not the source of truth) needs to reload — the original
    // remediation path never did this at all.
    if (didReStamp) notifyReload();

    if (resolvedIds.length) {
      await withUserState(userId, (us) => {
        const toRemove = resolvedIds.filter(
          (id) => us.snapshot.items[id] === comparedUpdatedAtById.get(id)
        );
        return {
          userState: { ...us, pendingItemIds: outbox.removeIds(us.pendingItemIds, toRemove) },
          result: null,
        };
      });
    }
  }

  async function pushPendingLogEntries(userId, cycleId, counts) {
    const { data } = await peekDataFile();
    const { logEntriesById } = outbox.indexData(data);
    const userState = await peekUserState(userId);
    const toPush = [];
    const missingIds = [];
    userState.pendingLogEntryIds.forEach((id) => {
      const entry = logEntriesById.get(id);
      if (entry) toPush.push(entry);
      else missingIds.push(id);
    });

    const resolvedIds = new Set(missingIds);
    for (const batch of outbox.chunk(toPush, pushBatchSize)) {
      const rows = batch.map(({ itemId, entry }) => mapping.logEntryToPushRow(itemId, entry));
      const results = await pushLogEntriesRpc(rows);
      counts.pushedLogEntries += rows.length;
      results.forEach((r) => {
        if (r.accepted) {
          resolvedIds.add(r.row_id);
          counts.pushedLogEntriesAccepted += 1;
        } else if (r.reason === 'duplicate') {
          // Already there under this id — nothing left to retry.
          resolvedIds.add(r.row_id);
        } else {
          // 'item_not_found': its item hasn't pushed yet (or this batch
          // simply raced ahead of it) — leave pending, retried once the
          // item itself has synced.
          log.debug('push_log_entries row pending retry', {
            cycleId,
            id: r.row_id,
            reason: r.reason,
          });
        }
      });
    }

    await withUserState(userId, (us) => ({
      userState: {
        ...us,
        pendingLogEntryIds: outbox.removeIds(us.pendingLogEntryIds, [...resolvedIds]),
      },
      result: null,
    }));
  }

  /* ---------- pull ---------- */

  // Items are pulled and merged in fully before log entries are even
  // requested (mirroring the push order) — see pullLogEntriesAndMerge's
  // orphan-item comment for why that ordering is what makes "the
  // parent item is already on disk by the time we process its log
  // entries" a guarantee rather than a race.
  async function pullItemsAndMerge(userId, cycleId, counts) {
    const userState = await peekUserState(userId);
    const { rows, cursor } = await pullAll({
      pageFn: pullItemsPage,
      cursorMs: userState.itemsCursor,
      lookbackMs,
      pageSize: pullPageSize,
      isoToMs: mapping.isoToMs,
      msToIso: mapping.msToIso,
    });
    counts.pulledItems = rows.length;
    let mergedPayload = null;

    if (rows.length) {
      const pulledItems = rows.map(mapping.rowToItem);
      ({ data: mergedPayload } = await withDataFile(async (current) => {
        const merged = domain.mergeState(
          { items: current.items || [], arch: current.arch || [] },
          { items: pulledItems, arch: [] }
        );
        return {
          data: {
            schema: domain.SCHEMA,
            items: merged.items,
            arch: merged.arch,
            lastExport: current.lastExport || 0,
          },
          result: null,
        };
      }));
      notifyReload();
    }

    // Persisted only after the merge above has actually been written —
    // a crash in between just re-pulls the same (idempotent) rows next
    // cycle rather than losing them. The snapshot is refreshed here too
    // (not just the cursor): without this, an item that only ever
    // arrives via pull (nobody edits it on this machine) would never
    // get a snapshot entry, and every future cycle-start diff would
    // keep mistaking "this engine has never *seen* this update" for
    // "this machine changed it", re-queuing it for push forever
    // (harmless — push_items just rejects it as stale_or_not_owned —
    // but noisy).
    if (cursor != null || mergedPayload) {
      await withUserState(userId, (us) => ({
        userState: {
          ...us,
          ...(cursor != null ? { itemsCursor: cursor } : {}),
          ...(mergedPayload ? { snapshot: outbox.snapshotOf(mergedPayload) } : {}),
        },
        result: null,
      }));
    }
  }

  async function pullLogEntriesAndMerge(userId, cycleId, counts) {
    const userState = await peekUserState(userId);
    const { rows, cursor } = await pullAll({
      pageFn: pullLogEntriesPage,
      cursorMs: userState.logEntriesCursor,
      lookbackMs,
      pageSize: pullPageSize,
      isoToMs: mapping.isoToMs,
      msToIso: mapping.msToIso,
    });
    counts.pulledLogEntries = rows.length;

    if (!rows.length) {
      if (cursor != null) {
        await withUserState(userId, (us) => ({
          userState: { ...us, logEntriesCursor: cursor },
          result: null,
        }));
      }
      return;
    }

    const byItem = new Map();
    rows.forEach((row) => {
      const list = byItem.get(row.item_id) || [];
      list.push(row);
      byItem.set(row.item_id, list);
    });

    let mergedPayload = null;
    let orphanItemIds = [];
    ({ data: mergedPayload } = await withDataFile(async (current) => {
      const { itemsById } = outbox.indexData(current);
      const synthetic = [];
      orphanItemIds = [];
      for (const [itemId, entryRows] of byItem) {
        const found = itemsById.get(itemId);
        if (found) synthetic.push({ ...found, log: entryRows.map(mapping.rowToLogEntry) });
        else orphanItemIds.push(itemId);
      }

      if (orphanItemIds.length) {
        // Should be unreachable: log_entries.item_id is a composite FK
        // on items(id, user_id), so a log entry can only exist once its
        // item does, and items are always pulled+merged before log
        // entries (above). Logged loudly and the cursor is *not*
        // advanced, so a future cycle gets another chance instead of
        // the entries being silently lost.
        log.error('pulled log entries reference items not found locally — cursor not advanced', {
          cycleId,
          orphanItemIds,
        });
      }

      if (!synthetic.length) return { data: null, result: null };
      const merged = domain.mergeState(
        { items: current.items || [], arch: current.arch || [] },
        { items: synthetic, arch: [] }
      );
      return {
        data: {
          schema: domain.SCHEMA,
          items: merged.items,
          arch: merged.arch,
          lastExport: current.lastExport || 0,
        },
        result: null,
      };
    }));

    if (mergedPayload) notifyReload();

    if (!orphanItemIds.length && (cursor != null || mergedPayload)) {
      await withUserState(userId, (us) => ({
        userState: {
          ...us,
          ...(cursor != null ? { logEntriesCursor: cursor } : {}),
          ...(mergedPayload ? { snapshot: outbox.snapshotOf(mergedPayload) } : {}),
        },
        result: null,
      }));
    }
  }

  /* ---------- cycle orchestration ---------- */

  function scheduleRetry() {
    const delay = Math.min(backoffMaxMs, backoffBaseMs * 2 ** backoffAttempts);
    backoffAttempts += 1;
    clearTimeout(retryHandle);
    retryHandle = setTimeout(() => triggerNow(), delay);
  }

  async function runCycle() {
    // Captured once, at the top: stop() bumps `generation`, and every
    // check below against `myGeneration` is what stops a cycle that was
    // already in flight when stop() ran from doing anything more once
    // it resumes — no more setStatus (which would make the header's
    // sync indicator reappear right after main.js explicitly hides it
    // on sign-out), no more scheduleRetry (which would leave a timer
    // armed after stop() specifically cleared it), no rerun. A plain
    // "is the engine running" boolean can't do this: triggerNow()/
    // runCycle are also called directly (by tests, and by
    // recordLocalSave's own debounce) without start() ever having run,
    // and those calls must keep working normally.
    const myGeneration = generation;
    const stillCurrent = () => generation === myGeneration;

    const cycleId = crypto.randomUUID();
    const startedAt = now();
    const userId = await getUserId();
    if (!stillCurrent()) return;
    if (!userId) {
      log.debug('sync cycle skipped — no signed-in user', { cycleId });
      return;
    }
    const counts = {
      pushedItems: 0,
      pushedItemsAccepted: 0,
      pushedLogEntries: 0,
      pushedLogEntriesAccepted: 0,
      pulledItems: 0,
      pulledLogEntries: 0,
    };
    try {
      await diffLocalChangesIntoOutbox(userId, cycleId);
      if (!stillCurrent()) return;
      await pushPendingItems(userId, cycleId, counts);
      if (!stillCurrent()) return;
      await pushPendingLogEntries(userId, cycleId, counts);
      if (!stillCurrent()) return;
      await pullItemsAndMerge(userId, cycleId, counts);
      if (!stillCurrent()) return;
      await pullLogEntriesAndMerge(userId, cycleId, counts);
      if (!stillCurrent()) return;

      const finalState = await peekUserState(userId);
      if (!stillCurrent()) return;
      const clean =
        finalState.pendingItemIds.length === 0 && finalState.pendingLogEntryIds.length === 0;
      backoffAttempts = 0;
      clearTimeout(retryHandle);
      retryHandle = null;
      setStatus(clean ? 'synced' : 'pending');
      log.info('sync cycle complete', {
        cycleId,
        durationMs: now() - startedAt,
        status: clean ? 'synced' : 'pending',
        ...counts,
      });
    } catch (err) {
      if (!stillCurrent()) {
        log.debug('sync cycle failed after stop() — not reporting status or scheduling a retry', {
          cycleId,
          err,
        });
        return;
      }
      const classification = classifyError(err);
      setStatus(classification);
      log.error('sync cycle failed', {
        cycleId,
        durationMs: now() - startedAt,
        err,
        status: classification,
        ...counts,
      });
      scheduleRetry();
    }
  }

  // Coalesces overlapping triggers (startup, focus, the periodic timer,
  // the post-save debounce) into at most one cycle running at a time,
  // re-running once more immediately after if another trigger fired
  // while it was busy — never queuing an unbounded backlog of cycles.
  async function triggerNow() {
    const myGeneration = generation;
    if (cycleRunning) {
      rerunRequested = true;
      return;
    }
    cycleRunning = true;
    try {
      do {
        rerunRequested = false;
        await runCycle();
      } while (rerunRequested && generation === myGeneration);
    } finally {
      cycleRunning = false;
    }
  }

  function start() {
    if (intervalHandle) return;
    intervalHandle = setInterval(() => {
      // Exponential backoff is otherwise close to pointless: without
      // this, the 60s interval keeps firing a fresh cycle throughout an
      // outage regardless of how long runCycle's own backoff decided to
      // wait, so the backoff cap never actually takes effect while the
      // interval is shorter than it (found in review). Explicit
      // triggers (focus, debounce, a direct triggerNow() call) are
      // deliberately not gated the same way — those are "something
      // happened, try now", not "is it time yet".
      if (backoffAttempts > 0) return;
      triggerNow().catch((err) => log.error('sync interval trigger failed', { err }));
    }, intervalMs);
    triggerNow().catch((err) => log.error('sync startup trigger failed', { err }));
  }

  function stop() {
    generation += 1; // invalidate any cycle already in flight — see runCycle
    clearInterval(intervalHandle);
    clearTimeout(debounceHandle);
    clearTimeout(retryHandle);
    intervalHandle = null;
    debounceHandle = null;
    retryHandle = null;
    backoffAttempts = 0;
    currentStatus = null;
  }

  function getStatus() {
    return currentStatus;
  }

  return { start, stop, triggerNow, recordLocalSave, getStatus };
}

module.exports = { createSyncEngine };
