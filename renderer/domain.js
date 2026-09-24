'use strict';
/* ============================================================
   WORK RADAR — domain
   Pure, side-effect-free logic shared by the renderer and the
   test suite. No DOM, no storage, no Electron. Loaded as a
   browser global (window.WorkRadarDomain) via <script>, and as a
   CommonJS module (require) under node:test.
   ============================================================ */

(function (root) {
  const SCHEMA = 3;
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

  // Small stable string hash (djb2 variant). Used only to derive
  // deterministic ids for legacy log entries — never for anything that
  // needs to be collision-proof against adversarial input.
  function hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = (h * 33) ^ s.charCodeAt(i);
    }
    return (h >>> 0).toString(36);
  }

  // Legacy log entries (schema v2 and older) have no id. Two machines
  // migrating the same legacy file independently must assign the same id
  // to "the same" entry, so it is derived from its content rather than
  // random (uid()) or positional (array index, which shifts under merge).
  // itemId and ts are embedded verbatim (not hashed) so only `text` goes
  // through the lossy hash, keeping the collision surface small; `log_entries.id`
  // is a global primary key downstream, so a collision would silently drop
  // an entry or fail a push.
  function legacyLogId(itemId, ts, text) {
    return 'lg_' + itemId + '_' + ts + '_' + hashString(text);
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
  // Also carries schema v2 (and older) data forward to v3: adds a stable id
  // to any log entry missing one, and leaves deletedAt (the purge
  // tombstone marker, new in v3) unset unless already present.
  function migrate(list, now = Date.now()) {
    return list
      .filter((x) => x && x.name)
      .map((x) => {
        const id = x.id || uid();
        // Malformed entries are dropped rather than crashing the whole
        // migration on a corrupt data file or import: non-objects (null,
        // strings, ...) outright, and — for entries with no id of their own
        // (legacy v2 and older) — anything without a finite numeric `ts`,
        // since legacyLogId needs `ts` to derive a stable id and a
        // non-numeric one can't be trusted to be comparable across entries.
        // `text` is coerced to a string (missing/null becomes '') rather
        // than dropped, since a log entry with real content but no message
        // text is still worth keeping.
        const rawLog = Array.isArray(x.log)
          ? x.log.filter((e) => e && typeof e === 'object' && (e.id || Number.isFinite(e.ts)))
          : [];
        // Two identical legacy entries (same item, ts and text) hash to the
        // same base id; disambiguate with an occurrence index so they don't
        // collapse into one entry once ids are unioned during a merge. Both
        // sides migrating the same file independently see entries in the
        // same array order, so the index stays deterministic across machines.
        const seen = new Map();
        const log = rawLog.map((e) => {
          if (e.id) return { ...e };
          const text = String(e.text ?? '');
          const base = legacyLogId(id, e.ts, text);
          const n = seen.get(base) || 0;
          seen.set(base, n + 1);
          return { ...e, text, id: n === 0 ? base : base + '_' + n };
        });
        // Under schema v2 (and older), ping/archive/restore/addLogEntry did
        // not bump updatedAt, so a legacy row's updatedAt can be older than
        // its reviewedAt, archivedAt, or its newest log entry. If migrate()
        // left updatedAt as-is, "newest updatedAt wins" would tie two v2-era
        // copies that really differ in time and let the tie-break (which
        // doesn't know about any of this) decide arbitrarily — e.g. undoing
        // an archive+ping by resurrecting an older live backup of the same
        // item. Taking the max over all of them brings updatedAt up to what
        // v3 would have recorded. It is a no-op on v3 data, because every v3
        // mutation already sets updatedAt to at least these values, so this
        // is safe to run on every load, not just once at the v2->v3 boundary.
        // The fallback when neither updatedAt nor addedAt is present is 0,
        // not `now`: two machines migrating the same legacy row independently
        // must land on the same updatedAt (Math.max below still picks up the
        // row's own signals, e.g. its newest log ts), or the merge winner
        // would depend on which machine happened to migrate later.
        const base = x.updatedAt || x.addedAt || 0;
        const logMax = log.reduce((m, e) => (e.ts && e.ts > m ? e.ts : m), 0);
        const updatedAt = Math.max(
          base,
          x.reviewedAt || 0,
          x.archivedAt || 0,
          x.deletedAt || 0,
          logMax
        );
        return {
          id,
          name: String(x.name),
          status: SC[x.status] ? x.status : 'active',
          priority: PC[x.priority] ? x.priority : 'medium',
          category: x.category || '',
          notes: x.notes || '',
          addedAt: x.addedAt || now,
          updatedAt,
          reviewedAt: x.reviewedAt || x.addedAt || now,
          archivedAt: x.archivedAt || undefined,
          deletedAt: x.deletedAt || undefined,
          log,
        };
      });
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
    let list = (ui.view === 'live' ? state.items : state.arch).filter((i) => !i.deletedAt);
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

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Build a printable HTML report of all live (non-archived) items, grouped by
  // priority and sorted by name within each group. Logs are shown chronologically
  // (oldest-first) so they read as a narrative for supervisors.
  function buildReportHTML(items, now = Date.now()) {
    const date = fdt(now);
    const live = items
      .filter((i) => !i.archivedAt && !i.deletedAt)
      .slice()
      .sort((a, b) => PRANK[a.priority] - PRANK[b.priority] || a.name.localeCompare(b.name));

    const PRIORITY_LABEL = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };
    const STATUS_LABEL = { active: 'ACTIVE', watch: 'WATCH', dormant: 'DORMANT' };

    const groups = ['critical', 'high', 'medium', 'low']
      .map((p) => ({ priority: p, items: live.filter((i) => i.priority === p) }))
      .filter((g) => g.items.length > 0);

    const groupsHTML = groups
      .map((g) => {
        const itemsHTML = g.items
          .map((item) => {
            const meta = [STATUS_LABEL[item.status], item.category].filter(Boolean).join('  /  ');
            const notesHTML = item.notes
              ? `<div class="item-notes">${escapeHtml(item.notes)}</div>`
              : '';
            const logHTML =
              item.log && item.log.length
                ? `<div class="log">${item.log.map((e) => `<div class="log-entry"><span class="log-ts">${fdt(e.ts)}</span>${escapeHtml(e.text)}</div>`).join('')}</div>`
                : '';
            return `<div class="item"><div class="item-name">${escapeHtml(item.name.toUpperCase())}</div><div class="item-meta">${escapeHtml(meta)}</div>${notesHTML}${logHTML}</div>`;
          })
          .join('');
        return `<div class="group"><div class="group-label">${PRIORITY_LABEL[g.priority]}</div>${itemsHTML}</div>`;
      })
      .join('');

    const css = `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Courier New',Courier,monospace;color:#111;max-width:680px;margin:0 auto;padding:28px 32px;font-size:11px;line-height:1.5}
.report-title{font-size:13px;font-weight:bold;letter-spacing:1px;text-transform:uppercase}
.report-sub{font-size:10px;color:#666;margin-top:2px}
.report-rule{border:none;border-top:1px solid #111;margin:10px 0 16px}
.group{margin-bottom:14px}
.group-label{font-size:9px;font-weight:bold;letter-spacing:3px;color:#888;border-bottom:1px solid #ddd;padding-bottom:3px;margin-bottom:8px}
.item{margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #efefef;page-break-inside:avoid}
.item:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0}
.item-name{font-weight:bold;font-size:12px;letter-spacing:.5px}
.item-meta{font-size:10px;color:#666;margin:2px 0 4px}
.item-notes{font-size:10px;color:#333;padding-left:12px;white-space:pre-wrap;word-break:break-word;margin-bottom:4px}
.log{padding-left:12px}
.log-entry{font-size:10px;color:#555;padding:1px 0;word-break:break-word}
.log-ts{display:inline-block;width:76px;color:#999;flex-shrink:0}
.footer{margin-top:16px;border-top:1px solid #ddd;padding-top:6px;font-size:9px;color:#bbb;letter-spacing:.5px}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Work Radar Report — ${date}</title>
<style>${css}</style>
</head>
<body>
<div class="report-title">Work Radar — Status Report</div>
<div class="report-sub">${date}  ·  ${live.length} active contact${live.length !== 1 ? 's' : ''}</div>
<hr class="report-rule">
${groupsHTML}
<div class="footer">Generated ${date}  ·  Work Radar v2</div>
</body>
</html>`;
  }

  // Hide purge tombstones (deletedAt set) from any list rendered to the
  // user — lists, stats/counts, search, radar blips. They stay in the data
  // file (see mergeState) so a later merge still sees the deletion.
  function stripTombstones(list) {
    return list.filter((i) => !i.deletedAt);
  }

  // Union two versions of the same item's log by id (append-only, so a
  // union — never a diff), sorted by ts with id as a deterministic
  // tie-break so the result never depends on argument order.
  function unionLogs(a, b) {
    const m = new Map();
    (a || []).forEach((e) => m.set(e.id, e));
    (b || []).forEach((e) => {
      if (!m.has(e.id)) m.set(e.id, e);
    });
    return [...m.values()].sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  }

  // Serialize an item for the tie-break comparison below with a fixed,
  // sorted key order, so two objects with identical fields compare equal
  // regardless of the order their keys happen to be in (e.g. rows built
  // from Supabase, where field order isn't guaranteed). `log` is excluded —
  // it's compared separately (it's unioned, not tie-broken) and would
  // otherwise couple the tie-break to log ordering.
  function stableStringify(item) {
    const keys = Object.keys(item)
      .filter((k) => k !== 'log')
      .sort();
    return JSON.stringify(item, keys);
  }

  // Merge two versions of the same item (same id, from two machines/files).
  // Every field except log is "newest updatedAt wins" — this is uniform
  // across the whole record, including archivedAt and deletedAt, since
  // both archive and purge bump updatedAt like any other mutation. That
  // means a later edit can "resurrect" an item a stale tombstone deleted,
  // and a later purge always wins over a stale edit. Ties (identical
  // updatedAt, different content — clock granularity, or edits replayed
  // twice) are broken deterministically and symmetrically so the winner
  // never depends on which side is passed as `a` vs `b`.
  function mergeItem(a, b) {
    const log = unionLogs(a.log, b.log);
    let winner;
    if (a.updatedAt !== b.updatedAt) {
      winner = a.updatedAt > b.updatedAt ? a : b;
    } else {
      // Break the tie on the numeric signals first (reviewedAt, then
      // archivedAt, then deletedAt) rather than jumping straight to the
      // text comparison, which compares numbers character by character and
      // would pick e.g. reviewedAt 99 over 100. Still deterministic and
      // symmetric (subtraction is antisymmetric); falls back to the text
      // comparison only once all three are equal too.
      const numTie =
        (a.reviewedAt || 0) - (b.reviewedAt || 0) ||
        (a.archivedAt || 0) - (b.archivedAt || 0) ||
        (a.deletedAt || 0) - (b.deletedAt || 0);
      if (numTie !== 0) {
        winner = numTie > 0 ? a : b;
      } else {
        const sa = stableStringify(a);
        const sb = stableStringify(b);
        winner = sa >= sb ? a : b;
      }
    }
    return { ...winner, log };
  }

  // Merge two full states (each { items, arch }) into one. Items can move
  // between live and archived on either side (archive here, edit there),
  // so the merge is done over the *union* of both sides' items and
  // archive lists, keyed by id, and only split back into items/arch by
  // the winning archivedAt at the end.
  function mergeState(a, b) {
    const all = new Map();
    const absorb = (list) => {
      list.forEach((i) => {
        const existing = all.get(i.id);
        all.set(i.id, existing ? mergeItem(existing, i) : i);
      });
    };
    absorb(a.items);
    absorb(a.arch);
    absorb(b.items);
    absorb(b.arch);
    const merged = [...all.values()];
    return {
      items: merged.filter((i) => !i.archivedAt),
      arch: merged.filter((i) => i.archivedAt),
    };
  }

  // Item mutations. Every one bumps updatedAt so mergeItem's "newest
  // updatedAt wins" rule actually sees every change — a mutation that
  // forgot this bump would let a stale copy on another machine silently
  // overwrite it, or (for purge) let the item come back from the dead.
  // Pure: each returns a new item, never mutates the one passed in.
  // app.js's Actions call these instead of building the patch inline, so
  // the bump is tested here rather than only reachable through the DOM.

  // Machine clocks differ. A mutation that just stamped updatedAt =
  // Date.now() could hand back an updatedAt *older* than the row already
  // carries, if this machine's clock reads behind the clock that wrote
  // that row (or simply behind this same row's own last edit, replayed
  // from a pull) — and mergeItem's "newest updatedAt wins" would then
  // keep discarding this machine's own edit forever, since it can never
  // catch up under a plain Date.now(). nextUpdatedAt instead always lands
  // at least one past whatever updatedAt the row already has, using the
  // wall clock only when that's already ahead. Other timestamp fields
  // (reviewedAt, archivedAt, deletedAt, log ts) are unaffected — they
  // keep recording the real wall-clock time, only updatedAt is a
  // merge-decision field that must never go backwards.
  function nextUpdatedAt(prevUpdatedAt, now = Date.now()) {
    return Math.max(now, (prevUpdatedAt || 0) + 1);
  }

  function pingItem(item, now = Date.now()) {
    return { ...item, reviewedAt: now, updatedAt: nextUpdatedAt(item.updatedAt, now) };
  }

  function archiveItem(item, now = Date.now()) {
    return { ...item, archivedAt: now, updatedAt: nextUpdatedAt(item.updatedAt, now) };
  }

  function restoreItem(item, now = Date.now()) {
    const { archivedAt, ...rest } = item;
    return { ...rest, reviewedAt: now, updatedAt: nextUpdatedAt(item.updatedAt, now) };
  }

  // PURGE never removes the record — see mergeItem's doc comment for why a
  // tombstone (deletedAt) has to be an ordinary "newest updatedAt wins"
  // mutation, not a special case, so it merges the same way as any edit.
  function purgeItem(item, now = Date.now()) {
    return { ...item, deletedAt: now, updatedAt: nextUpdatedAt(item.updatedAt, now) };
  }

  function addLogEntry(item, text, now = Date.now(), idFn = uid) {
    const entry = { id: idFn(), ts: now, text };
    return {
      ...item,
      log: [...(item.log || []), entry],
      updatedAt: nextUpdatedAt(item.updatedAt, now),
    };
  }

  // Actions.add/update in app.js route through these two rather than
  // patching Store.items inline, for the same reason as the mutations
  // above — found in the Phase 1 review as a carried-over gap: add/update
  // were still stamping updatedAt = Date.now() directly in app.js,
  // un-tested and without the clock-skew guard every other mutation gets.
  function createItem(v, now = Date.now(), idFn = uid) {
    return { id: idFn(), ...v, log: [], addedAt: now, updatedAt: now, reviewedAt: now };
  }

  function updateItem(item, patch, now = Date.now()) {
    return { ...item, ...patch, updatedAt: nextUpdatedAt(item.updatedAt, now) };
  }

  // Merges a freshly-read data file into the renderer's in-memory Store
  // (renderer/app.js's Sync.reload(), pulled out to be unit-testable —
  // found in review: this used to be inline DOM-adjacent code with no
  // test), rather than replacing it the way Store.load() does. A plain
  // replace can lose an edit made in this renderer that hasn't reached
  // disk yet: a save still in flight when a reload runs would roll the
  // Store back to the pre-edit copy, and a save still sitting in the
  // debounce window would then serialize the reloaded (pre-edit) Store
  // over the edit on disk. The merge is safe for the same reason the rest
  // of sync is: it's the same last-writer-wins rule that already
  // reconciles two machines, just applied here to reconcile "the
  // renderer's in-memory view" against "what main just wrote to disk".
  // `fromDisk`'s items/arch are migrate()d first, in case the file on
  // disk predates a schema bump this renderer already knows about.
  function mergeDiskIntoStore(fromDisk, store) {
    const merged = mergeState(
      {
        items: migrate(Array.isArray(fromDisk.items) ? fromDisk.items : []),
        arch: migrate(Array.isArray(fromDisk.arch) ? fromDisk.arch : []),
      },
      { items: store.items, arch: store.arch }
    );
    // Never rolls backwards: a reload landing after an export has set
    // Store.lastExport in memory but before that save reaches disk must
    // not roll it back to the stale on-disk value (found in review) — the
    // "back up your data" nudge would otherwise reappear right after an
    // export that already happened. `|| 0` treats a missing lastExport on
    // either side as "never exported" rather than as bigger than a real
    // timestamp.
    return {
      items: merged.items,
      arch: merged.arch,
      lastExport: Math.max(fromDisk.lastExport || 0, store.lastExport || 0),
    };
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
    stripTombstones,
    mergeItem,
    mergeState,
    nextUpdatedAt,
    pingItem,
    archiveItem,
    restoreItem,
    purgeItem,
    addLogEntry,
    createItem,
    updateItem,
    mergeDiskIntoStore,
    blipXY,
    escapeHtml,
    buildReportHTML,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.WorkRadarDomain = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
