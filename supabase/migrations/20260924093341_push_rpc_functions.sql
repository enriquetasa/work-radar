-- Work Radar sync — Phase 2: push RPCs.
--
-- A plain upsert would let a stale offline edit clobber a newer one, so
-- the client never writes to items/log_entries directly — it always goes
-- through these two RPCs (see the plan's "Conditional push" note).
--
-- Both are `security invoker` (RLS applies exactly as if the caller ran
-- the SQL themselves — no privilege escalation) and `set search_path = ''`
-- (so every reference below is schema-qualified; pg_catalog, which
-- jsonb_array_elements/now()/etc. live in, stays implicitly searched even
-- with an empty path). `user_id` is always taken from `auth.uid()`, never
-- from the incoming jsonb, so a caller cannot push rows into someone
-- else's account by forging a `user_id` field.
--
-- The returned column is `row_id`, not `id`: plpgsql implicitly declares
-- an OUT parameter as a variable of the same name, and a bare `id` inside
-- the function body would then be ambiguous with the `items.id` /
-- `log_entries.id` columns referenced in the SQL below (confirmed by
-- `supabase db lint`) — `row_id` sidesteps that instead of relying on
-- schema-qualifying every column reference.
--
-- Each row is applied in its own sub-transaction (the nested `begin ...
-- exception when others ... end`) and reported back individually, so one
-- bad row (a failed check constraint, a stale update, a missing parent
-- item) never aborts the rest of the batch — see push_log_entries below
-- for why that matters for ordering.
create or replace function public.push_items(items jsonb)
returns table (row_id text, accepted boolean, reason text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  rec jsonb;
  caller uuid := (select auth.uid());
  affected integer;
begin
  if caller is null then
    raise exception 'push_items: no authenticated user';
  end if;

  for rec in select * from jsonb_array_elements(items)
  loop
    begin
      insert into public.items (
        id, user_id, name, status, priority, category, notes,
        added_at, updated_at, reviewed_at, archived_at, deleted_at
      )
      values (
        rec ->> 'id',
        caller,
        rec ->> 'name',
        rec ->> 'status',
        rec ->> 'priority',
        coalesce(rec ->> 'category', ''),
        coalesce(rec ->> 'notes', ''),
        (rec ->> 'addedAt')::timestamptz,
        (rec ->> 'updatedAt')::timestamptz,
        (rec ->> 'reviewedAt')::timestamptz,
        (rec ->> 'archivedAt')::timestamptz,
        (rec ->> 'deletedAt')::timestamptz
      )
      -- "only for rows owned by auth.uid()": the update arm is also
      -- filtered by the items_update_own RLS policy, but this WHERE is
      -- what actually decides "newest wins" — a stale incoming updated_at
      -- makes the update a no-op (0 rows), which we report as rejected
      -- rather than erroring.
      --
      -- KNOWN GAP, not fixed here: this only compares updated_at, but the
      -- client's own mergeItem (renderer/domain.js) breaks a tie on equal
      -- updated_at by comparing reviewed_at, then archived_at, then
      -- deleted_at, then a JSON.stringify of the whole row — so on an
      -- exact updated_at tie with different content, the server and a
      -- client's local merge can pick different winners and never
      -- converge (rare: needs identical millisecond timestamps). Matching
      -- SQL to that *exact* chain isn't practical (the JSON.stringify
      -- fallback has no SQL equivalent that agrees with it row for row),
      -- so rather than build a WHERE clause that only partially agrees
      -- with mergeItem — which would just move the disagreement instead
      -- of removing it — Phase 4 (sync engine) should instead: when a
      -- push is rejected as stale_or_not_owned for a row this user owns
      -- and the local merge still prefers the local version, re-stamp its
      -- updated_at and push again. That converges without this RPC
      -- needing to reproduce mergeItem's tie-break.
      on conflict (id) do update set
        name = excluded.name,
        status = excluded.status,
        priority = excluded.priority,
        category = excluded.category,
        notes = excluded.notes,
        added_at = excluded.added_at,
        updated_at = excluded.updated_at,
        reviewed_at = excluded.reviewed_at,
        archived_at = excluded.archived_at,
        deleted_at = excluded.deleted_at
      where public.items.user_id = caller
        and excluded.updated_at > public.items.updated_at;

      get diagnostics affected = row_count;

      row_id := rec ->> 'id';
      accepted := affected > 0;
      reason := case when affected > 0 then null else 'stale_or_not_owned' end;
    exception
      when others then
        row_id := rec ->> 'id';
        accepted := false;
        reason := sqlerrm;
    end;
    return next;
  end loop;
end;
$$;

comment on function public.push_items(jsonb) is
  'Upsert items for the caller, newest updated_at wins. items is a jsonb '
  'array shaped like domain.js items (camelCase field names). Returns one '
  'row per input row: {row_id, accepted, reason}.';

revoke all on function public.push_items(jsonb) from public;
grant execute on function public.push_items(jsonb) to authenticated;

-- log_entries are append-only (on conflict do nothing — see the plan's
-- "Log entries | Own table, append-only" decision), so there is no
-- "newest wins" question here, only two ways a row can be rejected:
-- it's a duplicate id already pushed, or its parent item row doesn't
-- exist under this user yet.
--
-- That second case is expected, not exceptional: the client pushes items
-- before log entries (see the sync engine's push order, Phase 4), but a
-- batch can still race ahead of that — e.g. an item pushed in an earlier,
-- since-superseded batch that failed, or simple reordering under retry.
-- Rather than let the item_id foreign key raise and abort the whole
-- batch, this checks ownership up front and reports 'item_not_found' for
-- that one row; the sync engine (Phase 4) retries rejected log entries
-- once their item has synced, rather than needing a strict global order.
create or replace function public.push_log_entries(entries jsonb)
returns table (row_id text, accepted boolean, reason text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  rec jsonb;
  caller uuid := (select auth.uid());
  affected integer;
begin
  if caller is null then
    raise exception 'push_log_entries: no authenticated user';
  end if;

  for rec in select * from jsonb_array_elements(entries)
  loop
    begin
      -- Explicit ownership check, so "item hasn't synced yet" and "item
      -- belongs to someone else" come back as the same rejection from
      -- this RPC (see the function comment). This does not hide whether
      -- an id exists at all — items.id is a global primary key, so a
      -- direct push_items insert with a colliding id already reveals
      -- that an item exists (as a stale_or_not_owned/conflict, not
      -- item_not_found) regardless of who owns it. What this check (and
      -- the composite FK on log_entries added in the tables migration)
      -- actually prevents is a log entry ending up attached to an item
      -- this caller does not own — not existence-probing, which the
      -- schema was never going to be able to hide anyway.
      if not exists (
        select 1 from public.items
        where public.items.id = (rec ->> 'itemId') and public.items.user_id = caller
      ) then
        row_id := rec ->> 'id';
        accepted := false;
        reason := 'item_not_found';
      else
        insert into public.log_entries (id, item_id, user_id, ts, text)
        values (
          rec ->> 'id',
          rec ->> 'itemId',
          caller,
          (rec ->> 'ts')::timestamptz,
          coalesce(rec ->> 'text', '')
        )
        on conflict (id) do nothing;

        get diagnostics affected = row_count;

        row_id := rec ->> 'id';
        accepted := affected > 0;
        reason := case when affected > 0 then null else 'duplicate' end;
      end if;
    exception
      when others then
        row_id := rec ->> 'id';
        accepted := false;
        reason := sqlerrm;
    end;
    return next;
  end loop;
end;
$$;

comment on function public.push_log_entries(jsonb) is
  'Append log entries for the caller''s own items, idempotent by id. '
  'entries is a jsonb array of {id, itemId, ts, text}. Returns one row '
  'per input row: {row_id, accepted, reason}; reason is ''item_not_found'' '
  'when the parent item has not synced yet (retry later) or belongs to '
  'someone else, ''duplicate'' when the id was already pushed.';

revoke all on function public.push_log_entries(jsonb) from public;
grant execute on function public.push_log_entries(jsonb) to authenticated;

-- `revoke all ... from public` above does not actually revoke anon's
-- EXECUTE: Supabase grants EXECUTE on new functions to anon by default,
-- independently of the `public` pseudo-role, so `grant ... to
-- authenticated` alone leaves anon's grant in place too (harmless here,
-- since both functions raise when auth.uid() is null, but the SQL should
-- say what it means). Revoke it explicitly instead of relying on that.
revoke execute on function public.push_items(jsonb), public.push_log_entries(jsonb) from anon;
