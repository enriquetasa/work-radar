'use strict';

// Persist only enough state to detect changed items and new append-only log entries.
function snapshotOf(data) {
  const items = {};
  const logEntryIds = [];
  [...(data.items || []), ...(data.arch || [])].forEach((item) => {
    items[item.id] = item.updatedAt;
    (item.log || []).forEach((e) => logEntryIds.push(e.id));
  });
  return { items, logEntryIds };
}

function diffSnapshot(prev, next) {
  const prevItems = (prev && prev.items) || {};
  const prevLogIds = new Set((prev && prev.logEntryIds) || []);
  const changedItemIds = Object.keys(next.items).filter(
    (id) => prevItems[id] === undefined || prevItems[id] !== next.items[id]
  );
  const newLogEntryIds = next.logEntryIds.filter((id) => !prevLogIds.has(id));
  return { changedItemIds, newLogEntryIds };
}

// Preserve queue order so repeated failures do not jump behind newer work.
function unionIds(a, b) {
  const seen = new Set(a || []);
  const out = [...(a || [])];
  (b || []).forEach((id) => {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  });
  return out;
}

function removeIds(ids, toRemove) {
  const gone = new Set(toRemove);
  return (ids || []).filter((id) => !gone.has(id));
}

function indexData(data) {
  const itemsById = new Map();
  const logEntriesById = new Map();
  [...(data.items || []), ...(data.arch || [])].forEach((item) => {
    itemsById.set(item.id, item);
    (item.log || []).forEach((entry) => {
      logEntriesById.set(entry.id, { itemId: item.id, entry });
    });
  });
  return { itemsById, logEntriesById };
}

function chunk(arr, size) {
  if (!arr.length) return [];
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Patch only ids touched by the caller; concurrent work may own the rest.
function patchSnapshot(prevSnapshot, data, itemIds, logEntryIds) {
  const { itemsById, logEntriesById } = indexData(data);
  const items = { ...((prevSnapshot && prevSnapshot.items) || {}) };
  (itemIds || []).forEach((id) => {
    const item = itemsById.get(id);
    if (item) items[id] = item.updatedAt;
  });
  const prevLogIds = (prevSnapshot && prevSnapshot.logEntryIds) || [];
  const seen = new Set(prevLogIds);
  const additions = (logEntryIds || []).filter((id) => logEntriesById.has(id) && !seen.has(id));
  return { items, logEntryIds: [...prevLogIds, ...additions] };
}

module.exports = {
  snapshotOf,
  diffSnapshot,
  unionIds,
  removeIds,
  indexData,
  chunk,
  patchSnapshot,
};
