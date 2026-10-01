'use strict';
const defaultLog = require('../logger');

// Wait for auth initialization before stopping auto-refresh; otherwise its timer can start after cleanup.
function stopAutoRefreshOnceReady(client, logger) {
  try {
    const ready =
      typeof client.auth.initialize === 'function'
        ? Promise.resolve(client.auth.initialize())
        : Promise.resolve();
    return ready
      .then(() => client.auth.stopAutoRefresh())
      .catch((err) => {
        logger.error('failed to stop auto-refresh after a failed initSyncAndAuth()', { err });
      });
  } catch (err) {
    logger.error('failed to stop auto-refresh after a failed initSyncAndAuth()', { err });
    return Promise.resolve();
  }
}

function disposeFailedAuthAttempt({ service, client, log: logger = defaultLog } = {}) {
  if (service && typeof service.dispose === 'function') {
    try {
      service.dispose();
    } catch (err) {
      logger.error('failed to dispose the auth service after a failed initSyncAndAuth()', { err });
    }
  }
  if (!client || !client.auth || typeof client.auth.stopAutoRefresh !== 'function') {
    return Promise.resolve();
  }
  return stopAutoRefreshOnceReady(client, logger);
}

module.exports = { disposeFailedAuthAttempt };
