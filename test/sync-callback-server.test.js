'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { waitForCallback, HOST } = require('../sync/callback-server.js');

// A no-op logger so tests that exercise error/warn paths (EADDRINUSE,
// timeout) don't spam stdout/stderr with the module's own structured logs.
const silentLog = { debug() {}, info() {}, warn() {}, error() {}, critical() {} };

// Distinct from the real 54390 so these tests never collide with a
// developer's actual local stack, and each test gets its own port so
// they can run without waiting on each other.
let nextPort = 54490;
function freshPort() {
  return nextPort++;
}

test('resolves with the code from a successful redirect', async () => {
  const port = freshPort();
  const { listening, result } = waitForCallback({ port, timeoutMs: 5000 });
  await listening;
  const res = await fetch(`http://${HOST}:${port}/auth/callback?code=abc123`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /close this tab/i);
  const value = await result;
  assert.deepEqual(value, { code: 'abc123', flowId: null });
});

test('passes the sb_flow_id through when Supabase includes it', async () => {
  const port = freshPort();
  const { listening, result } = waitForCallback({ port, timeoutMs: 5000 });
  await listening;
  await fetch(`http://${HOST}:${port}/auth/callback?code=abc123&sb_flow_id=flow-xyz`);
  assert.deepEqual(await result, { code: 'abc123', flowId: 'flow-xyz' });
});

test('every response carries the loopback security headers', async () => {
  const port = freshPort();
  const { listening, result } = waitForCallback({ port, timeoutMs: 5000 });
  await listening;
  const res = await fetch(`http://${HOST}:${port}/auth/callback?code=abc123`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy') || '', /default-src 'none'/);
  await result;
});

test('rejects with the Supabase error on an error redirect', async () => {
  const port = freshPort();
  const { listening, result } = waitForCallback({ port, timeoutMs: 5000 });
  await listening;
  // `result` can reject as soon as the request below is sent, before this
  // test gets back around to `assert.rejects` a few lines down (the fetch
  // response body still has to come back over the wire) — attach a no-op
  // catch now so node doesn't flag it as unhandled in the meantime. The
  // real assertion below still sees the same rejection.
  result.catch(() => {});
  const res = await fetch(
    `http://${HOST}:${port}/auth/callback?error=access_denied&error_description=Link%20expired`
  );
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /failed/i);
  await assert.rejects(result, (err) => {
    assert.equal(err.code, 'access_denied');
    assert.equal(err.message, 'Link expired');
    return true;
  });
});

// The blocking security finding: error/error_description come straight off
// the query string, so a stray redirect to the loopback callback must never
// let them run as script in the response it renders.
test('escapes error_description in the failure page instead of reflecting it raw', async () => {
  const port = freshPort();
  const { listening, result } = waitForCallback({ port, timeoutMs: 5000 });
  await listening;
  result.catch(() => {});
  const res = await fetch(
    `http://${HOST}:${port}/auth/callback?error=x&error_description=` +
      encodeURIComponent('<script>alert(1)</script>')
  );
  const body = await res.text();
  assert.ok(!body.includes('<script>alert(1)</script>'), 'must not contain the raw payload');
  assert.ok(
    body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'),
    'must contain the escaped form'
  );
  await assert.rejects(result);
});

test('escapes the bare error code too, and caps an absurdly long description', async () => {
  const port = freshPort();
  const { listening, result } = waitForCallback({ port, timeoutMs: 5000 });
  await listening;
  result.catch(() => {});
  const longPayload = '<img src=x onerror=alert(1)>'.repeat(50);
  const res = await fetch(
    `http://${HOST}:${port}/auth/callback?error=` + encodeURIComponent(longPayload)
  );
  const body = await res.text();
  assert.ok(!body.includes('<img src=x onerror=alert(1)>'));
  // Capped well below the full repeated payload's length.
  assert.ok(body.length < longPayload.length);
  await assert.rejects(result);
});

test('a request to any other path 404s and does not settle the pending sign-in', async () => {
  const port = freshPort();
  const { listening, result } = waitForCallback({ port, timeoutMs: 5000 });
  await listening;
  const res = await fetch(`http://${HOST}:${port}/favicon.ico`);
  assert.equal(res.status, 404);
  const codeRes = await fetch(`http://${HOST}:${port}/auth/callback?code=late-but-real`);
  assert.equal(codeRes.status, 200);
  const value = await result;
  assert.deepEqual(value, { code: 'late-but-real', flowId: null });
});

test('rejects with a timeout error when nothing arrives in time', async () => {
  const port = freshPort();
  const { listening, result } = waitForCallback({ port, timeoutMs: 30, log: silentLog });
  await listening;
  await assert.rejects(result, (err) => {
    assert.equal(err.code, 'timeout');
    return true;
  });
});

test('rejects listening with a clear message on EADDRINUSE rather than picking another port', async () => {
  const port = freshPort();
  const blocker = http.createServer(() => {});
  await new Promise((resolve, reject) => {
    blocker.on('error', reject);
    blocker.listen(port, HOST, resolve);
  });
  try {
    const { listening, result } = waitForCallback({ port, timeoutMs: 2000, log: silentLog });
    result.catch(() => {}); // listening's rejection also settles result — see below
    await assert.rejects(listening, (err) => {
      assert.equal(err.code, 'EADDRINUSE');
      assert.match(err.message, /in use/i);
      return true;
    });
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('signInWithOtp-style callers can tell binding failed before doing anything else', async () => {
  // Regression for the non-blocking ordering issue: the caller must be able
  // to await `listening` and find out about EADDRINUSE *before* it has sent
  // any email, rather than only discovering it once `result` rejects after
  // the fact.
  const port = freshPort();
  const blocker = http.createServer(() => {});
  await new Promise((resolve, reject) => {
    blocker.on('error', reject);
    blocker.listen(port, HOST, resolve);
  });
  try {
    const { listening, result } = waitForCallback({ port, timeoutMs: 2000, log: silentLog });
    let listeningFailed = false;
    try {
      await listening;
    } catch {
      listeningFailed = true;
    }
    assert.equal(listeningFailed, true);
    result.catch(() => {});
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('cancel() settles result without a caller-visible request', async () => {
  const port = freshPort();
  const { listening, result, cancel } = waitForCallback({ port, timeoutMs: 5000 });
  await listening;
  cancel();
  await assert.rejects(result, (err) => {
    assert.equal(err.code, 'cancelled');
    return true;
  });
});
