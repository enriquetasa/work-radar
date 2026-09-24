'use strict';
/* ============================================================
   WORK RADAR — sync lifecycle (Phase 6 fix)
   Owns the "which auth status transitions start/stop the sync engine
   and subscribe/unsubscribe realtime" decision that used to live inline
   in main.js's authService.onChange handler. Extracted (found in
   review) so it's a plain, dependency-injected module — same split as
   sync/auth-service.js and sync/sync-engine.js — testable under
   node:test without Electron; see test/sync-lifecycle.test.js.

   This closes a subscribe-after-sign-out race the inline version had:
   main.js used to resolve the realtime userId via its own extra
   `client.auth.getSession()` call, made *after* deciding to subscribe,
   with nothing re-checking that the session was still signed in by the
   time that read resolved. A sign-out landing in that async gap left
   `syncEngine.stop()`/`realtimeSync.unsubscribe()` running against a
   channel that didn't exist yet, and the since-superseded subscribe()
   call still went ahead and opened one anyway — a channel that then
   stayed open, signed out, until the next sign-in replaced it.

   The fix is to have no gap to race at all: sync/auth-service.js's
   toStatus() now puts `userId` on the very same status object that
   carries `signedIn`, straight off the session onAuthStateChange/
   getSession already read — see its own doc comment. `handleAuthStatus`
   below is called synchronously with that one object, so "is this
   still the current session" is never in question.

   main.js is the only caller: it builds this once (alongside
   syncEngine/realtimeSync) and calls handleAuthStatus() from
   authService.onChange, exactly where the inline version used to run.
   ============================================================ */

const defaultLog = require('../logger');

function createSyncLifecycle({ engine, realtime, log = defaultLog } = {}) {
  if (!engine) throw new Error('createSyncLifecycle requires an engine');
  if (!realtime) throw new Error('createSyncLifecycle requires a realtime sync');

  // Mirrors main.js's own former `syncEngineRunning` flag — true only
  // between a signedIn transition and the matching signedOut one, never
  // toggled by a same-state event (e.g. a token refresh).
  let running = false;

  // The userId realtime is currently subscribed for (or null, while not
  // running, or while running started without one — see the defensive
  // branch below). Tracked so a later signedIn status carrying a
  // *different* userId — a real "switch account" flow, or simply a
  // userId becoming available after we started without one — can
  // re-subscribe instead of silently keeping the previous channel open
  // under the wrong topic/log context (found in review; nothing in
  // today's auth-service produces this, since signIn() refuses while a
  // session already exists, but the lifecycle's contract shouldn't rely
  // on that).
  let subscribedUserId = null;

  function subscribeFor(userId, status) {
    if (userId) {
      // `subscribedUserId` is only set once `subscribe()` actually
      // succeeds (found in review). Setting it first would leave the
      // lifecycle believing it's subscribed even when it threw — e.g.
      // `client.channel()`/`.on()` failing — and since `subscribe()`
      // isn't retried on every signedIn event (only on the running
      // transition or a userId change), that session would never get
      // realtime for the rest of its life, with the exception itself
      // escaping up into auth-service's generic "listener threw" log,
      // which carries no userId. Catching it here means sync itself
      // (engine.start(), already run by the caller) still works, and
      // the next signedIn status for this same user — leaving
      // `subscribedUserId` unset means it still differs from `userId` —
      // retries the subscribe instead of silently giving up on it.
      try {
        realtime.subscribe(userId);
        subscribedUserId = userId;
      } catch (err) {
        log.error('realtime: subscribe() threw — realtime not subscribed for this session', {
          userId,
          err,
        });
      }
    } else {
      // Defensive only: toStatus() always fills userId off the same
      // session object that makes signedIn true, so a real session
      // with no userId shouldn't happen. Unlike the old async-read
      // version, there's no separate retry needed here — the next
      // status carrying a userId (a fresh sign-in, or this same session
      // catching up) will subscribe normally; this only ever logs for a
      // session that was signed in without ever getting realtime.
      //
      // `hasEmail`, never `email` itself — the email is PII and the
      // rest of the codebase (main.js's auth:signIn handler,
      // auth-service.js) deliberately never logs it either (found in
      // review).
      log.warn('signed in but the status carried no userId — realtime not subscribed', {
        hasEmail: !!status.email,
      });
    }
  }

  // Sync only ever runs while signed in (see docs/supabase-sync-plan.md's
  // "Local-first" note). `engine.start()`/`stop()` are both idempotent,
  // so calling them on every status is safe — including the hourly
  // TOKEN_REFRESHED event, which still reports signedIn:true.
  // `realtime.subscribe()` is *not* idempotent the same way (it tears
  // down and rebuilds the channel), so it's only called on the
  // `wasRunning -> running` transition, or when an already-running
  // session's userId changes — not on every signedIn status — see
  // docs/supabase-sync-plan.md's Phase 6 notes.
  function handleAuthStatus(status) {
    if (status.signedIn) {
      const wasRunning = running;
      running = true;
      engine.start();
      if (!wasRunning) {
        subscribeFor(status.userId, status);
      } else if (status.userId && status.userId !== subscribedUserId) {
        log.info('realtime: signed-in userId changed while running — re-subscribing', {
          previousUserId: subscribedUserId,
          userId: status.userId,
        });
        subscribeFor(status.userId, status);
      }
    } else if (running) {
      running = false;
      subscribedUserId = null;
      engine.stop();
      realtime.unsubscribe();
    }
  }

  function isRunning() {
    return running;
  }

  return { handleAuthStatus, isRunning };
}

module.exports = { createSyncLifecycle };
