// Supabase project URL + anon key — safe to ship inside the app (this is the standard, documented
// pattern for client apps: the anon key is a PUBLIC key, not a secret; per-user data access is
// enforced server-side by Postgres Row Level Security, see supabase/schema.sql). This is exactly
// how the same project gets used identically from both the Windows and macOS builds, which is
// what makes "one account, synced everywhere" possible at all.
//
// Filled in once the project exists — see supabase/schema.sql for the one-time setup script.
export const SUPABASE_URL = 'https://yzlwgzlidfovwwdnntym.supabase.co'
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl6bHdnemxpZGZvdnd3ZG5udHltIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2NTgwNDksImV4cCI6MjEwMzIzNDA0OX0.bJCIxYEJ1VUyCYjSPYsgZF1QfdBZ8Um5geMiBb1gSSg'

export function isSupabaseConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0
}
