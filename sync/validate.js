'use strict';
// Deliberately permissive (not a full RFC 5322 check) — good enough to
// reject obvious garbage before it reaches signInWithOtp, which is the
// thing that actually knows whether an address is real.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 320 && EMAIL_RE.test(value.trim());
}

module.exports = { isValidEmail };
