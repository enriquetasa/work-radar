-- Work Radar sync — Phase 2: row-level security.
--
-- Every policy uses the `(select auth.uid())` form (not bare `auth.uid()`)
-- so Postgres can evaluate it once per statement via an initplan instead of
-- once per row — see https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select.
alter table public.items enable row level security;
alter table public.log_entries enable row level security;

-- items: select / insert / update own rows only.
create policy "items_select_own" on public.items for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "items_insert_own" on public.items for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create policy "items_update_own" on public.items for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- No delete policy on items, deliberately: PURGE is a tombstone
-- (deleted_at set via an ordinary update — see mergeItem's doc comment in
-- renderer/domain.js for why deletion has to merge like any other edit,
-- not as a special case), so the app never issues a SQL DELETE against
-- this table. Omitting the policy means RLS denies every DELETE by
-- default for anon and authenticated — the only roles the app and
-- PostgREST use, since row security is "deny unless a policy grants it".
-- (The table owner, postgres and service_role bypass RLS entirely, as do
-- TRUNCATE and any FK-driven cascade — see the explicit revokes below for
-- anon/authenticated on those.) This is exactly the enforcement we want
-- day to day: even a compromised/buggy client, or the RPC below acting as
-- the caller (SECURITY INVOKER), physically cannot hard-delete a row
-- through the normal API — only the `on delete cascade` from auth.users
-- (run as the table owner, not subject to RLS) can.

-- log_entries: select / insert own rows only — no update policy, because
-- log entries are append-only by design (unioned by id on the client,
-- never diffed — see renderer/domain.js's unionLogs). Nothing in the app
-- or the push_log_entries RPC ever updates a log_entries row, so there is
-- no update policy to grant it; if that ever changes, add one deliberately
-- rather than relying on there being no code path that needs it today.
create policy "log_entries_select_own" on public.log_entries for select
  to authenticated
  using (user_id = (select auth.uid()));

-- This only checks the *entry's own* user_id — it does NOT by itself stop
-- someone from inserting a log entry whose item_id points at another
-- user's item (a foreign key check bypasses RLS, so it can't see this
-- policy at all). That gap is closed at the schema level instead, by the
-- composite foreign key on log_entries.item_id/user_id added in the
-- previous migration, which requires the pair to jointly match a row in
-- items(id, user_id) — so an item_id belonging to someone else has no
-- matching (item_id, user_id) row for *this* caller's user_id, and the
-- insert is rejected by the FK before this policy even matters.
create policy "log_entries_insert_own" on public.log_entries for insert
  to authenticated
  with check (user_id = (select auth.uid()));

-- No delete policy on log_entries either, for the same reason as items:
-- the log is append-only and permanent (it only disappears via the
-- `on delete cascade` when its parent item's row is cascade-deleted by
-- auth.users being deleted — never a direct client DELETE).

-- Defense in depth: RLS's default-deny already blocks anon/authenticated
-- DELETE on both tables (see above), but TRUNCATE is not subject to RLS
-- at all, and Supabase's default grants otherwise leave anon and
-- authenticated with ALL privileges (including DELETE/TRUNCATE) on every
-- table in `public`. Revoke both explicitly so the "no hard delete" story
-- doesn't rely solely on RLS.
revoke delete, truncate on public.items from anon, authenticated;
revoke delete, truncate on public.log_entries from anon, authenticated;
