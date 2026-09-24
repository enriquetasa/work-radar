'use strict';
/* Pure decision logic for renderer/app.js's Auth.render() — see
   renderer/auth-view.js's doc comment for why the signed-out/not-pending
   branch must never clear #auth-error. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeAuthView } = require('../renderer/auth-view.js');

test('signed in: shows the signed-in panel and clears any stale error', () => {
  assert.deepEqual(computeAuthView({ signedIn: true, email: 'a@example.com', pending: false }), {
    form: false,
    pending: false,
    signedIn: true,
    clearError: true,
  });
});

test('pending: shows the CHECK YOUR INBOX panel and clears any stale error', () => {
  assert.deepEqual(computeAuthView({ signedIn: false, email: null, pending: true }), {
    form: false,
    pending: true,
    signedIn: false,
    clearError: true,
  });
});

test('signed out and not pending: shows the form and leaves an existing error alone', () => {
  // This is the state a *failed* sign-in settles into (see
  // sync/auth-service.js's signIn() finally block) — clearing the error
  // here would erase the message Auth.showError() just displayed before
  // this settled push arrives. Only submit(), starting a fresh attempt,
  // clears it.
  assert.deepEqual(computeAuthView({ signedIn: false, email: null, pending: false }), {
    form: true,
    pending: false,
    signedIn: false,
    clearError: false,
  });
});
