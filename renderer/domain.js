'use strict';
/* ============================================================
   WORK RADAR — domain
   Pure, side-effect-free logic shared by the renderer and the
   test suite. No DOM, no storage, no Electron. Loaded as a
   browser global (window.WorkRadarDomain) via <script>, and as a
   CommonJS module (require) under node:test.
   ============================================================ */

(function (root) {
  const SCHEMA = 2;
  const STALE_DAYS = 14; // days without a PING => NEEDS REVIEW
  const BACKUP_DAYS = 7; // nudge to export after this long
  const DAY = 86400000;

  // Priority colours (also the set of valid priorities).
  const PC = { critical: '#f44336', high: '#ff9100', medium: '#00e676', low: '#26c6da' };
  // Status colours (also the set of valid statuses).
  const SC = { active: '#00e676', watch: '#ff9100', dormant: '#546e7a' };
  // Status -> radar ring radius fraction.
  const SR = { active: 0.31, watch: 0.6, dormant: 0.87 };
  // Priority -> sort rank.
  const PRANK = { critical: 0, high: 1, medium: 2, low: 3 };
  const CX = 128;
  const CY = 128;
  const R = 110;

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function fdt(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  }

  function daysSince(ts, now = Date.now()) {
    return Math.floor((now - ts) / DAY);
  }

  function isStale(item, now = Date.now()) {
    return !item.archivedAt && daysSince(item.reviewedAt, now) >= STALE_DAYS;
  }

  // Normalise an arbitrary list (legacy data, imports) into the current
  // schema, dropping anything without a name and coercing invalid enums.
  function migrate(list, now = Date.now()) {
    return list
      .filter((x) => x && x.name)
      .map((x) => ({
        id: x.id || uid(),
        name: String(x.name),
        status: SC[x.status] ? x.status : 'active',
        priority: PC[x.priority] ? x.priority : 'medium',
        category: x.category || '',
        notes: x.notes || '',
        addedAt: x.addedAt || now,
        updatedAt: x.updatedAt || x.addedAt || now,
        reviewedAt: x.reviewedAt || x.addedAt || now,
        archivedAt: x.archivedAt || undefined,
      }));
  }

  function serialize(state) {
    return {
      schema: SCHEMA,
      items: state.items,
      arch: state.arch,
      lastExport: state.lastExport,
    };
  }

  // Filter + sort the current view. Pure: derives from state, never mutates it.
  function selectVisible(state, now = Date.now()) {
    const ui = state.ui;
    let list = ui.view === 'live' ? state.items.slice() : state.arch.slice();
    const q = ui.search.trim().toLowerCase();
    if (q) {
      list = list.filter((i) =>
        (i.name + ' ' + (i.category || '') + ' ' + (i.notes || '')).toLowerCase().includes(q)
      );
    }
    if (ui.view === 'live') {
      const f = ui.filter;
      if (f === 'review') list = list.filter((i) => isStale(i, now));
      else if (f !== 'all') list = list.filter((i) => i.status === f);
    }
    const s = ui.sort;
    list.sort((a, b) => {
      if (s === 'priority')
        return PRANK[a.priority] - PRANK[b.priority] || a.name.localeCompare(b.name);
      if (s === 'stale') return a.reviewedAt - b.reviewedAt;
      if (s === 'name') return a.name.localeCompare(b.name);
      if (s === 'recent') return b.addedAt - a.addedAt;
      return 0;
    });
    return list;
  }

  // Merge two lists by id: incoming overwrites existing, new ids appended.
  function mergeById(base, inc) {
    const m = new Map(base.map((i) => [i.id, i]));
    inc.forEach((i) => m.set(i.id, i));
    return [...m.values()];
  }

  // Deterministic blip placement: a golden-angle spiral keyed off the id,
  // at a radius set by the item's status ring.
  function blipXY(item) {
    const h = [...item.id].reduce((a, c) => a + c.charCodeAt(0), 0);
    const deg = (h * 137.508) % 360;
    const rad = ((deg - 90) * Math.PI) / 180;
    return {
      x: CX + Math.cos(rad) * R * SR[item.status],
      y: CY + Math.sin(rad) * R * SR[item.status],
      deg,
    };
  }

  const api = {
    SCHEMA,
    STALE_DAYS,
    BACKUP_DAYS,
    DAY,
    PC,
    SC,
    SR,
    PRANK,
    CX,
    CY,
    R,
    uid,
    fdt,
    daysSince,
    isStale,
    migrate,
    serialize,
    selectVisible,
    mergeById,
    blipXY,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.WorkRadarDomain = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
