'use strict';
/* ============================================================
   WORK RADAR — auth service
   Orchestrates the sign-in flow from docs/supabase-sync-plan.md →
   "Sign-in flow": signInWithOtp -> wait for the loopback redirect ->
   exchangeCodeForSession. Everything that actually talks to Supabase or
   opens a socket (`client`, `waitForCallback`) is injected, so this is
   testable under node:test with fakes — see test/sync-auth-service.test.js
   for the unit tests and test/integration/auth.test.js for the real
   end-to-end flow against local Supabase.

   main.js is the only caller: it wires this to IPC and to the Radar
   menu's Sign Out item, and forwards `onChange` to the renderer.
   ============================================================ */

const crypto = require('crypto');
const log = require('../logger');

// `pending` is folded in from the enclosing service's own `signInPending`
// flag (see below) — it isn't part of the Supabase session at all, but the
// renderer needs it to know "a sign-in is already in flight" across a
// reload, rather than only from the one call that started it.
function toStatus(session, pending) {
  return { signedIn: !!session, email: session?.user?.email ?? null, pending };
}

// `redirectTo` must exactly match the loopback callback URL that
// `waitForCallback` will actually listen on — it's both the emailRedirectTo
// sent to Supabase and the only entry in the local/hosted redirect allow-list.
function createAuthService({ client, waitForCallback, redirectTo, log: logger = log }) {
  const listeners = new Set();
  let signInPending = false;

  function emit(status) {
    for (const fn of listeners) {
      try {
        fn(status);
      } catch (err) {
        logger.error('auth state change listener threw', { err });
      }
    }
  }

  const { data: subscriptionData } = client.auth.onAuthStateChange((event, session) => {
    logger.info('auth state changed', { event, signedIn: !!session });
    emit(toStatus(session, signInPending));
  });

  async function getStatus() {
    const { data, error } = await client.auth.getSession();
    if (error) {
      logger.warn('failed to read current session', { err: error });
      return { signedIn: false, email: null, pending: signInPending };
    }
    return toStatus(data.session, signInPending);
  }

  // Runs the whole magic-link round trip and resolves once a session has
  // been obtained and persisted. Throws (never swallows) on any step's
  // failure — the caller (main.js's IPC handler) reports it to the
  // renderer instead of leaving a hung "check your inbox" state.
  //
  // Binds the loopback listener *before* calling signInWithOtp — emails
  // are scarce (local and hosted rate limits are both tight), so a port
  // conflict must be discovered before one is sent, not after. See
  // docs/supabase-sync-plan.md's Phase 3 notes.
  async function signIn(email) {
    if (signInPending) {
      throw new Error('a sign-in is already pending — finish or wait for it to time out first');
    }
    // Set synchronously, before any `await` below — two signIn() calls in
    // the same tick must not both pass the check above (see
    // test/sync-auth-service.test.js's "a second signIn call while one is
    // pending" test). The existing-session check just below is itself
    // async, so it has to happen after this flag is already up.
    signInPending = true;
    // A short id correlating every log line this attempt produces (start,
    // OTP, callback, exchange) — see the observability rule in
    // docs/supabase-sync-plan.md's Phase 3 notes.
    const attemptId = crypto.randomUUID();
    try {
      const existing = await getStatus();
      if (existing.signedIn) {
        throw new Error('already signed in — sign out first');
      }
      logger.info('sign-in attempt started', { attemptId });
      emit({ signedIn: false, email: null, pending: true });
      const pending = waitForCallback();
      // `pending.result` is only actually awaited further down, on the
      // path where binding succeeded and signInWithOtp didn't error —
      // attach a no-op catch now so an early failure (bind or OTP) never
      // leaves it as an unhandled rejection in the meantime.
      pending.result.catch(() => {});
      try {
        await pending.listening;
      } catch (err) {
        logger.error('failed to start loopback callback server', { attemptId, err });
        throw err;
      }

      const { error: otpError } = await client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
      });
      if (otpError) {
        logger.error('signInWithOtp failed', { attemptId, err: otpError });
        pending.cancel();
        throw otpError;
      }

      let code, flowId;
      try {
        ({ code, flowId } = await pending.result);
      } catch (err) {
        logger.error('loopback callback failed', { attemptId, err });
        throw err;
      }

      const { error: exchangeError } = await client.auth.exchangeCodeForSession(
        code,
        flowId ? { flowId } : undefined
      );
      if (exchangeError) {
        logger.error('exchangeCodeForSession failed', { attemptId, err: exchangeError });
        throw exchangeError;
      }
      logger.info('sign-in complete', { attemptId });
    } finally {
      signInPending = false;
      // Push the settled status (cleared pending, and signedIn if the
      // exchange succeeded) to every other listener too — not just this
      // call's own caller, which already gets the outcome via this
      // promise settling.
      getStatus()
        .then(emit)
        .catch((err) => logger.error('failed to push post-sign-in status', { attemptId, err }));
    }
  }

  async function signOut() {
    const { error } = await client.auth.signOut();
    if (error) {
      // auth-js's own _signOut clears the local session even when the
      // server call fails (e.g. a network error), and still returns that
      // error. Throwing here regardless would tell the caller (and the
      // user, via main.js's log line / the Radar menu) "sign-out failed"
      // although they really are signed out locally — so only treat this
      // as a hard failure if the local session is *still* present.
      const status = await getStatus();
      if (!status.signedIn) {
        logger.warn('sign-out server call failed, but the local session was already cleared', {
          err: error,
        });
        return;
      }
      logger.error('sign-out failed', { err: error });
      throw error;
    }
    logger.info('signed out');
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function dispose() {
    listeners.clear();
    subscriptionData?.subscription?.unsubscribe();
  }

  return { signIn, signOut, getStatus, onChange, dispose };
}

module.exports = { createAuthService };
