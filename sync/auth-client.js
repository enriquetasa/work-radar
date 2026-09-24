'use strict';
/* ============================================================
   WORK RADAR — supabase-js client factory
   Thin wiring: builds the one supabase-js client the main process uses
   for auth (and, in a later phase, sync). PKCE + autoRefreshToken per
   docs/supabase-sync-plan.md → "Architecture"/"Sign-in flow". Session
   persistence goes through the injected `storage` adapter (see
   sync/session-storage.js) rather than supabase-js's browser-only
   defaults, since this runs in the Electron main process, not a
   browser tab.
   ============================================================ */

const { createClient } = require('@supabase/supabase-js');

function createAuthClient({ url, publishableKey, storage }) {
  return createClient(url, publishableKey, {
    auth: {
      flowType: 'pkce',
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false, // main process has no browser URL to inspect
      storage,
    },
  });
}

module.exports = { createAuthClient };
