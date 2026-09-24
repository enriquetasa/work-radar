'use strict';
/* ============================================================
   WORK RADAR — sync config resolution
   Sync/auth need a Supabase project URL and a publishable key. The URL
   has a built-in default (DEFAULT_SUPABASE_URL below — a public project
   URL, which the secrets rule treats as non-sensitive config safe to
   commit); the publishable key never does, and must come from the user
   — either an env var, a sync-config.json file dropped into userData,
   or the first-run "add your key" prompt (see main.js's
   syncConfig:saveKey handler and sync/sync-config-store.js), which
   writes into that same file.

   Resolution order for each field, independently:
     URL:            WORK_RADAR_SUPABASE_URL > sync-config.json "url" > DEFAULT_SUPABASE_URL
     Publishable key: WORK_RADAR_SUPABASE_KEY > sync-config.json "publishableKey" > (none)

   Sync is only "configured" once a key is found from *some* source — no
   key means the caller must treat the app as fully local (see
   docs/supabase-sync-plan.md), but the resolved `url` is still returned
   even when disabled, so the key prompt and a later save know which
   project a saved key would apply to.

   Pure and side-effect-free apart from the injected `readFileSync`, so
   it's unit-testable under node:test without touching the real
   filesystem or Electron's `app.getPath`.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { validatePublishableKey } = require('./key-validation');

// Public project URL, not a secret (see the secrets rule) — ships in the
// repo so sync can be pointed at a real project without the user ever
// typing a URL. The publishable key itself is never hardcoded here or
// anywhere else.
const DEFAULT_SUPABASE_URL = 'https://kqoudumymsmvstrfrxyz.supabase.co';

// Reads {url, publishableKey} out of <userDataDir>/sync-config.json,
// tolerantly: a missing file is the normal case (sync never configured,
// or the key prompt just hasn't been filled in yet) and returns empty
// strings silently; a real problem (corrupt JSON, a permissions error)
// still logs a warning but degrades the same way rather than throwing —
// sync-config.json is a user-editable file, so a mistake in it must
// never crash the app. Deliberately does NOT warn when the file merely
// lacks one of the two fields (e.g. a url with no key yet) — that's an
// expected, common shape now, not an error.
function readSyncConfigFile(userDataDir, readFileSync, logger) {
  if (!userDataDir) return { url: '', publishableKey: '' };
  const configPath = path.join(userDataDir, 'sync-config.json');
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn('failed to read sync-config.json — ignoring it', { file: configPath, err });
    }
    return { url: '', publishableKey: '' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    logger.warn('sync-config.json is not valid JSON — ignoring it', {
      file: configPath,
      err: parseErr,
    });
    return { url: '', publishableKey: '' };
  }
  // A bare JSON `null` (valid JSON!) or any other non-object value
  // (a number, a string, an array, ...) would otherwise throw a
  // TypeError on the property access below — found in review: that
  // escaped resolveSyncConfig entirely, and at startup meant no window
  // ever opened. Treated the same as "file present but empty".
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn('sync-config.json must be a JSON object — ignoring it', { file: configPath });
    return { url: '', publishableKey: '' };
  }
  return {
    url: typeof parsed.url === 'string' ? parsed.url.trim() : '',
    publishableKey: typeof parsed.publishableKey === 'string' ? parsed.publishableKey.trim() : '',
  };
}

// Runs a candidate key (from an env var or sync-config.json — neither is
// validated at the point it's read) through sync/key-validation.js.
// Never logs the key itself, only the rejection reason and where it came
// from — a secret/service key typed into an env var or hand-edited into
// the file is exactly as dangerous as one pasted into the startup
// prompt, so it must be rejected the same way (found in review).
function validateCandidateKey(candidate, source, logger) {
  if (!candidate) return '';
  const validation = validatePublishableKey(candidate);
  if (!validation.ok) {
    logger.warn(`${source} publishableKey failed validation — ignoring it`, {
      reason: validation.error,
    });
    return '';
  }
  return validation.key;
}

// Resolves the Supabase URL + publishable key, or reports that sync is
// disabled (still carrying the resolved `url`, per the module doc
// comment above). `env` and `readFileSync` are injected so tests can
// supply a fake env / fake file without touching the real process env
// or disk; `log` is injectable too — same pattern as callback-server.js
// and auth-service.js — so tests exercising the warn paths don't spam
// stdout.
function resolveSyncConfig({
  env = process.env,
  userDataDir,
  readFileSync = fs.readFileSync,
  log: logger = log,
} = {}) {
  const envUrl = (env.WORK_RADAR_SUPABASE_URL || '').trim();
  // Validated before anything else — a rejected env key must never win
  // over a valid key saved in the file (that would trap the user in a
  // prompt loop: saving a good key would never actually take effect on
  // the next launch, since env "wins" on paper), and must never be used
  // as-is either way.
  const envKey = validateCandidateKey(
    (env.WORK_RADAR_SUPABASE_KEY || '').trim(),
    'WORK_RADAR_SUPABASE_KEY',
    logger
  );
  if (envUrl && envKey) {
    // Fully configured by env vars alone — never touch sync-config.json,
    // so an env-configured run (CI, a container without a writable
    // userData) never depends on that file existing at all.
    return { configured: true, url: envUrl, publishableKey: envKey, source: 'env' };
  }

  const file = readSyncConfigFile(userDataDir, readFileSync, logger);
  const fileKey = validateCandidateKey(file.publishableKey, 'sync-config.json', logger);
  const url = envUrl || file.url || DEFAULT_SUPABASE_URL;
  const publishableKey = envKey || fileKey;

  if (publishableKey) {
    return { configured: true, url, publishableKey, source: envKey ? 'env' : 'file' };
  }
  return { configured: false, url };
}

module.exports = { resolveSyncConfig, DEFAULT_SUPABASE_URL };
