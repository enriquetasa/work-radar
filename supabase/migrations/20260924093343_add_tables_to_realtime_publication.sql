-- Work Radar sync — Phase 2: Realtime plumbing, wired now so the
-- migration set is complete even though nothing subscribes yet
-- (that's Phase 6). RLS still applies to Realtime's row-level changefeed,
-- so this does not by itself expose any data cross-user.
alter publication supabase_realtime add table public.items;
alter publication supabase_realtime add table public.log_entries;
