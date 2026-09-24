'use strict';
/* ============================================================
   WORK RADAR — realtime sync trigger (Phase 6)
   Subscribes to postgres_changes on public.items and public.log_entries
   for the signed-in user and turns every event into a call to the sync
   engine's own coalescing trigger (triggerNow) — see
   docs/supabase-sync-plan.md → "Phase 6 notes (realtime)". This module
   never reads or merges a change payload itself: the plan's whole point
   is a single ingest path, so a realtime event just means "something
   changed, pull now the normal way", exactly like the 60s interval or a
   window focus.

   `client` is the same supabase-js instance main.js already built for
   auth/sync (see main.js's buildAuthService()/buildSyncEngine()) — not a
   second client. Reusing it is also what keeps the realtime socket
   authorized: supabase-js's own SupabaseClient wires
   auth.onAuthStateChange to realtime.setAuth(accessToken) internally, so
   a token refresh on the shared client re-authorizes the same socket
   this module subscribed on, with no extra code here.

   `onChange` is injected — main.js wires it to
   `() => syncEngine.triggerNow()` — so this module never depends on
   sync-engine.js directly and is testable with a fake client/channel;
   see test/sync-realtime.test.js. RLS applies to the changefeed itself
   (see the add_tables_to_realtime_publication migration's own comment),
   so no per-user filter is added to the subscription: Realtime only
   ever delivers rows this connection's RLS policies already allow it to
   select.
   ============================================================ */

const crypto = require('crypto');
const defaultLog = require('../logger');

function createRealtimeSync(options = {}) {
  const { client, onChange, log = defaultLog } = options;

  if (!client) throw new Error('createRealtimeSync requires a client');
  if (typeof onChange !== 'function') {
    throw new Error('createRealtimeSync requires an onChange callback');
  }

  // Fire-and-forget wrapper around `onChange` (normally
  // syncEngine.triggerNow, which is async and already coalesces
  // overlapping calls into at most one cycle). Every call site below is
  // an event callback that can't be awaited, so a rejection here would
  // otherwise become an unhandled rejection with no channel/user
  // context — same pattern as main.js's focus handler and
  // sync-engine.js's own timer callbacks.
  function fireOnChange(context) {
    Promise.resolve()
      .then(() => onChange())
      .catch((err) => log.error('realtime: onChange callback failed', { ...context, err }));
  }

  // The one subscription this module ever holds, or null. Kept as a
  // single object (rather than separate `channel`/`userId` variables) so
  // a callback captured by a closure over a *previous* `entry` can tell
  // it has been superseded — see the `current !== entry` checks below —
  // instead of racing a stale event against a freshly (re-)subscribed
  // channel.
  let current = null;

  // Subscribes for `userId`. If a channel is already open — a re-sign-in
  // or an account switch landing before the previous sign-out's
  // unsubscribe ran, e.g. from a caller that doesn't itself guarantee
  // stop()-then-start() ordering — the old one is torn down first so no
  // channel is ever leaked.
  function subscribe(userId) {
    if (!userId) throw new Error('realtime.subscribe requires a userId');
    if (current) {
      log.warn('realtime: subscribe called while a channel was already open — replacing it', {
        userId,
        previousUserId: current.userId,
        previousChannelId: current.channelId,
      });
      unsubscribe();
    }

    // Correlates every log line this one channel produces — subscribe,
    // status changes, the events it triggers, unsubscribe — the same
    // pattern as auth-service.js's attemptId and sync-engine.js's
    // cycleId.
    const channelId = crypto.randomUUID();
    const entry = { channel: null, userId, channelId, closing: false };
    current = entry;

    const onTableChange = (table) => (payload) => {
      // A late event from a channel this module has since replaced or
      // torn down — ignore rather than trigger a pull for a session
      // that's no longer current.
      if (current !== entry) return;
      log.debug('realtime: change event received — triggering a pull', {
        userId,
        channelId,
        table,
        eventType: payload && payload.eventType,
      });
      // Never reads payload beyond logging its event type — the pull
      // that follows is what actually fetches the row, per the plan's
      // "single ingest path" requirement.
      fireOnChange({ userId, channelId, table });
    };

    log.info('realtime: subscribing', { userId, channelId });
    // The topic carries channelId, not just userId (found in review): a
    // fixed per-user topic means `client.channel(topic)` can hand a
    // subscribe() call the SAME channel a not-yet-finished unsubscribe()
    // is still leaving — its leave() is async and the old channel isn't
    // de-registered until the server acks it, so a same-user
    // re-subscribe landing in that window got a channel whose
    // postgres_changes bindings were already taken (real realtime-js
    // drops a duplicate filter binding rather than adding a second one),
    // leaving the new subscription's callbacks never registered — no
    // catch-up, no events, no warning. A unique topic per subscription
    // means client.channel() never sees a repeat topic in the first
    // place, and it also stops the old leave's eventual _remove() (which
    // filters by topic) from de-registering a newer channel that
    // happened to share one. See test/sync-realtime.test.js's "reused
    // topic" test and docs/supabase-sync-plan.md's Phase 6 notes.
    entry.channel = client
      .channel(`work-radar-sync:${userId}:${channelId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'items' },
        onTableChange('items')
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'log_entries' },
        onTableChange('log_entries')
      )
      .subscribe((status, err) => {
        // A CLOSED from a channel this module itself tore down via
        // unsubscribe() — checked before the `current !== entry` guard
        // below, since unsubscribe() always clears `current` (and sets
        // `entry.closing`) synchronously, well before this async status
        // callback can fire. Without this check first, `current !==
        // entry` would already be true by then and swallow the event,
        // so this branch would never run (found in review).
        if (status === 'CLOSED' && entry.closing) {
          log.debug('realtime: channel closed (unsubscribe requested)', { userId, channelId });
          return;
        }
        // A status callback from a channel this module has already
        // replaced/torn down (e.g. a superseded subscribe()'s SUBSCRIBED
        // arriving after a fresh subscribe() already installed a new
        // `entry`) — ignore it rather than act on a superseded channel.
        if (current !== entry) return;
        if (status === 'SUBSCRIBED') {
          // Catch up on anything missed while disconnected (a dropped
          // socket, the app being asleep, ...) — a normal pull, not a
          // trust of any buffered payload.
          log.info('realtime: subscribed — triggering a catch-up pull', { userId, channelId });
          fireOnChange({ userId, channelId, reason: 'subscribed' });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // Logged, not retried here: supabase-js reconnects on its own,
          // and the sync engine's existing 60s interval is the safety
          // net if it doesn't — building a second, unbounded retry loop
          // on top of that would just be two things racing to recover
          // the same socket.
          log.warn('realtime: channel status', { userId, channelId, status, err });
        } else if (status === 'CLOSED') {
          log.warn('realtime: channel closed unexpectedly', { userId, channelId });
        }
      });
  }

  // Idempotent no-op when nothing is subscribed (sign-out with sync
  // never started, or a second stop() call) — mirrors sync-engine.js's
  // own start()/stop().
  function unsubscribe() {
    if (!current) return;
    const entry = current;
    current = null;
    entry.closing = true;
    log.info('realtime: unsubscribing', { userId: entry.userId, channelId: entry.channelId });
    Promise.resolve(client.removeChannel(entry.channel))
      .then((result) => {
        if (result !== 'ok') {
          log.warn('realtime: removeChannel did not report ok', {
            userId: entry.userId,
            channelId: entry.channelId,
            result,
          });
          // supabase-js's own removeChannel() only calls
          // channel.teardown() when the leave resolves 'ok' (a
          // 'timed out' closes the channel locally on its own, but any
          // other non-'ok' result — e.g. an 'error' — leaves it neither
          // torn down nor removed, still holding its timers/bindings on
          // the shared client). Do that ourselves rather than leak it
          // (found in review).
          try {
            entry.channel.teardown();
          } catch (teardownErr) {
            log.error('realtime: channel.teardown() failed after a non-ok removeChannel result', {
              userId: entry.userId,
              channelId: entry.channelId,
              err: teardownErr,
            });
          }
        }
      })
      .catch((err) =>
        log.error('realtime: removeChannel failed', {
          userId: entry.userId,
          channelId: entry.channelId,
          err,
        })
      );
  }

  return { subscribe, unsubscribe };
}

module.exports = { createRealtimeSync };
