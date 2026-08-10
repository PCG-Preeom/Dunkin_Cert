import { createClient } from '@supabase/supabase-js';

// Service role key bypasses Row Level Security — this must only ever be
// used server-side (inside Netlify Functions), never shipped to the browser.
export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
