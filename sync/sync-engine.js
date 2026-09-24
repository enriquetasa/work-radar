'use strict';

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

function buildDefaultPushRpc(client, fnName, argKey) {
  return async (rows) => {
    const { data, error } = await client.rpc(fnName, { [argKey]: rows });
    if (error) throw error;
    return data;
  };
}

// Paginate on (synced_at, id) so equal timestamps cannot skip rows.
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

function mergeIntoData(current, incoming, lastExport) {
  const merged = domain.mergeState(
    { items: current.items || [], arch: current.arch || [] },
    incoming
  );
  return {
    schema: domain.SCHEMA,
    items: merged.items,
    arch: merged.arch,
    lastExport,
  };
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
    readDataFile = atomicJsonFile.readJsonFileStrict,
    writeJsonFileAtomic = atomicJsonFile.writeJsonFileAtomic,
  } = options;

  if (!dataFilePath || !syncStateFilePath) {
    throw new Error('createSyncEngine requires dataFilePath and syncStateFilePath');
  }

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
  // Invalidates work that was already in flight when stop() ran.
  let generation = 0;
  // Serialize read-modify-write operations for each persisted file.
  let stateQueue = Promise.resolve();
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
    if (error) return { userId: null, error };
    return { userId: data.session?.user?.id ?? null, error: null };
  }

  // Mutators return { userState, result }; null userState skips the write.
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

  // Mutators return { data, result }; null data skips the write.
  function withDataFile(mutator) {
    const run = dataQueue.then(async () => {
      const raw = (await readDataFile(dataFilePath, { log })) || emptyData();
      // Files from schema 2 need deterministic log ids before merging.
      const deduped = domain.mergeState(
        { items: domain.migrate(raw.items || []), arch: domain.migrate(raw.arch || []) },
        { items: [], arch: [] }
      );
      const current = {
        schema: domain.SCHEMA,
        items: deduped.items,
        arch: deduped.arch,
        lastExport: raw.lastExport || 0,
      };
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

  async function peekDataFile() {
    const { result } = await withDataFile(async (data) => ({ data: null, result: data }));
    return result;
  }

  async function recordLocalSave(payload) {
    // stop() changes the generation, suppressing status and retry side effects.
    const myGeneration = generation;

    // Persist locally before auth/session work so offline saves never wait on the network.
    const { data: mergedPayload, result: diff } = await withDataFile(async (current) => {
      const nextData = mergeIntoData(
        current,
        { items: payload.items || [], arch: payload.arch || [] },
        payload.lastExport ?? current.lastExport ?? 0
      );
      return {
        data: nextData,
        result: outbox.diffSnapshot(outbox.snapshotOf(current), outbox.snapshotOf(nextData)),
      };
    });

    try {
      const { userId, error: sessionError } = await getUserId();
      if (!userId) {
        if (sessionError) {
          if (
            generation === myGeneration &&
            currentStatus !== 'offline' &&
            currentStatus !== 'error'
          ) {
            setStatus('pending');
          }
        } else {
          log.debug(
            'recordLocalSave: no signed-in user — merged to disk but skipped outbox bookkeeping'
          );
        }
        return mergedPayload;
      }

      // Patch only this save's ids; a concurrent pull may have updated the rest.
      await withUserState(userId, (userState) => {
        const nextSnapshot = outbox.patchSnapshot(
          userState.snapshot,
          mergedPayload,
          diff.changedItemIds,
          diff.newLogEntryIds
        );
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

      if (
        (diff.changedItemIds.length || diff.newLogEntryIds.length) &&
        generation === myGeneration
      ) {
        if (currentStatus !== 'offline' && currentStatus !== 'error') setStatus('pending');
        clearTimeout(debounceHandle);
        debounceHandle = setTimeout(() => {
          triggerNow().catch((err) => log.error('sync debounce trigger failed', { err }));
        }, saveDebounceMs);
      }
    } catch (err) {
      log.error('recordLocalSave: outbox bookkeeping failed after the data write succeeded', {
        err,
      });
    }

    return mergedPayload;
  }

  // This also catches writes made before sign-in or outside recordLocalSave.
  async function diffLocalChangesIntoOutbox(userId, cycleId) {
    const data = await peekDataFile();
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

  async function pushPendingItems(userId, cycleId, counts) {
    const data = await peekDataFile();
    const { itemsById } = outbox.indexData(data);
    const userState = await peekUserState(userId);
    const toPush = [];
    const missingIds = [];
    userState.pendingItemIds.forEach((id) => {
      const item = itemsById.get(id);
      if (item) toPush.push(item);
      else missingIds.push(id);
    });

    // Do not clear an id if a newer edit landed while its RPC was in flight.
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

  // Resolve harmless retries; re-stamp only exact-timestamp content conflicts.
  async function remediateStaleItems(userId, staleIds, cycleId) {
    if (!getItemById) return;
    const resolvedIds = [];
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
      if (!remoteRow) {
        log.warn('stale-push remediation: no reconcilable remote row for a stale_or_not_owned id', {
          cycleId,
          id,
        });
        continue;
      }
      const remoteItem = mapping.rowToItem(remoteRow);

      await withDataFile(async (current) => {
        const local = findLocalItem(current, id);
        if (!local) {
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
    const data = await peekDataFile();
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
          resolvedIds.add(r.row_id);
        } else if (r.reason === 'item_not_found') {
          log.debug('push_log_entries row pending retry', {
            cycleId,
            id: r.row_id,
            reason: r.reason,
          });
        } else {
          log.warn('push_log_entries row rejected', {
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
    let changedItemIds = [];

    if (rows.length) {
      const pulledItems = rows.map(mapping.rowToItem);
      ({ data: mergedPayload, result: changedItemIds } = await withDataFile(async (current) => {
        const nextData = mergeIntoData(
          current,
          { items: pulledItems, arch: [] },
          current.lastExport || 0
        );
        // Lookback pulls commonly return rows that are already merged.
        const changed = outbox.diffSnapshot(
          outbox.snapshotOf(current),
          outbox.snapshotOf(nextData)
        );
        if (!changed.changedItemIds.length && !changed.newLogEntryIds.length) {
          return { data: null, result: [] };
        }
        return { data: nextData, result: changed.changedItemIds };
      }));
      if (mergedPayload) notifyReload();
    }

    // Advance the cursor only after the corresponding data write completes.
    if (cursor != null || mergedPayload) {
      await withUserState(userId, (us) => ({
        userState: {
          ...us,
          ...(cursor != null ? { itemsCursor: cursor } : {}),
          ...(mergedPayload
            ? { snapshot: outbox.patchSnapshot(us.snapshot, mergedPayload, changedItemIds, []) }
            : {}),
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
    let notYetLocalItemIds = [];
    let changedLogEntryIds = [];
    ({ data: mergedPayload, result: changedLogEntryIds } = await withDataFile(async (current) => {
      const { itemsById } = outbox.indexData(current);
      const synthetic = [];
      notYetLocalItemIds = [];
      for (const [itemId, entryRows] of byItem) {
        const found = itemsById.get(itemId);
        const maxEntryTs = entryRows.reduce((m, r) => Math.max(m, mapping.isoToMs(r.ts) || 0), 0);
        // Item and log pulls are separate; defer entries until their parent is current.
        if (!found) {
          notYetLocalItemIds.push(itemId);
        } else if ((found.updatedAt || 0) < maxEntryTs) {
          notYetLocalItemIds.push(itemId);
        } else {
          synthetic.push({ ...found, log: entryRows.map(mapping.rowToLogEntry) });
        }
      }

      if (notYetLocalItemIds.length) {
        log.warn('pulled log entries arrived before their item — retrying next cycle', {
          cycleId,
          itemIds: notYetLocalItemIds,
        });
      }

      if (!synthetic.length) return { data: null, result: [] };
      const nextData = mergeIntoData(
        current,
        { items: synthetic, arch: [] },
        current.lastExport || 0
      );
      const changed = outbox.diffSnapshot(outbox.snapshotOf(current), outbox.snapshotOf(nextData));
      if (!changed.changedItemIds.length && !changed.newLogEntryIds.length) {
        return { data: null, result: [] };
      }
      return { data: nextData, result: changed.newLogEntryIds };
    }));

    if (mergedPayload) notifyReload();

    if (!notYetLocalItemIds.length && (cursor != null || mergedPayload)) {
      await withUserState(userId, (us) => ({
        userState: {
          ...us,
          ...(cursor != null ? { logEntriesCursor: cursor } : {}),
          ...(mergedPayload
            ? { snapshot: outbox.patchSnapshot(us.snapshot, mergedPayload, [], changedLogEntryIds) }
            : {}),
        },
        result: null,
      }));
    }
  }

  function scheduleRetry() {
    const delay = Math.min(backoffMaxMs, backoffBaseMs * 2 ** backoffAttempts);
    backoffAttempts += 1;
    clearTimeout(retryHandle);
    retryHandle = setTimeout(() => {
      triggerNow().catch((err) => log.error('sync retry trigger failed', { err }));
    }, delay);
  }

  async function runCycle() {
    const myGeneration = generation;
    const stillCurrent = () => generation === myGeneration;

    const cycleId = crypto.randomUUID();
    const startedAt = now();
    const { userId, error: sessionError } = await getUserId();
    if (!stillCurrent()) return;
    if (sessionError) {
      const classification = classifyError(sessionError);
      setStatus(classification);
      log.error('sync cycle failed to read current session', {
        cycleId,
        err: sessionError,
        status: classification,
      });
      scheduleRetry();
      return;
    }
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

  // Coalesce concurrent triggers into one active cycle and at most one rerun.
  async function triggerNow() {
    if (cycleRunning) {
      rerunRequested = true;
      return;
    }
    cycleRunning = true;
    try {
      do {
        rerunRequested = false;
        await runCycle();
      } while (rerunRequested);
    } finally {
      cycleRunning = false;
    }
  }

  function start() {
    if (intervalHandle) return;
    intervalHandle = setInterval(() => {
      // Retry timers own the cadence while backoff is active.
      if (backoffAttempts > 0) return;
      triggerNow().catch((err) => log.error('sync interval trigger failed', { err }));
    }, intervalMs);
    triggerNow().catch((err) => log.error('sync startup trigger failed', { err }));
  }

  function stop() {
    generation += 1; // invalidate any cycle already in flight — see runCycle
    rerunRequested = false; // don't let a stale rerun request from before this stop() fire on its own
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
