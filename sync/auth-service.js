'use strict';

const crypto = require('crypto');
const log = require('../logger');

// Carry userId with the auth event so realtime never needs a racy second session read.
function toStatus(session, pending) {
  return {
    signedIn: !!session,
    email: session?.user?.email ?? null,
    userId: session?.user?.id ?? null,
    pending,
  };
}

function createAuthService({ client, waitForCallback, redirectTo, log: logger = log }) {
  const listeners = new Set();
  let signInPending = false;

  function emit(status) {
    for (const fn of listeners) {
      try {
        fn(status);
      } catch (err) {
        logger.error('auth state change listener threw', { err });
      }
    }
  }

  const { data: subscriptionData } = client.auth.onAuthStateChange((event, session) => {
    logger.info('auth state changed', { event, signedIn: !!session });
    emit(toStatus(session, signInPending));
  });

  async function getStatus() {
    const { data, error } = await client.auth.getSession();
    if (error) {
      logger.warn('failed to read current session', { err: error });
      return { signedIn: false, email: null, userId: null, pending: signInPending };
    }
    return toStatus(data.session, signInPending);
  }

  async function signIn(email) {
    if (signInPending) {
      throw new Error('a sign-in is already pending — finish or wait for it to time out first');
    }
    // Claim the attempt before the first await so concurrent submissions cannot pass.
    signInPending = true;
    const attemptId = crypto.randomUUID();
    try {
      const existing = await getStatus();
      if (existing.signedIn) {
        throw new Error('already signed in — sign out first');
      }
      logger.info('sign-in attempt started', { attemptId });
      emit({ signedIn: false, email: null, userId: null, pending: true });
      // Bind the callback port before sending an email.
      const pending = waitForCallback();
      // Observe early rejection now; the result is awaited after the email is sent.
      pending.result.catch(() => {});
      try {
        await pending.listening;
      } catch (err) {
        logger.error('failed to start loopback callback server', { attemptId, err });
        throw err;
      }

      const { error: otpError } = await client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
      });
      if (otpError) {
        logger.error('signInWithOtp failed', { attemptId, err: otpError });
        pending.cancel();
        throw otpError;
      }

      let code, flowId;
      try {
        ({ code, flowId } = await pending.result);
      } catch (err) {
        logger.error('loopback callback failed', { attemptId, err });
        throw err;
      }

      const { error: exchangeError } = await client.auth.exchangeCodeForSession(
        code,
        flowId ? { flowId } : undefined
      );
      if (exchangeError) {
        logger.error('exchangeCodeForSession failed', { attemptId, err: exchangeError });
        throw exchangeError;
      }
      logger.info('sign-in complete', { attemptId });
    } finally {
      signInPending = false;
      getStatus()
        .then(emit)
        .catch((err) => logger.error('failed to push post-sign-in status', { attemptId, err }));
    }
  }

  async function signOut() {
    const { error } = await client.auth.signOut();
    if (error) {
      // auth-js can return an error after it has already cleared the local session.
      const status = await getStatus();
      if (!status.signedIn) {
        logger.warn('sign-out server call failed, but the local session was already cleared', {
          err: error,
        });
        return;
      }
      logger.error('sign-out failed', { err: error });
      throw error;
    }
    logger.info('signed out');
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function dispose() {
    listeners.clear();
    subscriptionData?.subscription?.unsubscribe();
  }

  return { signIn, signOut, getStatus, onChange, dispose };
}

module.exports = { createAuthService };
