'use strict';
(function (root) {
  function computeAuthView(status) {
    if (status.signedIn) {
      return { form: false, pending: false, signedIn: true, clearError: true };
    }
    if (status.pending) {
      return { form: false, pending: true, signedIn: false, clearError: true };
    }
    return { form: true, pending: false, signedIn: false, clearError: false };
  }

  const api = { computeAuthView };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.WorkRadarAuthView = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
