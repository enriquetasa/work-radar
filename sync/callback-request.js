'use strict';
/* ============================================================
   WORK RADAR — loopback callback request parsing
   Pure parsing of the redirect Supabase sends the loopback server (see
   docs/supabase-sync-plan.md → "Sign-in flow"): either
   `?code=...` (success) or `?error=...&error_description=...` (failure).
   Framework-free so it's unit-testable without node:http.
   ============================================================ */

const { URL } = require('url');

const CALLBACK_PATH = '/auth/callback';

// `requestUrl` is req.url as node:http hands it (path + query only, no
// origin), so a fake base is supplied purely to satisfy the URL parser.
function parseCallbackRequest(requestUrl) {
  let parsed;
  try {
    parsed = new URL(requestUrl, 'http://127.0.0.1');
  } catch {
    return { ok: false, notFound: true };
  }
  if (parsed.pathname !== CALLBACK_PATH) {
    return { ok: false, notFound: true };
  }

  const params = parsed.searchParams;
  const error = params.get('error');
  if (error) {
    return { ok: false, error, errorDescription: params.get('error_description') || '' };
  }

  const code = params.get('code');
  if (!code) {
    return {
      ok: false,
      error: 'missing_code',
      errorDescription: 'callback had neither a code nor an error parameter',
    };
  }
  // supabase-js appends sb_flow_id to emailRedirectTo; exchangeCodeForSession
  // needs it back for the "deprecation-window dual write" case where a
  // future supabase-js version stops also writing the fixed
  // '<key>-code-verifier' storage entry that exchangeCodeForSession(code)
  // alone relies on.
  return { ok: true, code, flowId: params.get('sb_flow_id') || null };
}

module.exports = { parseCallbackRequest, CALLBACK_PATH };
