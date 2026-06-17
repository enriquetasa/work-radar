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
        log: Array.isArray(x.log) ? x.log : [],
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
      .filter((i) => !i.archivedAt)
      .slice()
      .sort((a, b) => PRANK[a.priority] - PRANK[b.priority] || a.name.localeCompare(b.name));

    const PRIORITY_LABEL = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };
    const PRIORITY_COLOR = {
      critical: '#b71c1c',
      high: '#e65100',
      medium: '#1b5e20',
      low: '#006064',
    };
    const STATUS_LABEL = { active: 'ACTIVE', watch: 'WATCH', dormant: 'DORMANT' };

    // Group items by priority so the report has clear sections.
    const groups = ['critical', 'high', 'medium', 'low']
      .map((p) => ({ priority: p, items: live.filter((i) => i.priority === p) }))
      .filter((g) => g.items.length > 0);

    const groupsHTML = groups
      .map((g) => {
        const itemsHTML = g.items
          .map((item) => {
            const meta = [STATUS_LABEL[item.status], item.category].filter(Boolean).join(' · ');
            const notesHTML = item.notes
              ? `<div class="item-notes">${escapeHtml(item.notes)}</div>`
              : '';
            const logHTML =
              item.log && item.log.length
                ? `<div class="log">
                    <div class="log-label">LOG</div>
                    ${item.log
                      .map(
                        (e) =>
                          `<div class="log-entry"><span class="log-ts">${fdt(e.ts)}</span><span>${escapeHtml(e.text)}</span></div>`
                      )
                      .join('')}
                  </div>`
                : '';
            return `<div class="item">
              <div class="item-name">${escapeHtml(item.name.toUpperCase())}</div>
              <div class="item-meta">${escapeHtml(meta)}</div>
              ${notesHTML}${logHTML}
            </div>`;
          })
          .join('');
        return `<div class="group">
          <div class="group-label" style="color:${PRIORITY_COLOR[g.priority]}">
            ● ${PRIORITY_LABEL[g.priority]}
          </div>
          ${itemsHTML}
        </div>`;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Work Radar Report — ${date}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;
    color:#1a1a1a;max-width:680px;margin:0 auto;padding:40px 32px;font-size:11px;line-height:1.6}
  h1{font-size:20px;font-weight:700;letter-spacing:3px;text-transform:uppercase;margin:0 0 4px}
  .subtitle{font-size:9px;letter-spacing:1px;color:#888;text-transform:uppercase;margin-bottom:36px}
  .group{margin-bottom:28px}
  .group-label{font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;
    margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid currentColor}
  .item{padding:12px 0;border-bottom:1px solid #eee;page-break-inside:avoid}
  .item-name{font-size:13px;font-weight:600;letter-spacing:1px;text-transform:uppercase;margin-bottom:2px}
  .item-meta{font-size:9px;letter-spacing:1px;color:#666;text-transform:uppercase;margin-bottom:6px}
  .item-notes{font-size:10px;color:#333;border-left:2px solid #ddd;padding-left:10px;
    margin-bottom:8px;white-space:pre-wrap;word-break:break-word}
  .log{margin-top:6px}
  .log-label{font-size:8px;letter-spacing:2px;color:#aaa;text-transform:uppercase;margin-bottom:4px}
  .log-entry{display:flex;gap:14px;font-size:9px;color:#444;padding:3px 0;
    border-bottom:1px solid #f5f5f5;word-break:break-word}
  .log-ts{color:#aaa;flex-shrink:0;font-variant-numeric:tabular-nums}
  .footer{margin-top:40px;padding-top:12px;border-top:1px solid #eee;
    font-size:8px;color:#bbb;letter-spacing:1px;text-transform:uppercase}
</style>
</head>
<body>
  <h1>Work Radar</h1>
  <div class="subtitle">Status Report — ${date} — ${live.length} active contact${live.length !== 1 ? 's' : ''}</div>
  ${groupsHTML}
  <div class="footer">Generated ${date} · Work Radar v2</div>
</body>
</html>`;
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
    escapeHtml,
    buildReportHTML,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.WorkRadarDomain = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
