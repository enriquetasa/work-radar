# Supabase sync plan

Goal: keep Work Radar's data in sync between machines, using Supabase as the
shared backend while the app keeps working offline.

## Decisions

| Topic       | Choice                                                              |
| ----------- | ------------------------------------------------------------------- |
| Sign-in     | Magic link (default template, PKCE) caught by a loopback server.    |
| Offline     | Local-first. The JSON file stays the UI's source and offline cache. |
| Log entries | Own table, append-only — concurrent additions never clobber.        |
| Live sync   | Supabase Realtime in v1.                                            |

## Architecture

```
renderer (sandboxed, CSP unchanged)
   │ IPC: existing load/save + new auth/sync calls
main process
   ├─ local JSON file   ← UI source, offline cache, daily backups unchanged
   └─ sync engine (supabase-js) ── HTTPS / WSS ──▶ Supabase: Auth · tables · Realtime
```

- Supabase runs in the **main process**, which already owns all IO. The
  renderer stays sandboxed and its CSP is untouched.
- The auth session is persisted encrypted with Electron `safeStorage`.
- Only the **publishable** key ships in the app. The secret key never does —
  RLS is what protects the data.

Sync loop: local change → mark rows dirty → push. On startup, window focus and
each Realtime event → pull rows changed since the last cursor → merge into the
local file → re-render.

## Schema

```sql
create table items (
  id          text primary key,              -- keeps existing uid() ids
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null,
  status      text not null check (status in ('active','watch','dormant')),
  priority    text not null check (priority in ('critical','high','medium','low')),
  category    text not null default '',
  notes       text not null default '',
  added_at    timestamptz not null,
  updated_at  timestamptz not null,          -- client edit time: decides "newest wins"
  reviewed_at timestamptz not null,
  archived_at timestamptz,
  deleted_at  timestamptz,                   -- tombstone for PURGE
  synced_at   timestamptz not null default now()  -- server time, set by trigger: pull cursor
);

create table log_entries (                   -- append-only
  id        text primary key,
  item_id   text not null references items(id) on delete cascade,
  user_id   uuid not null default auth.uid() references auth.users on delete cascade,
  ts        timestamptz not null,
  text      text not null,
  synced_at timestamptz not null default now()
);

alter table items enable row level security;
create policy "own items" on items for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- same policy on log_entries
```

- **Two timestamps.** Machine clocks differ, so "what changed since X" uses the
  server clock (`synced_at`), while "which edit is newer" uses the client's
  `updated_at`.
- **Conditional push.** A plain upsert would let a stale offline edit overwrite
  a newer one, so pushes go through `supabase.rpc('push_items', …)`, which only
  updates when the incoming `updated_at` is newer.

## Sign-in flow

Custom email templates need custom SMTP, so the app uses the default Magic
Link email with the PKCE flow and a loopback redirect.

1. Main calls `signInWithOtp({ email, options: { emailRedirectTo, shouldCreateUser: false } })`
   with `flowType: 'pkce'`. supabase-js keeps a code verifier locally and sends
   only its challenge.
2. Main listens on `http://127.0.0.1:54390/auth/callback` (loopback only) for
   up to 10 minutes.
3. Clicking the email link verifies it and redirects the browser to the
   callback with `?code=…`.
4. The callback page says "you can close this tab"; main calls
   `exchangeCodeForSession(code)` and persists the session.

The link must be opened on the machine that is signing in, since only that
machine holds the verifier. The callback URL is both the Site URL and the only
allowed Redirect URL, locally (`supabase/config.toml`) and in the hosted
project. If port 54390 is taken, sign-in fails with a clear error rather than
picking another port, because the redirect allow-list is exact.

## Phases

Each phase is shippable on its own.

0. **Setup.** Create the project (EU region), enable Email auth with a
   10-minute link expiry, set Site URL and Redirect URLs to the callback
   address, create your user and disable sign-ups. Add the Supabase CLI,
   `supabase init`, `supabase link`, and confirm `supabase start` runs
   locally.
1. **Mergeable model (no Supabase yet).** Tombstones for purge, bump
   `updatedAt` on ping, ids on log entries, timestamp-aware merge in
   `domain.js`, schema v3 in `migrate`. Tests first.
2. **Database.** Migrations for both tables, RLS, the `synced_at` trigger and
   `push_items`. Tested against local Supabase, including an RLS test that user
   B can't read user A's rows.
3. **Auth.** Sign-in screen (email → "check your inbox"), persisted encrypted
   session, Sign out in the Radar menu. See [Sign-in flow](#sign-in-flow).
4. **Sync engine.** Push dirty, pull since cursor, retry offline. Header
   indicator (SYNCED · PENDING · OFFLINE · ERROR). Structured logs.
5. **First sync.** On first sign-in, upload the existing local file. On the
   second machine, merge local and remote rather than replacing.
6. **Realtime.** Subscribe to both tables. Each event triggers a normal pull
   (rather than trusting the payload), so there is a single ingest path.
7. **Packaging and docs.** `@supabase/supabase-js` as a runtime dependency,
   new main-process files in `build.files`, README update.

## Open items

- Work data (people and projects at Octopus) would live in a personal Supabase
  account. Check with security/IT before real data is uploaded — they may
  prefer a company-owned Supabase org. Phases 1–4 can be built against local
  Supabase with fake data in the meantime.
- Free projects pause after about a week of inactivity. With local-first this
  only delays sync until the project is resumed.
