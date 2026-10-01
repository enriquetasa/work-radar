'use strict';
// Reject pathological input before parsing or persistence.
const MAX_KEY_LENGTH_BYTES = 2048;

const PUBLISHABLE_KEY_RE = /^sb_publishable_[A-Za-z0-9_-]+$/;
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
  // Reject secret material anywhere in the input, including appended lines.
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
