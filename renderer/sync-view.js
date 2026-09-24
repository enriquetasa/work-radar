'use strict';
/* ============================================================
   WORK RADAR — sync status view state
   Pure decision logic for renderer/app.js's Sync.render(): given the
   latest `sync:stateChanged` push from main (see
   docs/supabase-sync-plan.md's Phase 4-5 notes), what the header's
   #sync-status span should show. `status` is `{ state }` with state one
   of 'synced' | 'pending' | 'offline' | 'error', or `{ state: null }`
   (or nothing at all, e.g. before the first push ever arrives) meaning
   "hide it" — sync isn't configured, the user is signed out, or the
   engine hasn't reported anything yet.

   No DOM, no Electron. Loaded as a browser global
   (window.WorkRadarSyncView) via <script>, and as a CommonJS module
   (require) under node:test — same dual-mode pattern as domain.js and
   auth-view.js.
   ============================================================ */

(function (root) {
  const LABELS = {
    synced: '◈ SYNCED',
    pending: '◈ PENDING',
    offline: '◈ OFFLINE',
    error: '◈ SYNC ERROR',
  };
  const CLASSES = {
    synced: 'sync-synced',
    pending: 'sync-pending',
    offline: 'sync-offline',
    error: 'sync-error',
  };

  function computeSyncView(status) {
    const state = status && status.state;
    if (!state || !LABELS[state]) return { hidden: true, label: '', className: '' };
    return { hidden: false, label: LABELS[state], className: CLASSES[state] };
  }

  const api = { computeSyncView };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.WorkRadarSyncView = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
