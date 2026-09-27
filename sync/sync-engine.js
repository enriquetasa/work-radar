'use strict';

const crypto = require('crypto');
const domain = require('../renderer/domain.js');
const defaultLog = require('../logger');
const mapping = require('./mapping');
const outbox = require('./outbox');
const history = require('./history');
const syncState = require('./sync-state');
const atomicJsonFile = require('./atomic-json-file');
const { classifyError } = require('./classify-error');
const { decideStaleRemediation } = require('./stale-remediation');
const { pullAll, keysetOrFilter } = require('./keyset');

function emptyData() {
  return { schema: domain.SCHEMA, items: [], arch: [], lastExport: 0, itemRevisions: [] };
}

function buildDefaultPushRpc(client, fnName, argKey) {
  let scheduleSchemaChecked = false;
  return async (rows) => {
    // Older push_items RPCs accept unknown JSON keys but silently discard
    // them. Verify the schedule migration before acknowledging any writes.
    // Cache success only, so a deployment fixes a failed check on retry.
    if (fnName === 'push_items' && !scheduleSchemaChecked) {
      const { error } = await client
        .from('items')
        .select('review_interval_days, next_review_on, waiting_on, checkpoint, checkpoint_on')
        .limit(0);
      if (error) {
        if (error.code === '42703' || error.code === 'PGRST204') {
          throw new Error('Cloud sync requires the project review schedule database migration.', {
            cause: error,
          });
        }
        throw error;
      }
      scheduleSchemaChecked = true;
    }
    const { data, error } = await client.rpc(fnName, { [argKey]: rows });
    if (error) throw error;
    return data;
  };
}

// Paginate on (synced_at, id) so equal timestamps cannot skip rows.
function buildDefaultPullPage(client, table, cursorField = 'synced_at') {
  return async ({ sinceIso, afterId, limit }) => {
    let q = client.from(table).select('*');
    q = afterId
      ? q.or(keysetOrFilter(sinceIso, afterId, cursorField))
      : q.gt(cursorField, sinceIso);
    q = q.order(cursorField, { ascending: true }).order('id', { ascending: true }).limit(limit);
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
  let next = {
    ...current,
    schema: domain.SCHEMA,
    items: merged.items,
    arch: merged.arch,
    lastExport,
  };
  if (incoming && Array.isArray(incoming.itemRevisions)) next = history.merge(next, incoming);
  next = history.baselineData(next);
  return { ...next, itemRevisions: history.retain(next.itemRevisions || []) };
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
  let pushItemRevisionsRpc =
    options.pushItemRevisionsRpc ||
    (client && typeof client.rpc === 'function'
      ? buildDefaultPushRpc(client, 'push_item_revisions', 'revisions')
      : null);
  const pullItemsPage = options.pullItemsPage || buildDefaultPullPage(client, 'items');
  const pullLogEntriesPage =
    options.pullLogEntriesPage || buildDefaultPullPage(client, 'log_entries');
  let pullItemRevisionsPage =
    options.pullItemRevisionsPage ||
    (client && typeof client.from === 'function'
      ? buildDefaultPullPage(client, 'item_revisions', 'server_received_at')
      : null);
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
  function withDataFile(mutator, guard = () => true) {
    const run = dataQueue.then(async () => {
      if (!guard()) return { data: null, result: null };
      // Capture the active profile path for the whole serialized operation; an account switch can change the resolver while an old write is in flight.
      const filePath = dataFilePath;
      const raw = (await readDataFile(filePath, { log })) || emptyData();
      if (Number.isSafeInteger(raw.schema) && raw.schema > domain.SCHEMA) {
        const error = new Error('Unsupported newer Work Radar data schema: ' + raw.schema);
        error.code = 'UNSUPPORTED_DATA_SCHEMA';
        throw error;
      }
      // Do not let a sign-out/account switch merge into the shared profile file
      // after an awaited read. The guard is checked again immediately before
      // the atomic write below.
      if (!guard()) return { data: null, result: null };
      // Files from schema 2 need deterministic log ids before merging.
      const deduped = domain.mergeState(
        { items: domain.migrate(raw.items || []), arch: domain.migrate(raw.arch || []) },
        { items: [], arch: [] }
      );
      const current = {
        ...raw,
        schema: domain.SCHEMA,
        items: deduped.items,
        arch: deduped.arch,
        lastExport: raw.lastExport || 0,
        itemRevisions: Array.isArray(raw.itemRevisions) ? raw.itemRevisions : [],
      };
      const { data: nextData, result } = await mutator(current);
      if (!guard()) return { data: null, result: null };
      if (nextData) await writeJsonFileAtomic(filePath, nextData);
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
    const { data: mergedPayload, result: diff } = await withDataFile(
      async (current) => {
        current = history.baselineData(current);
        let nextData = mergeIntoData(
          current,
          {
            items: payload.items || [],
            arch: payload.arch || [],
            ...(Array.isArray(payload.itemRevisions)
              ? { itemRevisions: payload.itemRevisions }
              : {}),
          },
          payload.lastExport ?? current.lastExport ?? 0
        );
        const diff = outbox.diffSnapshot(outbox.snapshotOf(current), outbox.snapshotOf(nextData));
        const changedItems = diff.changedItemIds
          .map((id) => findLocalItem(nextData, id))
          .filter(Boolean);
        const beforeRevisionIds = new Set((current.itemRevisions || []).map((r) => r.id));
        if (changedItems.length) {
          const previousById = new Map(
            [...(current.items || []), ...(current.arch || [])].map((item) => [item.id, item])
          );
          nextData = history.append(nextData, changedItems, {
            action: payload.historyAction || 'edit',
            sourceDevice: payload.sourceDevice,
            origin: 'local',
            restoredFromRevisionId: payload.restoredFromRevisionId,
            previousById,
          });
        }
        return {
          data: nextData,
          result: {
            ...diff,
            revisionIds: nextData.itemRevisions
              .filter((revision) => !beforeRevisionIds.has(revision.id))
              .map((revision) => revision.id),
          },
        };
      },
      () => generation === myGeneration
    );
    if (!diff) return mergedPayload;

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
            ...(pushItemRevisionsRpc && diff.revisionIds
              ? {
                  pendingRevisionIds: outbox.unionIds(
                    userState.pendingRevisionIds,
                    diff.revisionIds
                  ),
                }
              : {}),
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
      const revisionIds = (data.itemRevisions || []).map((revision) => revision.id);
      const knownRevisionIds = new Set(userState.revisionIds || []);
      const newRevisionIds = revisionIds.filter((id) => !knownRevisionIds.has(id));
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
          ...(pushItemRevisionsRpc
            ? {
                pendingRevisionIds: outbox.unionIds(userState.pendingRevisionIds, newRevisionIds),
                revisionIds: outbox.unionIds(userState.revisionIds, revisionIds),
              }
            : {}),
          snapshot: nextSnapshot,
          firstSyncDone: true,
        },
        result: null,
      };
    });
  }

  async function pushPendingItems(userId, cycleId, counts, guard = () => true) {
    // Seed a deterministic baseline in memory before the first item push so
    // the server trigger can use its ID as the canonical revision. The actual
    // envelope write happens after the item RPC succeeds.
    const data = history.baselineData(await peekDataFile());
    const { itemsById } = outbox.indexData(data);
    const latestRevisionByItem = new Map();
    for (const revision of data.itemRevisions || []) {
      const previous = latestRevisionByItem.get(revision.itemId);
      if (!previous || (revision.clientTime || 0) > (previous.clientTime || 0)) {
        latestRevisionByItem.set(revision.itemId, revision);
      }
    }
    const userState = await peekUserState(userId);
    const toPush = [];
    const missingIds = [];
    userState.pendingItemIds.forEach((id) => {
      const item = itemsById.get(id);
      if (item) {
        const revision = latestRevisionByItem.get(id);
        toPush.push({ item, revision });
      } else missingIds.push(id);
    });

    // Do not clear an id if a newer edit landed while its RPC was in flight.
    const pushedUpdatedAtById = new Map(toPush.map(({ item }) => [item.id, item.updatedAt]));
    const acceptedIds = new Set();
    const staleIds = [];
    for (const batch of outbox.chunk(toPush, pushBatchSize)) {
      const rows = batch.map(({ item, revision }) => ({
        ...mapping.itemToPushRow(item),
        ...(revision
          ? {
              revisionId: revision.id,
              revisionAction: revision.action || 'edit',
              revisionSourceDevice: revision.sourceDevice || null,
              revisionRestoredFrom: revision.restoredFromRevisionId || null,
              revisionClientTime: mapping.msToIso(revision.clientTime),
            }
          : {}),
      }));
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

    if (staleIds.length) await remediateStaleItems(userId, staleIds, cycleId, guard);
  }

  // Resolve harmless retries; re-stamp only exact-timestamp content conflicts.
  async function remediateStaleItems(userId, staleIds, cycleId, guard = () => true) {
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

      const mergeResult = await withDataFile(async (current) => {
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
      }, guard);
      if (!mergeResult.data && !guard()) return;
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

  async function ensureHistoryBaselines(guard = () => true) {
    const data = await peekDataFile();
    const seeded = history.baselineData(data);
    if ((seeded.itemRevisions || []).length === (data.itemRevisions || []).length) return;
    await withDataFile(async () => ({ data: seeded, result: null }), guard);
  }

  async function pushPendingRevisions(userId, cycleId, counts, guard = () => true) {
    if (!pushItemRevisionsRpc) return;
    const data = await peekDataFile();
    const byId = new Map((data.itemRevisions || []).map((revision) => [revision.id, revision]));
    const userState = await peekUserState(userId);
    const pending = (userState.pendingRevisionIds || []).map((id) => byId.get(id)).filter(Boolean);
    const missingIds = (userState.pendingRevisionIds || []).filter((id) => !byId.has(id));
    const resolvedIds = new Set(missingIds);
    for (const batch of outbox.chunk(pending, pushBatchSize)) {
      const rows = batch.map(mapping.revisionToPushRow);
      let results;
      try {
        results = await pushItemRevisionsRpc(rows);
      } catch (err) {
        if (
          err &&
          (err.code === 'PGRST202' ||
            err.code === 'PGRST404' ||
            err.code === '42883' ||
            err.name === 'AssertionError' ||
            (err.name === 'TypeError' && /not a function/.test(err.message || '')))
        ) {
          pushItemRevisionsRpc = null;
          log.warn('history push unavailable; retaining local revisions', { cycleId, err });
          return;
        }
        throw err;
      }
      counts.pushedRevisions += rows.length;
      results.forEach((result) => {
        if (result.accepted || result.reason === 'duplicate') {
          resolvedIds.add(result.row_id);
          if (result.accepted) counts.pushedRevisionsAccepted += 1;
        } else {
          log.warn('push_item_revisions row rejected', {
            cycleId,
            id: result.row_id,
            reason: result.reason,
          });
        }
      });
    }
    if (!resolvedIds.size) return;
    await withDataFile(async (current) => {
      const next = {
        ...current,
        itemRevisions: (current.itemRevisions || []).map((revision) =>
          resolvedIds.has(revision.id) ? { ...revision, status: 'synced' } : revision
        ),
      };
      return { data: history.markSuperseded(next), result: null };
    }, guard);
    await withUserState(userId, (state) => ({
      userState: {
        ...state,
        pendingRevisionIds: outbox.removeIds(state.pendingRevisionIds, [...resolvedIds]),
      },
      result: null,
    }));
  }

  async function pullItemRevisionsAndMerge(userId, cycleId, counts, guard = () => true) {
    if (!pullItemRevisionsPage) return;
    const userState = await peekUserState(userId);
    let pulled;
    try {
      pulled = await pullAll({
        pageFn: pullItemRevisionsPage,
        cursorMs: userState.revisionCursor,
        lookbackMs,
        pageSize: pullPageSize,
        isoToMs: mapping.isoToMs,
        msToIso: mapping.msToIso,
        cursorField: 'server_received_at',
      });
    } catch (err) {
      // History is additive. A deployment without its migration (or a test
      // double that only implements the existing tables) must not break item
      // sync. A transient network error remains visible and retryable.
      if (
        err &&
        (err.code === '42P01' ||
          err.code === 'PGRST205' ||
          err.name === 'AssertionError' ||
          (err.name === 'TypeError' && /not a function/.test(err.message || '')))
      ) {
        pullItemRevisionsPage = null;
        log.warn('history pull unavailable; continuing current-item sync', { cycleId, err });
        return;
      }
      throw err;
    }
    const { rows, cursor } = pulled;
    counts.pulledRevisions = rows.length;
    let merged = null;
    if (rows.length) {
      const revisions = rows.map(mapping.rowToRevision).filter(Boolean);
      ({ data: merged } = await withDataFile(
        async (current) => ({
          data: history.merge(current, { itemRevisions: revisions }),
          result: null,
        }),
        guard
      ));
      if (merged) notifyReload();
    }
    if (cursor != null || merged) {
      await withUserState(userId, (state) => ({
        userState: { ...state, ...(cursor != null ? { revisionCursor: cursor } : {}) },
        result: null,
      }));
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

  async function pullItemsAndMerge(userId, cycleId, counts, guard = () => true) {
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
      }, guard));
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

  async function pullLogEntriesAndMerge(userId, cycleId, counts, guard = () => true) {
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
    }, guard));

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
      pushedRevisions: 0,
      pushedRevisionsAccepted: 0,
      pulledItems: 0,
      pulledLogEntries: 0,
      pulledRevisions: 0,
    };
    try {
      await diffLocalChangesIntoOutbox(userId, cycleId);
      if (!stillCurrent()) return;
      await pushPendingItems(userId, cycleId, counts, stillCurrent);
      if (!stillCurrent()) return;
      await ensureHistoryBaselines(stillCurrent);
      await diffLocalChangesIntoOutbox(userId, cycleId);
      if (!stillCurrent()) return;
      await pushPendingRevisions(userId, cycleId, counts, stillCurrent);
      if (!stillCurrent()) return;
      await pushPendingLogEntries(userId, cycleId, counts);
      if (!stillCurrent()) return;
      await pullItemsAndMerge(userId, cycleId, counts, stillCurrent);
      if (!stillCurrent()) return;
      await pullLogEntriesAndMerge(userId, cycleId, counts, stillCurrent);
      if (!stillCurrent()) return;
      await pullItemRevisionsAndMerge(userId, cycleId, counts, stillCurrent);
      if (!stillCurrent()) return;

      const finalState = await peekUserState(userId);
      if (!stillCurrent()) return;
      const clean =
        finalState.pendingItemIds.length === 0 &&
        finalState.pendingLogEntryIds.length === 0 &&
        (!pushItemRevisionsRpc || finalState.pendingRevisionIds.length === 0);
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
