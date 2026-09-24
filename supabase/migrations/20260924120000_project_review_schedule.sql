-- Per-project review schedules and independent checkpoints. Calendar dates
-- remain timezone-free; clients derive legacy next reviews in local time.
alter table public.items
  add column review_interval_days integer default 14
    check (review_interval_days is null or review_interval_days between 1 and 3650),
  add column next_review_on date,
  add column waiting_on text not null default '',
  add column checkpoint text not null default '',
  add column checkpoint_on date;

comment on column public.items.review_interval_days is
  'Days between reviews; null means manual reviews only.';
comment on column public.items.next_review_on is
  'Next review calendar date; null lets the client derive a legacy date from reviewed_at.';

-- Keep the existing ownership and strict newest-updated_at protections.
-- Old clients omit schedule keys: preserve those columns on updates.
-- Explicit null/blank values from new clients still clear optional fields.
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
        added_at, updated_at, reviewed_at, archived_at, deleted_at,
        review_interval_days, next_review_on, waiting_on, checkpoint, checkpoint_on
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
        (rec ->> 'deletedAt')::timestamptz,
        case when rec ? 'reviewIntervalDays'
          then (rec ->> 'reviewIntervalDays')::integer else 14 end,
        nullif(rec ->> 'nextReviewOn', '')::date,
        coalesce(rec ->> 'waitingOn', ''),
        coalesce(rec ->> 'checkpoint', ''),
        nullif(rec ->> 'checkpointOn', '')::date
      )
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
        deleted_at = excluded.deleted_at,
        review_interval_days = case when rec ? 'reviewIntervalDays'
          then excluded.review_interval_days else public.items.review_interval_days end,
        next_review_on = case when rec ? 'nextReviewOn'
          then excluded.next_review_on else public.items.next_review_on end,
        waiting_on = case when rec ? 'waitingOn'
          then excluded.waiting_on else public.items.waiting_on end,
        checkpoint = case when rec ? 'checkpoint'
          then excluded.checkpoint else public.items.checkpoint end,
        checkpoint_on = case when rec ? 'checkpointOn'
          then excluded.checkpoint_on else public.items.checkpoint_on end
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

revoke all on function public.push_items(jsonb) from public;
revoke execute on function public.push_items(jsonb) from anon;
grant execute on function public.push_items(jsonb) to authenticated;
