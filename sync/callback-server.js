'use strict';
/* ============================================================
   WORK RADAR — loopback callback server
   Thin node:http wiring around callback-request.js's pure parsing (see
   docs/supabase-sync-plan.md → "Sign-in flow"). Binds 127.0.0.1 only,
   runs only while a sign-in is pending, and closes itself after the
   first callback (success or failure) or after `timeoutMs`.

   Never falls back to a different port on EADDRINUSE — the redirect
   allow-list in Supabase (site_url / additional_redirect_urls) is an
   exact match on this port, so silently picking another one would just
   make the redirect fail instead.

   `waitForCallback()` returns `{ listening, result, cancel }` rather than
   a single promise: `listening` settles as soon as the port is bound (or
   rejects on EADDRINUSE, with a clear message), so a caller — see
   sync/auth-service.js — can confirm the server is actually up *before*
   sending a magic-link email that can't be recovered if the bind fails.
   `result` settles the way the old single promise used to: with the
   parsed callback, or a rejection (Supabase error, timeout, or a
   post-bind server error). `cancel()` settles `result` as 'cancelled'
   without a request ever arriving, for a caller that needs to give up
   early (e.g. signInWithOtp itself failing after the server is already
   listening).
   ============================================================ */

const http = require('http');
const { parseCallbackRequest, CALLBACK_PATH } = require('./callback-request');
const defaultLog = require('../logger');

const HOST = '127.0.0.1';
const PORT = 54390;
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes, per the plan
const REDIRECT_TO = `http://${HOST}:${PORT}${CALLBACK_PATH}`;

// Applied to every response this server ever sends (success, failure or
// 404) as defence in depth alongside escaping — this origin never needs
// to load anything, run inline script, or have its content type sniffed.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  'X-Content-Type-Options': 'nosniff',
};

// Bare `&<>"'` escaping — result.error / result.errorDescription come
// straight off the query string an attacker fully controls (see the
// module doc comment), so this must run before either ever reaches the
// HTML string below.
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );
}

// A real error/error_description is short. Capping before escaping keeps
// a maliciously long payload from bloating the response either way.
const MAX_REFLECTED_LEN = 300;
function capped(value) {
  return String(value).slice(0, MAX_REFLECTED_LEN);
}

function page(title, message) {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>' +
    title +
    '</title></head><body style="font-family:monospace;background:#010805;color:#00e676;' +
    'display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
    '<p>' +
    message +
    '</p></body></html>'
  );
}

// The plan's wording, deliberately not "signed in" — this page is served
// as soon as the redirect lands, before exchangeCodeForSession has run.
const SUCCESS_HTML = page('Work Radar', 'You can close this tab and return to Work Radar.');
function failureHtml(result) {
  const safe = escapeHtml(capped(result.errorDescription || result.error));
  return page('Work Radar', 'Sign-in failed: ' + safe);
}

// Listens for exactly one Supabase redirect. `port`/`timeoutMs` are
// injectable so tests can use a short timeout and (in dedicated tests)
// provoke EADDRINUSE deterministically; `log` is injectable so tests
// don't spam stdout/stderr with this module's own structured logs.
function waitForCallback({
  port = PORT,
  host = HOST,
  timeoutMs = TIMEOUT_MS,
  log: logger = defaultLog,
} = {}) {
  let settled = false;
  let isListening = false;
  let timer = null;
  let resolveListening, rejectListening;
  const listening = new Promise((resolve, reject) => {
    resolveListening = resolve;
    rejectListening = reject;
  });
  let resolveResult, rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // `listening` rejecting is itself a valid way for `result` to settle
  // (nobody should await `result` without it ever resolving), so give it
  // a no-op catch here — the real rejection is observed via `listening`.
  listening.catch(() => {});

  const server = http.createServer((req, res) => {
    const parsed = parseCallbackRequest(req.url);
    if (parsed.notFound) {
      res.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    // 'Connection: close' — this is a one-shot server, about to shut
    // itself down; without it, a keep-alive socket can hold server.close()
    // pending for its idle timeout instead of settling right away.
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      Connection: 'close',
    });
    res.end(parsed.ok ? SUCCESS_HTML : failureHtml(parsed));
    finish(parsed);
  });

  function finish(parsed) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const closeAndSettle = () => {
      if (parsed.ok) {
        resolveResult({ code: parsed.code, flowId: parsed.flowId ?? null });
      } else {
        rejectResult(
          Object.assign(new Error(parsed.errorDescription || parsed.error), {
            code: parsed.error,
          })
        );
      }
    };
    if (server.listening) {
      server.close(closeAndSettle);
      // Node 18.2+: without this, a lingering (e.g. preconnect) socket can
      // hold server.close()'s callback pending past the sign-in that just
      // finished.
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    } else {
      closeAndSettle();
    }
  }

  server.on('error', (err) => {
    if (!isListening) {
      // Never happened yet — this is a bind failure, not a mid-flight
      // server error. Map EADDRINUSE to a message the renderer can show
      // as-is, and never retry on another port (see the module doc
      // comment for why).
      if (err.code === 'EADDRINUSE') {
        logger.error('loopback callback port already in use — refusing to pick another one', {
          host,
          port,
          err,
        });
        rejectListening(
          Object.assign(
            new Error(`Port ${port} is in use by another program — close it and try again`),
            {
              code: 'EADDRINUSE',
            }
          )
        );
      } else {
        logger.error('loopback callback server failed to start', { host, port, err });
        rejectListening(err);
      }
      finish({ ok: false, error: err.code || 'server_error', errorDescription: err.message });
      return;
    }
    logger.error('loopback callback server error', { host, port, err });
    finish({ ok: false, error: err.code || 'server_error', errorDescription: err.message });
  });

  server.listen(port, host, () => {
    isListening = true;
    resolveListening();
    timer = setTimeout(() => {
      logger.warn('loopback callback timed out — no redirect arrived', { host, port, timeoutMs });
      finish({
        ok: false,
        error: 'timeout',
        errorDescription: 'no callback received within the sign-in window',
      });
    }, timeoutMs);
  });

  function cancel() {
    finish({ ok: false, error: 'cancelled', errorDescription: 'sign-in was cancelled' });
  }

  return { listening, result, cancel };
}

module.exports = { waitForCallback, HOST, PORT, TIMEOUT_MS, REDIRECT_TO };
