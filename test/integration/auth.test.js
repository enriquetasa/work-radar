'use strict';
/* ============================================================
   WORK RADAR — integration test: Phase 3 sign-in flow
   Exercises the whole magic-link round trip from
   docs/supabase-sync-plan.md → "Sign-in flow" against the LOCAL
   Supabase stack: admin-creates a user, drives sync/auth-service.js's
   signIn() for real, fetches the magic-link email from Mailpit's HTTP
   API instead of a real inbox, requests the link so its redirect
   reaches our real loopback server (sync/callback-server.js), and
   asserts a session comes back, gets persisted through the (fake)
   encryptor, and is restorable by a brand-new client reading the same
   storage file.

   Needs `npx supabase start` already running. Never targets a hosted
   project — URL/keys are read fresh from `supabase status -o json`
   every run, same as test/integration/sync.test.js; no key is ever
   committed.

   If this fails with a rate-limit error from Supabase, the local
   stack's [auth.rate_limit] email_sent in supabase/config.toml is too
   low for repeated runs — raise it (local-only setting) and
   `npx supabase stop && npx supabase start`.

   Deliberately excluded from `npm test` — run via `npm run test:integration`.
   ============================================================ */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createClient } = require('@supabase/supabase-js');

const logger = require('../../logger.js');
const { createAuthClient } = require('../../sync/auth-client.js');
const { createAuthService } = require('../../sync/auth-service.js');
const { createSessionStorage } = require('../../sync/session-storage.js');
const { waitForCallback, REDIRECT_TO } = require('../../sync/callback-server.js');

// Same pattern as test/integration/sync.test.js: read the running local
// stack's URL and keys fresh every run, never hardcoded.
function readLocalSupabaseConfig() {
  let raw;
  try {
    raw = execFileSync('npx', ['supabase', 'status', '-o', 'json'], { encoding: 'utf8' });
  } catch (err) {
    throw new Error(
      'Could not read `supabase status -o json` — is the local stack running ' +
        '(`npx supabase start`)? ' +
        err.message
    );
  }
  const status = JSON.parse(raw);
  if (!status.API_URL || !status.PUBLISHABLE_KEY || !status.SECRET_KEY || !status.MAILPIT_URL) {
    throw new Error(
      'supabase status did not include API_URL/PUBLISHABLE_KEY/SECRET_KEY/MAILPIT_URL'
    );
  }
  return {
    url: status.API_URL,
    publishableKey: status.PUBLISHABLE_KEY,
    secretKey: status.SECRET_KEY,
    mailpitUrl: status.MAILPIT_URL,
  };
}

// A reversible fake encryptor standing in for Electron's safeStorage (see
// sync/session-storage.js's doc comment) — real XOR obfuscation, not real
// security, just enough to prove the file on disk isn't plaintext.
const ENC_PREFIX = Buffer.from('TEST-ENC:');
const XOR_KEY = 0x42;
function xor(buf) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ XOR_KEY;
  return out;
}
function fakeEncrypt(buf) {
  return Buffer.concat([ENC_PREFIX, xor(buf)]);
}
function fakeDecrypt(buf) {
  if (!buf.subarray(0, ENC_PREFIX.length).equals(ENC_PREFIX)) {
    throw new Error('not encrypted with the test fake');
  }
  return xor(buf.subarray(ENC_PREFIX.length));
}

// Polls Mailpit for the magic-link email sent to `email` and pulls the
// `.../auth/v1/verify?...` URL out of its plain-text body. Retries for a
// few seconds since GoTrue sends asynchronously.
async function findMagicLinkFor(mailpitUrl, email, { retries = 30, delayMs = 500 } = {}) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(`${mailpitUrl}/api/v1/messages`);
    const list = await res.json();
    const summary = list.messages.find((m) => m.To.some((to) => to.Address === email));
    if (summary) {
      const full = await (await fetch(`${mailpitUrl}/api/v1/message/${summary.ID}`)).json();
      const match = /(https?:\/\/\S+\/auth\/v1\/verify\?\S+)/.exec(full.Text || '');
      if (match) return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`no magic-link email arrived for ${email} within the retry window`);
}

let admin;
let config;
let tmpDir;
const createdUserIds = [];

before(async () => {
  config = readLocalSupabaseConfig();
  admin = createClient(config.url, config.secretKey);
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wr-auth-integration-'));
});

after(async () => {
  for (const userId of createdUserIds) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) {
      logger.error('failed to clean up integration test user', { err: error, userId });
    }
  }
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch((err) => {
    logger.warn('failed to remove temp dir after auth integration test', { dir: tmpDir, err });
  });
});

// Builds a real auth-service wired to a fresh session-storage file, so
// each test (or restore step) can use its own client instance the way
// separate app launches would.
function buildService(sessionFile) {
  const storage = createSessionStorage({
    filePath: sessionFile,
    encrypt: fakeEncrypt,
    decrypt: fakeDecrypt,
  });
  const client = createAuthClient({
    url: config.url,
    publishableKey: config.publishableKey,
    storage,
  });
  const service = createAuthService({ client, waitForCallback, redirectTo: REDIRECT_TO });
  return { client, service };
}

test('full sign-in flow: signInWithOtp -> Mailpit -> loopback redirect -> session persisted and restorable', async () => {
  const email = `work-radar-auth-test-${crypto.randomUUID()}@example.com`;
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: crypto.randomBytes(24).toString('hex'),
    email_confirm: true,
  });
  assert.equal(createError, null);
  createdUserIds.push(created.user.id);

  const sessionFile = path.join(tmpDir, 'session.enc');
  const { service } = buildService(sessionFile);

  // signIn() won't resolve until the loopback server actually receives
  // the redirect below, so start it and only await it after driving
  // that redirect through Mailpit.
  const signInPromise = service.signIn(email);

  const magicLink = await findMagicLinkFor(config.mailpitUrl, email);
  const verifyResponse = await fetch(magicLink, { redirect: 'follow' });
  assert.equal(verifyResponse.status, 200, 'the loopback callback page must have been served');
  const html = await verifyResponse.text();
  assert.match(html, /close this tab/i);

  await signInPromise;

  const status = await service.getStatus();
  assert.deepEqual(status, { signedIn: true, email, pending: false });

  // Persisted via the fake encryptor: the raw file must not be
  // plaintext, and manually decrypting it must reveal a real session.
  const raw = await fsp.readFile(sessionFile);
  assert.ok(
    raw.subarray(0, ENC_PREFIX.length).equals(ENC_PREFIX),
    'file must carry the fake-encryption marker'
  );
  const decoded = JSON.parse(fakeDecrypt(raw).toString('utf8'));
  // supabase-js keys the main session under "sb-<ref>-auth-token" and
  // (separately) the PKCE code verifier under "...-code-verifier" —
  // find the one that actually parses as a session rather than
  // assuming which key name it used.
  let storedSession = null;
  for (const value of Object.values(decoded)) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && parsed.access_token) {
        storedSession = parsed;
        break;
      }
    } catch {
      // not the session entry (e.g. the raw code-verifier string) — skip
    }
  }
  assert.ok(
    storedSession,
    'the persisted store must contain a parsed session with an access_token'
  );
  assert.equal(storedSession.user.email, email);

  // Restorable: a brand-new client + service reading the same file
  // (simulating a fresh app launch) must come back already signed in,
  // with no further network round trip needed.
  const { service: restoredService } = buildService(sessionFile);
  const restoredStatus = await restoredService.getStatus();
  assert.deepEqual(restoredStatus, { signedIn: true, email, pending: false });
});
