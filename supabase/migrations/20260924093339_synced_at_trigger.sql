-- Work Radar sync — Phase 2: synced_at is a server timestamp, always.
--
-- Both tables default synced_at to now() on insert, but a default only
-- covers a bare INSERT that omits the column — it does nothing for an
-- UPDATE, and it does nothing to stop a client explicitly passing a
-- synced_at value. So a trigger overwrites it unconditionally on every
-- insert AND every update, rather than relying on the default.
--
-- IMPORTANT — this makes synced_at trustworthy as "the server touched
-- this row", but it is NOT, by itself, a safe `gt(cursor)` pull cursor.
-- Two gaps for Phase 4 (the sync engine, which is the first phase that
-- actually pulls) to account for:
--
-- (a) now() is the transaction's start time, not its commit time, and a
--     row only becomes visible to other sessions once its transaction
--     commits. Two overlapping pushes can commit out of the order their
--     synced_at values suggest: machine 1's push starts at t=100 and
--     commits at t=105; machine 2 pushes at t=101, commits at t=102, and
--     pulls at t=103, seeing only its own row (synced_at=101) and
--     advancing its cursor to 101. Machine 1's row then commits with
--     synced_at=100 — *before* machine 2's cursor — and a naive
--     `gt(synced_at, cursor)` pull never sees it again.
-- (b) every row in one push_items/push_log_entries call gets the same
--     synced_at (one transaction, one now()), so a *paginated* pull that
--     stops partway through a batch (`gt(cursor).order(synced_at).limit(n)`)
--     can skip the rest of that batch.
--
-- Phase 4 must pull with a lookback window, not a bare `gt`, e.g.
-- `synced_at > cursor - interval 'a few minutes'` — safe because
-- mergeItem/unionLogs are idempotent, so re-seeing an already-merged row
-- is a no-op. `clock_timestamp()` instead of `now()` would narrow the
-- window in (a) but not close it (commit can still reorder after the
-- clock read), so the lookback stays required regardless. Any paginated
-- pull must use a keyset on (synced_at, id) — see the (user_id,
-- synced_at, id) index on both tables — never synced_at alone, to avoid
-- (b).
create or replace function public.set_synced_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.synced_at := now();
  return new;
end;
$$;

comment on function public.set_synced_at() is
  'Stamps NEW.synced_at with the server clock, ignoring any client-supplied '
  'value. Used as a BEFORE INSERT OR UPDATE trigger on items and log_entries.';

create trigger items_set_synced_at
  before insert or update on public.items
  for each row execute function public.set_synced_at();

create trigger log_entries_set_synced_at
  before insert or update on public.log_entries
  for each row execute function public.set_synced_at();
