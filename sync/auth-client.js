'use strict';
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
