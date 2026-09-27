-- Opt-in morning briefings. The recipient is always derived from auth.users;
-- clients only write preferences and cannot supply an email address.
create table if not exists public.briefing_preferences (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  timezone text not null default 'UTC',
  local_time time not null default '08:00',
  weekdays text[] not null default array['mon','tue','wed','thu','fri']::text[],
  updated_at timestamptz not null default now(),
  constraint briefing_preferences_timezone_not_empty check (length(timezone) > 0),
  constraint briefing_preferences_weekdays_valid check (
    weekdays <@ array['mon','tue','wed','thu','fri','sat','sun']::text[]
  )
);

create table if not exists public.briefing_deliveries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  local_date date not null,
  state text not null default 'scheduled' check (state in ('scheduled','claimed','sent','skipped','failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_until timestamptz,
  provider_id text,
  last_attempt_at timestamptz,
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  unique (owner_id, local_date)
);

create index if not exists briefing_deliveries_claim_idx
  on public.briefing_deliveries (state, lease_until, local_date);

alter table public.briefing_preferences enable row level security;
alter table public.briefing_deliveries enable row level security;

drop policy if exists briefing_preferences_owner_read on public.briefing_preferences;
create policy briefing_preferences_owner_read on public.briefing_preferences
  for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists briefing_preferences_owner_write on public.briefing_preferences;
create policy briefing_preferences_owner_write on public.briefing_preferences
  for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists briefing_preferences_owner_update on public.briefing_preferences;
create policy briefing_preferences_owner_update on public.briefing_preferences
  for update to authenticated using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
drop policy if exists briefing_deliveries_owner_read on public.briefing_deliveries;
create policy briefing_deliveries_owner_read on public.briefing_deliveries
  for select to authenticated using (owner_id = (select auth.uid()));

-- The scheduler calls this function through the service role. It creates at
-- most one row per owner/date, then claims rows with a short lease. The edge
-- function rechecks enabled preferences and the two-hour late-send window.
create or replace function public.claim_briefing_deliveries(batch_size integer default 50)
returns setof public.briefing_deliveries
language plpgsql
security definer
set search_path = public
as $$
declare
  now_utc timestamptz := now();
begin
  insert into public.briefing_deliveries (owner_id, local_date)
  select p.owner_id, (now_utc at time zone p.timezone)::date
  from public.briefing_preferences p
  where p.enabled
    and lower(to_char(now_utc at time zone p.timezone, 'Dy')) = any(p.weekdays)
    and (now_utc at time zone p.timezone)::time >= p.local_time
    and (now_utc at time zone p.timezone)::time < p.local_time + interval '2 hours'
  on conflict (owner_id, local_date) do nothing;

  return query
  with candidates as (
    select d.id
    from public.briefing_deliveries d
    where (d.state = 'scheduled' or (d.state = 'failed' and coalesce(d.lease_until, now_utc) <= now_utc))
      and d.attempt_count < 3
    order by d.local_date, d.created_at
    for update skip locked
    limit greatest(1, least(batch_size, 100))
  )
  update public.briefing_deliveries d
  set state = 'claimed', attempt_count = d.attempt_count + 1,
      lease_until = now_utc + interval '10 minutes', last_attempt_at = now_utc,
      error = null
  from candidates c
  where d.id = c.id
  returning d.*;
end;
$$;

revoke all on function public.claim_briefing_deliveries(integer) from public, anon, authenticated;
grant execute on function public.claim_briefing_deliveries(integer) to service_role;
