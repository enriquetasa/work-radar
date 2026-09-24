'use strict';
/* ============================================================
   WORK RADAR — auth panel view state
   Pure decision logic for renderer/app.js's Auth.render(): given the
   latest status (from authStatus() on init, or the 'auth:stateChanged'
   push), which of the auth panel's elements should be visible, and
   whether an existing #auth-error should be cleared.

   Only the signedIn and pending branches clear the error — those are
   the two states that follow a genuine transition (into signed-in, or
   into a fresh pending sign-in via submit() or a reload). The signed-
   out/not-pending branch is also what a *failed* sign-in settles into:
   sync/auth-service.js's signIn() rejects, its IPC caller (main.js)
   replies with the error, and Auth.submit() calls showError() — but the
   finally block's settled `{ signedIn:false, pending:false }` push
   still arrives afterwards (it awaits its own getStatus() + file read),
   which used to reach render() and immediately hide the very error
   message just shown. Clearing the error there would silently erase it
   again, every time. Only submit(), starting a fresh attempt, clears it
   (see docs/supabase-sync-plan.md's Phase 3 "Renderer" notes).

   No DOM, no Electron. Loaded as a browser global (window.WorkRadarAuthView)
   via <script>, and as a CommonJS module (require) under node:test — same
   dual-mode pattern as renderer/domain.js.
   ============================================================ */

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
