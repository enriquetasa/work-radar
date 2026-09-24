-- Work Radar sync — Phase 2: tables.
--
-- Mirrors renderer/domain.js's item shape (schema v3: tombstones, no hard
-- deletes — see docs/supabase-sync-plan.md's "Phase 1 notes"). Timestamps
-- are timestamptz here even though the client keeps them as epoch-ms
-- numbers internally; the sync engine (Phase 4) converts at the boundary.
--
-- Two clocks, two columns (see the plan's Schema section):
--   updated_at — the client's edit time. Decides "newest wins" in
--                push_items (Phase 2) and in the client's own mergeItem.
--   synced_at  — the *server's* clock, stamped by a trigger (next
--                migration) and never trusted from the client. It is the
--                pull cursor: "give me everything with synced_at > X".
create table public.items (
  id text primary key, -- client-generated (domain.js's uid()); keeps existing ids
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  status text not null check (status in ('active', 'watch', 'dormant')),
  priority text not null check (priority in ('critical', 'high', 'medium', 'low')),
  category text not null default '',
  notes text not null default '',
  added_at timestamptz not null,
  updated_at timestamptz not null,
  reviewed_at timestamptz not null,
  archived_at timestamptz,
  deleted_at timestamptz, -- tombstone for PURGE; row is kept, never removed
  synced_at timestamptz not null default now(),
  -- Lets log_entries reference (id, user_id) together (see below) so the
  -- *foreign key itself* — not just an RLS policy or the RPC's own check —
  -- refuses a log entry whose item_id/user_id pair doesn't jointly exist.
  -- id alone is already a global primary key, so this adds no new
  -- uniqueness; it only exists to be a composite FK target.
  unique (id, user_id)
);

comment on table public.items is
  'One row per radar item. Deletion is a tombstone (deleted_at), never a '
  'SQL DELETE — see the missing delete policy in the next migration.';
comment on column public.items.updated_at is
  'Client edit time. Used by push_items to reject stale writes.';
comment on column public.items.synced_at is
  'Server clock, set by a trigger (see synced_at_trigger migration). '
  'This is the pull cursor, not an edit time — see that migration''s '
  'comment for the pull-side caveats this implies.';

-- append-only, unioned by id on the client (domain.js's unionLogs) — never
-- updated or diffed, so there is no updated_at here, only ts (when the
-- entry was written) and synced_at (the pull cursor).
create table public.log_entries (
  id text primary key, -- client-generated (uid(), or legacyLogId() for migrated rows)
  item_id text not null,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  ts timestamptz not null,
  text text not null,
  synced_at timestamptz not null default now(),
  -- Composite FK, not a plain `item_id references items(id)`: a foreign
  -- key check bypasses RLS entirely, so a single-column FK only proves
  -- "this item_id exists somewhere" — it says nothing about who owns it,
  -- and the insert policy below only checks the log_entries row's own
  -- user_id. Requiring the pair to match a row in items(id, user_id)
  -- means a log entry can only be attached to an item owned by the same
  -- user_id as the entry itself, closing that gap at the schema level
  -- rather than relying solely on push_log_entries' own ownership check
  -- (which a direct PostgREST insert bypasses).
  foreign key (item_id, user_id) references public.items (id, user_id) on delete cascade
);

comment on table public.log_entries is
  'Append-only log lines for an item. Never updated once inserted — see '
  'push_log_entries''s "on conflict do nothing".';

-- Pull query is "rows for this user changed since the last cursor", i.e.
-- `where user_id = :uid and synced_at > :cursor order by synced_at`. `id`
-- is appended for keyset pagination (order/filter on (synced_at, id) as a
-- pair) — see the synced_at_trigger migration's comment on why a plain
-- `synced_at` cursor alone is not safe to paginate.
create index items_user_id_synced_at_idx on public.items (user_id, synced_at, id);
create index log_entries_user_id_synced_at_idx on public.log_entries (user_id, synced_at, id);

-- Postgres does not auto-create an index for a foreign key's referencing
-- columns (only for the referenced side, which is why `unique (id,
-- user_id)` on items above gets one). Cascade deletes from auth.users and
-- push_log_entries' ownership check both filter log_entries by item_id
-- alone, so it needs its own index — not covered by the primary key or
-- the (user_id, synced_at, id) index above.
create index log_entries_item_id_idx on public.log_entries (item_id);
