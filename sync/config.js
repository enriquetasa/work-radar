'use strict';
/* ============================================================
   WORK RADAR — sync config resolution
   Sync/auth are entirely optional. This module decides whether they're
   configured at all, and from where — never from the repo (see the
   secrets rule): either two env vars, or a sync-config.json file the user
   drops into userData. If neither is present, the caller must treat the
   app as fully local, exactly as it behaved before Phase 3 (see
   docs/supabase-sync-plan.md).

   Pure and side-effect-free apart from the injected `readFileSync`, so
   it's unit-testable under node:test without touching the real
   filesystem or Electron's `app.getPath`.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const log = require('../logger');

// Resolves the Supabase URL + publishable key, or reports that sync is
// disabled. `env` and `readFileSync` are injected so tests can supply a
// fake env / fake file without touching the real process env or disk;
// `log` is injectable too — same pattern as callback-server.js and
// auth-service.js — so tests exercising the warn paths don't spam stdout.
function resolveSyncConfig({
  env = process.env,
  userDataDir,
  readFileSync = fs.readFileSync,
  log: logger = log,
} = {}) {
  const envUrl = (env.WORK_RADAR_SUPABASE_URL || '').trim();
  const envKey = (env.WORK_RADAR_SUPABASE_KEY || '').trim();
  if (envUrl && envKey) {
    return { configured: true, url: envUrl, publishableKey: envKey, source: 'env' };
  }

  if (userDataDir) {
    const configPath = path.join(userDataDir, 'sync-config.json');
    try {
      const raw = readFileSync(configPath, 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        logger.warn('sync-config.json is not valid JSON — sync disabled', {
          file: configPath,
          err: parseErr,
        });
        return { configured: false };
      }
      const url = typeof parsed.url === 'string' ? parsed.url.trim() : '';
      const publishableKey =
        typeof parsed.publishableKey === 'string' ? parsed.publishableKey.trim() : '';
      if (url && publishableKey) {
        return { configured: true, url, publishableKey, source: 'file' };
      }
      logger.warn('sync-config.json is missing url/publishableKey — sync disabled', {
        file: configPath,
      });
      return { configured: false };
    } catch (err) {
      // A missing file is the normal case when sync was never set up.
      // Anything else (permissions, etc.) is worth a log, but still just
      // disables sync rather than crashing the app.
      if (err.code !== 'ENOENT') {
        logger.warn('failed to read sync-config.json — sync disabled', { file: configPath, err });
      }
    }
  }
  return { configured: false };
}

module.exports = { resolveSyncConfig };
