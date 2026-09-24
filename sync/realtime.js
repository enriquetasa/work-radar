'use strict';

const crypto = require('crypto');
const defaultLog = require('../logger');

function createRealtimeSync(options = {}) {
  const { client, onChange, log = defaultLog } = options;

  if (!client) throw new Error('createRealtimeSync requires a client');
  if (typeof onChange !== 'function') {
    throw new Error('createRealtimeSync requires an onChange callback');
  }

  // Event callbacks cannot await the sync trigger, so contain rejected promises here.
  function fireOnChange(context) {
    Promise.resolve()
      .then(() => onChange())
      .catch((err) => log.error('realtime: onChange callback failed', { ...context, err }));
  }

  // Object identity lets stale channel callbacks recognize that they were replaced.
  let current = null;

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

    const channelId = crypto.randomUUID();
    const entry = { channel: null, userId, channelId, closing: false };
    current = entry;

    const onTableChange = (table) => (payload) => {
      if (current !== entry) return;
      log.debug('realtime: change event received — triggering a pull', {
        userId,
        channelId,
        table,
        eventType: payload && payload.eventType,
      });
      fireOnChange({ userId, channelId, table });
    };

    log.info('realtime: subscribing', { userId, channelId });
    // A unique topic avoids colliding with a channel that is still leaving.
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
        // Check intentional closure before rejecting callbacks from stale entries.
        if (status === 'CLOSED' && entry.closing) {
          log.debug('realtime: channel closed (unsubscribe requested)', { userId, channelId });
          return;
        }
        if (current !== entry) return;
        if (status === 'SUBSCRIBED') {
          log.info('realtime: subscribed — triggering a catch-up pull', { userId, channelId });
          fireOnChange({ userId, channelId, reason: 'subscribed' });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          log.warn('realtime: channel status', { userId, channelId, status, err });
        } else if (status === 'CLOSED') {
          log.warn('realtime: channel closed unexpectedly', { userId, channelId });
        }
      });
  }

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
          // removeChannel only tears down automatically when it returns ok.
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
