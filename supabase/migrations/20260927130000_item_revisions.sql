-- Work Radar history — bounded immutable project revisions.
-- Additive migration: old clients continue syncing current items while new
-- clients append recoverable snapshots to item_revisions.
create table public.item_revisions (
  id text primary key,
  item_id text not null,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  snapshot_schema integer not null default 1,
  snapshot jsonb not null,
  action text not null default 'edit',
  source_device text,
  client_time timestamptz,
  server_received_at timestamptz not null default now(),
  restored_from_revision_id text,
  origin text not null default 'client',
  -- Pair ownership in the FK prevents a revision from being attached to
  -- another user's item even if a caller bypasses the RPC.
  foreign key (item_id, user_id) references public.items (id, user_id) on delete cascade
);

create index item_revisions_user_item_received_idx
  on public.item_revisions (user_id, item_id, server_received_at desc, id);
create index item_revisions_user_received_idx
  on public.item_revisions (user_id, server_received_at, id);

alter table public.item_revisions enable row level security;
create policy "item_revisions_select_own" on public.item_revisions for select
  to authenticated using (user_id = (select auth.uid()));
create policy "item_revisions_insert_own" on public.item_revisions for insert
  to authenticated with check (user_id = (select auth.uid()));
-- Revisions are immutable. Retention is performed by a trusted maintenance
-- job; clients cannot update or hard-delete history.
revoke update, delete, truncate on public.item_revisions from anon, authenticated;

-- Capture accepted updates from older clients and any other authorized item
-- writer. New clients also upload their UUID revision explicitly; duplicate
-- IDs are harmless and are ignored by the push RPC.
-- Correlate a new-client item mutation with its explicitly uploaded revision.
-- The setting is transaction-local and is only populated by push_items; older
-- writers continue to receive a generated immutable revision ID.
create or replace function public.capture_item_revision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  revision_id text;
  revision_action text;
  revision_source text;
  revision_restored text;
  revision_client_time timestamptz;
begin
  revision_id := nullif(current_setting('workradar.revision_id', true), '');
  revision_action := nullif(current_setting('workradar.revision_action', true), '');
  revision_source := nullif(current_setting('workradar.revision_source', true), '');
  revision_restored := nullif(current_setting('workradar.revision_restored_from', true), '');
  revision_client_time := nullif(current_setting('workradar.revision_client_time', true), '')::timestamptz;
  if revision_id is null then
    revision_id := pg_catalog.md5(
      pg_catalog.random()::text || pg_catalog.clock_timestamp()::text || new.id
    );
  end if;
  insert into public.item_revisions (
    id, item_id, user_id, snapshot_schema, snapshot, action,
    source_device, client_time, restored_from_revision_id, origin
  ) values (
    revision_id, new.id, new.user_id, 1,
    pg_catalog.jsonb_build_object(
      'id', new.id, 'name', new.name, 'status', new.status,
      'priority', new.priority, 'category', new.category, 'notes', new.notes,
      'reviewIntervalDays', new.review_interval_days,
      'nextReviewOn', new.next_review_on, 'waitingOn', new.waiting_on,
      'checkpoint', new.checkpoint, 'checkpointOn', new.checkpoint_on,
      'addedAt', case when new.added_at is null then null else floor(extract(epoch from new.added_at) * 1000)::bigint end, 'updatedAt', case when new.updated_at is null then null else floor(extract(epoch from new.updated_at) * 1000)::bigint end,
      'reviewedAt', case when new.reviewed_at is null then null else floor(extract(epoch from new.reviewed_at) * 1000)::bigint end, 'archivedAt', case when new.archived_at is null then null else floor(extract(epoch from new.archived_at) * 1000)::bigint end,
      'deletedAt', case when new.deleted_at is null then null else floor(extract(epoch from new.deleted_at) * 1000)::bigint end
    ),
    coalesce(revision_action, case when tg_op = 'INSERT' then 'create' else 'edit' end),
    revision_source, coalesce(revision_client_time, new.updated_at), revision_restored, 'client'
  ) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists items_capture_revision on public.items;
create trigger items_capture_revision
after insert or update on public.items
for each row execute function public.capture_item_revision();

-- Latest schedule-aware push RPC with revision correlation. The item update
-- remains conditional on newest updated_at, so stale writes never create a
-- history row through the trigger.
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
  if caller is null then raise exception 'push_items: no authenticated user'; end if;
  for rec in select * from jsonb_array_elements(items)
  loop
    begin
      perform pg_catalog.set_config('workradar.revision_id', coalesce(rec ->> 'revisionId', ''), true);
      perform pg_catalog.set_config('workradar.revision_action', coalesce(rec ->> 'revisionAction', ''), true);
      perform pg_catalog.set_config('workradar.revision_source', coalesce(rec ->> 'revisionSourceDevice', ''), true);
      perform pg_catalog.set_config('workradar.revision_restored_from', coalesce(rec ->> 'revisionRestoredFrom', ''), true);
      perform pg_catalog.set_config('workradar.revision_client_time', coalesce(rec ->> 'revisionClientTime', ''), true);
      insert into public.items (
        id, user_id, name, status, priority, category, notes,
        added_at, updated_at, reviewed_at, archived_at, deleted_at,
        review_interval_days, next_review_on, waiting_on, checkpoint, checkpoint_on
      ) values (
        rec ->> 'id', caller, rec ->> 'name', rec ->> 'status', rec ->> 'priority',
        coalesce(rec ->> 'category', ''), coalesce(rec ->> 'notes', ''),
        (rec ->> 'addedAt')::timestamptz, (rec ->> 'updatedAt')::timestamptz,
        (rec ->> 'reviewedAt')::timestamptz, (rec ->> 'archivedAt')::timestamptz,
        (rec ->> 'deletedAt')::timestamptz,
        case when rec ? 'reviewIntervalDays' then (rec ->> 'reviewIntervalDays')::integer else 14 end,
        nullif(rec ->> 'nextReviewOn', '')::date,
        coalesce(rec ->> 'waitingOn', ''), coalesce(rec ->> 'checkpoint', ''),
        nullif(rec ->> 'checkpointOn', '')::date
      ) on conflict (id) do update set
        name = excluded.name, status = excluded.status, priority = excluded.priority,
        category = excluded.category, notes = excluded.notes,
        added_at = excluded.added_at, updated_at = excluded.updated_at,
        reviewed_at = excluded.reviewed_at, archived_at = excluded.archived_at,
        deleted_at = excluded.deleted_at,
        review_interval_days = case when rec ? 'reviewIntervalDays' then excluded.review_interval_days else public.items.review_interval_days end,
        next_review_on = case when rec ? 'nextReviewOn' then excluded.next_review_on else public.items.next_review_on end,
        waiting_on = case when rec ? 'waitingOn' then excluded.waiting_on else public.items.waiting_on end,
        checkpoint = case when rec ? 'checkpoint' then excluded.checkpoint else public.items.checkpoint end,
        checkpoint_on = case when rec ? 'checkpointOn' then excluded.checkpoint_on else public.items.checkpoint_on end
      where public.items.user_id = caller and excluded.updated_at > public.items.updated_at;
      get diagnostics affected = row_count;
      row_id := rec ->> 'id'; accepted := affected > 0;
      reason := case when affected > 0 then null else 'stale_or_not_owned' end;
    exception when others then
      row_id := rec ->> 'id'; accepted := false; reason := sqlerrm;
    end;
    perform pg_catalog.set_config('workradar.revision_id', '', true);
    perform pg_catalog.set_config('workradar.revision_action', '', true);
    perform pg_catalog.set_config('workradar.revision_source', '', true);
    perform pg_catalog.set_config('workradar.revision_restored_from', '', true);
    perform pg_catalog.set_config('workradar.revision_client_time', '', true);
    return next;
  end loop;
end;
$$;
revoke all on function public.push_items(jsonb) from public;
revoke execute on function public.push_items(jsonb) from anon;
grant execute on function public.push_items(jsonb) to authenticated;

create or replace function public.push_item_revisions(revisions jsonb)
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
    raise exception 'push_item_revisions: no authenticated user';
  end if;
  for rec in select * from jsonb_array_elements(revisions)
  loop
    begin
      if not exists (
        select 1 from public.items
        where public.items.id = rec ->> 'itemId'
          and public.items.user_id = caller
      ) then
        row_id := rec ->> 'id';
        accepted := false;
        reason := 'item_not_found';
      else
        insert into public.item_revisions (
          id, item_id, user_id, snapshot_schema, snapshot, action,
          source_device, client_time, restored_from_revision_id, origin
        ) values (
          rec ->> 'id',
          rec ->> 'itemId',
          caller,
          coalesce((rec ->> 'snapshotSchema')::integer, 1),
          coalesce(rec -> 'snapshot', '{}'::jsonb),
          coalesce(rec ->> 'action', 'edit'),
          rec ->> 'sourceDevice',
          (rec ->> 'clientTime')::timestamptz,
          rec ->> 'restoredFromRevisionId',
          'client'
        ) on conflict (id) do nothing;
        get diagnostics affected = row_count;
        row_id := rec ->> 'id';
        accepted := affected > 0;
        reason := case when affected > 0 then null else 'duplicate' end;
      end if;
    exception when others then
      row_id := rec ->> 'id';
      accepted := false;
      reason := sqlerrm;
    end;
    return next;
  end loop;
end;
$$;

comment on function public.push_item_revisions(jsonb) is
  'Append immutable project snapshots owned by the caller, idempotent by id.';
revoke all on function public.push_item_revisions(jsonb) from public;
revoke execute on function public.push_item_revisions(jsonb) from anon;
grant execute on function public.push_item_revisions(jsonb) to authenticated;

-- Seed one baseline per existing item. The migration cannot reconstruct prior
-- versions; it only makes the current state recoverable from this release on.
insert into public.item_revisions (
  id, item_id, user_id, snapshot_schema, snapshot, action, client_time, origin
)
select
  'baseline-' || i.id || '-' || floor(extract(epoch from i.updated_at) * 1000)::bigint,
  i.id,
  i.user_id,
  1,
  pg_catalog.jsonb_build_object(
    'id', i.id, 'name', i.name, 'status', i.status, 'priority', i.priority,
    'category', i.category, 'notes', i.notes,
    'reviewIntervalDays', i.review_interval_days,
    'nextReviewOn', i.next_review_on, 'waitingOn', i.waiting_on,
    'checkpoint', i.checkpoint, 'checkpointOn', i.checkpoint_on,
    'addedAt', case when i.added_at is null then null else floor(extract(epoch from i.added_at) * 1000)::bigint end,
    'updatedAt', case when i.updated_at is null then null else floor(extract(epoch from i.updated_at) * 1000)::bigint end,
    'reviewedAt', case when i.reviewed_at is null then null else floor(extract(epoch from i.reviewed_at) * 1000)::bigint end,
    'archivedAt', case when i.archived_at is null then null else floor(extract(epoch from i.archived_at) * 1000)::bigint end,
    'deletedAt', case when i.deleted_at is null then null else floor(extract(epoch from i.deleted_at) * 1000)::bigint end
  ),
  'baseline', i.updated_at, 'migration'
from public.items i
on conflict (id) do nothing;

-- Run this from a trusted scheduled job (for example Supabase Cron). Client
-- rows are already durable locally, while the server keeps the newest 100 per
-- project as bounded recovery history.
create or replace function public.prune_item_revisions(retain_count integer default 100)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  if retain_count < 1 then raise exception 'retain_count must be positive'; end if;
  with ranked as (
    select id, pg_catalog.row_number() over (
      partition by item_id order by server_received_at desc, id desc
    ) as position
    from public.item_revisions
  )
  delete from public.item_revisions r
  using ranked
  where r.id = ranked.id and ranked.position > retain_count;
  get diagnostics removed = row_count;
  return removed;
end;
$$;
revoke all on function public.prune_item_revisions(integer) from public;
grant execute on function public.prune_item_revisions(integer) to service_role;
comment on function public.prune_item_revisions(integer) is
  'Invoke daily from Supabase Cron or another trusted scheduler; retains the newest server-received revisions per item.';
