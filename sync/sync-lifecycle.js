'use strict';

const defaultLog = require('../logger');

function createSyncLifecycle({ engine, realtime, log = defaultLog } = {}) {
  if (!engine) throw new Error('createSyncLifecycle requires an engine');
  if (!realtime) throw new Error('createSyncLifecycle requires a realtime sync');

  let running = false;

  // Track the channel owner independently from the engine running state.
  let subscribedUserId = null;

  function subscribeFor(userId, status) {
    if (userId) {
      try {
        // Record success only after subscribe returns.
        realtime.subscribe(userId);
        subscribedUserId = userId;
      } catch (err) {
        log.error('realtime: subscribe() threw — realtime not subscribed for this session', {
          userId,
          err,
        });
      }
    } else {
      log.warn('signed in but the status carried no userId — realtime not subscribed', {
        hasEmail: !!status.email,
      });
    }
  }

  // Rebuild realtime only on sign-in or account change, not token refreshes.
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
