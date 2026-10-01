'use strict';
const http = require('http');
const { parseCallbackRequest, CALLBACK_PATH } = require('./callback-request');
const defaultLog = require('../logger');

const HOST = '127.0.0.1';
const PORT = 54390;
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes, per the plan
const REDIRECT_TO = `http://${HOST}:${PORT}${CALLBACK_PATH}`;

// All callback responses use a locked-down CSP.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  'X-Content-Type-Options': 'nosniff',
};

// Escape provider-controlled query values before rendering HTML.
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );
}

// Bound reflected error text.
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

const SUCCESS_HTML = page('Work Radar', 'You can close this tab and return to Work Radar.');
function failureHtml(result) {
  const safe = escapeHtml(capped(result.errorDescription || result.error));
  return page('Work Radar', 'Sign-in failed: ' + safe);
}

// Listen for one callback; injectable timing and logging keep tests deterministic.
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
  // Result follows early bind failures too.
  listening.catch(() => {});

  const server = http.createServer((req, res) => {
    const parsed = parseCallbackRequest(req.url);
    if (parsed.notFound) {
      res.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    // This one-shot server must not retain keep-alive sockets.
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
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    } else {
      closeAndSettle();
    }
  }

  server.on('error', (err) => {
    if (!isListening) {
      // Report bind failures directly and never fall back to another port.
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
