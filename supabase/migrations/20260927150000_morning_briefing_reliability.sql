-- Morning briefing reliability and server-owned delivery transitions.
-- This migration is additive because 20260927120000 may already be applied.

create or replace function public.validate_briefing_preferences()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.timezone is null or not exists (
    select 1 from pg_timezone_names where name = new.timezone
  ) then
    raise exception 'briefing timezone must be a valid IANA timezone';
  end if;
  if new.weekdays is null then
    raise exception 'briefing weekdays cannot be null';
  end if;
  if exists (
    select 1 from unnest(new.weekdays) as day
    where day <> lower(day) or day not in ('mon','tue','wed','thu','fri','sat','sun')
  ) then
    raise exception 'briefing weekdays contains an invalid day';
  end if;
  if cardinality(new.weekdays) <> (
    select count(distinct day) from unnest(new.weekdays) as day
  ) then
    raise exception 'briefing weekdays cannot contain duplicates';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists validate_briefing_preferences on public.briefing_preferences;
create trigger validate_briefing_preferences
before insert or update on public.briefing_preferences
for each row execute function public.validate_briefing_preferences();

create table if not exists public.briefing_test_sends (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  state text not null default 'claimed' check (state in ('claimed','sent','skipped','failed')),
  provider_id text,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists briefing_test_sends_owner_created_idx
  on public.briefing_test_sends (owner_id, created_at desc);

alter table public.briefing_test_sends enable row level security;
drop policy if exists briefing_test_sends_owner_read on public.briefing_test_sends;
create policy briefing_test_sends_owner_read on public.briefing_test_sends
  for select to authenticated using (owner_id = (select auth.uid()));

create or replace function public.claim_briefing_test_send(p_owner_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  claimed_id uuid;
begin
  if p_owner_id is null then raise exception 'owner is required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 90127));
  if exists (
    select 1 from public.briefing_test_sends
    where owner_id = p_owner_id and created_at > now() - interval '10 minutes'
  ) then
    return null;
  end if;
  insert into public.briefing_test_sends (owner_id) values (p_owner_id) returning id into claimed_id;
  return claimed_id;
end;
$$;

create or replace function public.finish_briefing_test_send(
  p_test_id uuid,
  p_state text,
  p_provider_id text default null,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if p_state not in ('sent','skipped','failed') then raise exception 'invalid test delivery state'; end if;
  update public.briefing_test_sends
  set state = p_state,
      provider_id = nullif(left(coalesce(p_provider_id, ''), 240), ''),
      error = nullif(left(coalesce(p_error, ''), 240), ''),
      finished_at = now()
  where id = p_test_id and state = 'claimed';
  return found;
end;
$$;

create or replace function public.finish_briefing_delivery(
  p_delivery_id uuid,
  p_lease_until timestamptz,
  p_state text,
  p_provider_id text default null,
  p_error text default null,
  p_retry_after_seconds integer default 0
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if p_state not in ('sent','skipped','failed') then raise exception 'invalid briefing delivery state'; end if;
  update public.briefing_deliveries
  set state = p_state,
      provider_id = nullif(left(coalesce(p_provider_id, ''), 240), ''),
      error = nullif(left(coalesce(p_error, ''), 240), ''),
      sent_at = case when p_state = 'sent' then now() else sent_at end,
      lease_until = case
        when p_state = 'failed' then now() + make_interval(secs => greatest(
          coalesce(p_retry_after_seconds, 0),
          least(1800, 30 * (2 ^ greatest(0, attempt_count - 1)))
        ))
        else null
      end
  where id = p_delivery_id
    and state = 'claimed'
    and lease_until = p_lease_until;
  return found;
end;
$$;

create or replace function public.purge_briefing_metadata()
returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  removed integer := 0;
  count_removed integer;
begin
  delete from public.briefing_deliveries where created_at < now() - interval '30 days';
  get diagnostics count_removed = row_count;
  removed := removed + count_removed;
  delete from public.briefing_test_sends where created_at < now() - interval '30 days';
  get diagnostics count_removed = row_count;
  return removed + count_removed;
end;
$$;

create or replace function public.claim_briefing_deliveries(batch_size integer default 50)
returns setof public.briefing_deliveries
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  now_utc timestamptz := now();
begin
  -- A row is created only during the two-hour window after the user's local
  -- scheduled time. The local timestamp comparison also handles windows that
  -- cross midnight and avoids a UTC/DST date assumption.
  insert into public.briefing_deliveries (owner_id, local_date)
  select p.owner_id, (now_utc at time zone p.timezone)::date
  from public.briefing_preferences p
  where p.enabled
    and lower(to_char(now_utc at time zone p.timezone, 'Dy')) = any(p.weekdays)
    and (now_utc at time zone p.timezone) >= ((now_utc at time zone p.timezone)::date + p.local_time)
    and (now_utc at time zone p.timezone) < ((now_utc at time zone p.timezone)::date + p.local_time + interval '2 hours')
  on conflict (owner_id, local_date) do nothing;

  return query
  with candidates as (
    select d.id
    from public.briefing_deliveries d
    join public.briefing_preferences p on p.owner_id = d.owner_id
    where p.enabled
      and lower(to_char(now_utc at time zone p.timezone, 'Dy')) = any(p.weekdays)
      and d.local_date = (now_utc at time zone p.timezone)::date
      and (now_utc at time zone p.timezone) >= ((now_utc at time zone p.timezone)::date + p.local_time)
      and (now_utc at time zone p.timezone) < ((now_utc at time zone p.timezone)::date + p.local_time + interval '2 hours')
      and d.attempt_count < 3
      and (
        d.state = 'scheduled'
        or (d.state = 'failed' and coalesce(d.lease_until, now_utc) <= now_utc)
        or (d.state = 'claimed' and coalesce(d.lease_until, now_utc) <= now_utc)
      )
    order by d.local_date, d.created_at
    for update of d skip locked
    limit greatest(1, least(batch_size, 100))
  )
  update public.briefing_deliveries d
  set state = 'claimed',
      attempt_count = d.attempt_count + 1,
      lease_until = now_utc + interval '10 minutes',
      last_attempt_at = now_utc,
      error = null
  from candidates c
  where d.id = c.id
  returning d.*;
end;
$$;

revoke all on function public.claim_briefing_test_send(uuid) from public, anon, authenticated;
revoke all on function public.finish_briefing_test_send(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.finish_briefing_delivery(uuid, timestamptz, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.purge_briefing_metadata() from public, anon, authenticated;
revoke all on function public.claim_briefing_deliveries(integer) from public, anon, authenticated;
grant execute on function public.claim_briefing_test_send(uuid) to service_role;
grant execute on function public.finish_briefing_test_send(uuid, text, text, text) to service_role;
grant execute on function public.finish_briefing_delivery(uuid, timestamptz, text, text, text, integer) to service_role;
grant execute on function public.purge_briefing_metadata() to service_role;
grant execute on function public.claim_briefing_deliveries(integer) to service_role;

-- Freeze the exact provider payload before the first network call. This keeps
-- a recovered claim byte-for-byte identical under the same Resend key while
-- column grants keep the rendered body out of client status reads.
alter table public.briefing_deliveries
  add column if not exists payload jsonb;

create or replace function public.prepare_briefing_delivery(
  p_delivery_id uuid,
  p_lease_until timestamptz,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  frozen jsonb;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or nullif(p_payload ->> 'recipient', '') is null
     or nullif(p_payload ->> 'from', '') is null
     or nullif(p_payload ->> 'subject', '') is null
     or p_payload ->> 'html' is null
     or p_payload ->> 'text' is null then
    raise exception 'invalid briefing payload';
  end if;
  if octet_length(p_payload::text) > 1048576 then
    raise exception 'briefing payload is too large';
  end if;

  update public.briefing_deliveries
  set payload = coalesce(payload, p_payload)
  where id = p_delivery_id and state = 'claimed' and lease_until = p_lease_until
  returning payload into frozen;
  if frozen is null then
    raise exception 'briefing delivery lease is no longer owned';
  end if;
  return frozen;
end;
$$;

revoke all on function public.prepare_briefing_delivery(uuid, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.prepare_briefing_delivery(uuid, timestamptz, jsonb) to service_role;

revoke select on public.briefing_deliveries from authenticated;
grant select (id, owner_id, local_date, state, attempt_count, last_attempt_at, sent_at, error, created_at)
  on public.briefing_deliveries to authenticated;

create or replace function public.finish_briefing_delivery(
  p_delivery_id uuid,
  p_lease_until timestamptz,
  p_state text,
  p_provider_id text default null,
  p_error text default null,
  p_retry_after_seconds integer default 0
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if p_state not in ('sent','skipped','failed') then raise exception 'invalid briefing delivery state'; end if;
  update public.briefing_deliveries
  set state = p_state,
      provider_id = nullif(left(coalesce(p_provider_id, ''), 240), ''),
      error = nullif(left(coalesce(p_error, ''), 240), ''),
      sent_at = case when p_state = 'sent' then now() else sent_at end,
      payload = case
        when p_state in ('sent','skipped') then null
        when p_state = 'failed' and attempt_count >= 3 then null
        else payload
      end,
      lease_until = case
        when p_state = 'failed' then now() + make_interval(secs => greatest(
          coalesce(p_retry_after_seconds, 0),
          least(1800, 30 * (2 ^ greatest(0, attempt_count - 1)))
        ))
        else null
      end
  where id = p_delivery_id
    and state = 'claimed'
    and lease_until = p_lease_until;
  return found;
end;
$$;

revoke all on function public.finish_briefing_delivery(uuid, timestamptz, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.finish_briefing_delivery(uuid, timestamptz, text, text, text, integer) to service_role;

create or replace function public.purge_briefing_metadata()
returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  removed integer := 0;
  count_removed integer;
begin
  -- A retryable body is useful only inside the two-hour late window. Clear it
  -- after that window even if the delivery row remains for status retention.
  update public.briefing_deliveries
  set payload = null
  where payload is not null
    and state in ('claimed','failed')
    and created_at < now() - interval '2 hours';

  delete from public.briefing_deliveries where created_at < now() - interval '30 days';
  get diagnostics count_removed = row_count;
  removed := removed + count_removed;
  delete from public.briefing_test_sends where created_at < now() - interval '30 days';
  get diagnostics count_removed = row_count;
  return removed + count_removed;
end;
$$;

revoke all on function public.purge_briefing_metadata() from public, anon, authenticated;
grant execute on function public.purge_briefing_metadata() to service_role;
