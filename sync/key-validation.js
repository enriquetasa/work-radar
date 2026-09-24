'use strict';
/* ============================================================
   WORK RADAR — Supabase publishable key validation
   Guards the one place a user can ever put a Supabase key into this
   app: the first-run "add your key" prompt (see main.js's
   syncConfig:saveKey handler). Validated here in the main process, not
   only in the renderer, since the renderer's own check is trivially
   bypassable and this is the one gate between a pasted string and a
   file that gets read on every future startup.

   Accepts:
   - `sb_publishable_...` — the current Supabase publishable-key format.
   - a legacy anon JWT — three dot-separated base64url segments whose
     payload has `role: 'anon'`.

   Rejects, with a clear message, and NEVER treats as ok:
   - `sb_secret_...` — a secret key.
   - a JWT whose payload role is `service_role`.
   - anything else that isn't recognizably one of the two accepted
     shapes above.

   Only the publishable key is meant to ever ship in this app (see
   docs/supabase-sync-plan.md — "Only the publishable key ships in the
   app... RLS is what protects the data"), so a secret/service key
   reaching sync-config.json would defeat that entirely; this is the
   gate that stops it before anything is written to disk.

   Every accepted shape is matched against the WHOLE string (anchored
   regexes, not startsWith/split-and-hope) — a review found the previous
   prefix-only checks could be bypassed by smuggling extra content
   alongside an otherwise-accepted shape (a secret key appended after a
   newline or space, a bare prefix with nothing after it, a JWT-shaped
   string with an empty segment, ...). See
   test/sync-key-validation.test.js's dedicated regression tests for each
   bypass this found.

   Pure, no IO, no logging of the key itself — callers (main.js) must
   redact it too.
   ============================================================ */

// A real Supabase key is at most a few hundred bytes; this is a generous
// upper bound purely to reject pathological input before it's ever
// written to disk or repeatedly re-parsed as JSON.
const MAX_KEY_LENGTH_BYTES = 2048;

// Anchored to the whole string (^...$, no multiline flag) so trailing
// garbage — another key smuggled in after a newline or space, for
// instance — can never sneak past a prefix-only check.
const PUBLISHABLE_KEY_RE = /^sb_publishable_[A-Za-z0-9_-]+$/;
// Exactly three non-empty, base64url-alphabet segments — rejects a
// JWT-shaped string with an empty header/payload/signature segment,
// which `split('.').length === 3` alone would happily accept.
const JWT_SHAPE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function decodeJwtPayload(token) {
  const parts = token.split('.');
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function validatePublishableKey(rawKey) {
  const key = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (!key) {
    return { ok: false, error: 'Enter a publishable key.' };
  }
  if (Buffer.byteLength(key, 'utf8') > MAX_KEY_LENGTH_BYTES) {
    return { ok: false, error: 'That key is too long to be a real Supabase key.' };
  }
  // Checked as a substring, anywhere — not just as a prefix — since a
  // secret key can be smuggled in after a newline/space alongside an
  // otherwise-valid-looking publishable key or JWT (found in review).
  if (key.includes('sb_secret_')) {
    return {
      ok: false,
      error:
        'That looks like a secret key, not a publishable key — never paste a secret key into Work Radar.',
    };
  }
  if (PUBLISHABLE_KEY_RE.test(key)) {
    return { ok: true, key };
  }

  if (JWT_SHAPE_RE.test(key)) {
    const payload = decodeJwtPayload(key);
    if (payload && typeof payload.role === 'string') {
      if (payload.role === 'service_role') {
        return {
          ok: false,
          error:
            'That looks like a service_role key, not a publishable/anon key — never paste a service key into Work Radar.',
        };
      }
      if (payload.role === 'anon') {
        return { ok: true, key };
      }
      return {
        ok: false,
        error: `Unrecognized key role "${payload.role}" — expected a publishable or anon key.`,
      };
    }
  }

  return {
    ok: false,
    error: 'That does not look like a valid Supabase publishable or anon key.',
  };
}

module.exports = { validatePublishableKey };
