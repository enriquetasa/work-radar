'use strict';
(function (root) {
  const LABELS = {
    synced: '● Synced',
    pending: '◌ Syncing',
    offline: '● Offline · changes stay on this device',
    error: '⚠ Sync error · changes stay on this device',
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
