import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Auth and stories fetch will fail until .env is configured."
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // No-op lock: bypass navigator.locks-based cross-tab sync because it
    // can deadlock on stale lock state from a crashed/orphaned tab,
    // causing every auth call (and any REST call that triggers a token
    // refresh) to hang forever. We accept the trade-off that two tabs
    // signing in/out simultaneously could race.
    lock: async (_name, _timeoutMs, fn) => await fn(),
  },
});
