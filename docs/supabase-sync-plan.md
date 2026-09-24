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
- **Sync/auth are entirely optional and never hardcoded.** The URL and
  publishable key come from `WORK_RADAR_SUPABASE_URL` /
  `WORK_RADAR_SUPABASE_KEY` env vars, or failing that a `sync-config.json`
  dropped into the app's `userData` directory. If neither is present, sync
  and auth are disabled and the app behaves exactly as it did before Phase
  3 — fully local, no sign-in UI shown at all. See "Phase 3 notes" below.

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

1. Main binds the loopback listener on `http://127.0.0.1:54390/auth/callback`
   (loopback only) for up to 10 minutes, and confirms it's actually listening
   — see "Phase 3 notes" below for why this comes first.
2. Main calls `signInWithOtp({ email, options: { emailRedirectTo, shouldCreateUser: false } })`
   with `flowType: 'pkce'`. supabase-js keeps a code verifier locally and sends
   only its challenge.
3. Clicking the email link verifies it and redirects the browser to the
   callback with `?code=…` (and, from supabase-js 2.117 on, `&sb_flow_id=…`).
4. The callback page says "you can close this tab and return to Work Radar";
   main calls `exchangeCodeForSession(code, flowId ? { flowId } : undefined)`
   and persists the session.

The link must be opened on the machine that is signing in, since only that
machine holds the verifier. The callback URL is both the Site URL and the only
allowed Redirect URL, locally (`supabase/config.toml`) and in the hosted
project. If port 54390 is taken, binding fails with a clear error — before any
email is sent — rather than picking another port, because the redirect
allow-list is exact.

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

## Phase 1 notes (mergeable model)

Implemented in `renderer/domain.js` / `renderer/app.js`, schema bumped to v3.
No Supabase code in this phase — it only makes the local JSON model safe to
merge later.

- **Tombstones, not deletes.** PURGE sets `deletedAt` (and bumps
  `updatedAt` like any other mutation) instead of removing the row.
  Tombstones stay in the data file — hidden everywhere in the UI
  (`D.stripTombstones`, and built into `D.selectVisible` /
  `D.buildReportHTML`) — so a later merge (import, or Supabase sync in a
  later phase) still sees the deletion instead of resurrecting it just
  because the other side never heard about it. This keeps the record's
  full content (name, notes, log text) forever — locally, in exports and
  later in Supabase — which is a deliberate trade-off for v1; a later
  phase could clear notes/log text on purge once sync no longer needs the
  full record to merge correctly.
- **`migrate()` catches `updatedAt` up to what v3 would have recorded.**
  Under schema v2 (and older), ping/archive/restore/addLogEntry did not
  bump `updatedAt`, so a legacy row's `updatedAt` can be older than its
  `reviewedAt`, `archivedAt`, or its newest log entry's `ts`. Without this,
  "newest `updatedAt` wins" would tie two v2-era copies that really differ
  in time and let the deterministic tie-break decide arbitrarily — e.g. an
  item archived-then-pinged under v2 on one machine, merged with an older
  backup where it's still live, coming back live with the older
  `reviewedAt` (undoing both the archive and the ping). `migrate()` fixes
  this by setting `updatedAt` to the max of `updatedAt`/`addedAt`,
  `reviewedAt`, `archivedAt`, `deletedAt` and every log entry's `ts`,
  ignoring whichever of those are missing. This is a no-op on v3 data,
  since every v3 mutation already sets `updatedAt` to at least those
  values, so it is safe to run on every load rather than only once at the
  v2→v3 boundary. When a row has neither `updatedAt` nor `addedAt` at all,
  the base for that max is `0`, not "now" — `now` would make two machines
  migrating the same broken row independently disagree on `updatedAt` (and
  so on who wins a later merge) purely because of when each one happened to
  migrate it; `0` (or the row's own newest log `ts`, via the same `Math.max`)
  is deterministic.
- **JSON export includes tombstones.** `serialize()` is unchanged — it
  already just dumps `items` and `arch` as they are, and tombstones live
  in `arch`. This is deliberate: export → import must round-trip a
  deletion the same way any other edit round-trips, via `mergeState`'s
  newest-`updatedAt`-wins rule, not a special case.
- **One merge rule for everything.** `mergeItem(a, b)` picks the whole
  record with the newer `updatedAt` (log aside) — this covers ordinary
  edits, archive, restore _and_ purge uniformly, because all of them bump
  `updatedAt`. A consequence, by design: an edit made after another
  machine purged the item resurrects it (later edit beats earlier
  tombstone); a purge made after another machine's edit deletes it (later
  tombstone beats earlier edit). The same whole-record rule also means a
  bare PING (which only bumps `reviewedAt`/`updatedAt`) can beat a
  concurrent notes/priority edit made on another machine before the two
  sync, if the ping happens later — "newest wins" doesn't distinguish "I
  reviewed this" from "I changed this". Acceptable for v1's coarse
  last-writer-wins; field-level merging would remove it later if it proves
  annoying in practice. Ties (identical `updatedAt`, different content) are
  broken deterministically: first numerically on `reviewedAt`, then
  `archivedAt`, then `deletedAt` (plain subtraction, so it stays symmetric),
  and only if all three are equal too does it fall back to a
  `JSON.stringify` comparison over a fixed, alphabetically sorted key list
  (excluding `log`) — sorting the keys matters once rows can arrive from
  Supabase, where field order isn't guaranteed. The numeric step exists
  because the text comparison alone compares numbers character by
  character (`"99"` sorts above `"100"`), so it would pick the older of two
  otherwise-equal `reviewedAt`s. Either way, the result never depends on
  which side is passed first or how its fields happen to be ordered, needed
  because a real merge has no "local" vs "remote", just two sides.
- **Every item mutation goes through a pure `domain.js` function**
  (`pingItem`, `archiveItem`, `restoreItem`, `purgeItem`, `addLogEntry`),
  not an inline patch inside `renderer/app.js`'s `Actions`. That is what
  makes the `updatedAt` bump (and, for purge, the tombstone) unit-testable
  under `node:test` — `Actions` is thin wiring that calls them and commits.
- **Log entries are unioned by id**, never diffed or ordered — each side's
  full log is kept, de-duplicated by id, sorted by `ts` (id as a
  deterministic tie-break for equal timestamps).
- **Legacy log ids are content-derived**, not random: `uid()` for new
  entries, but a legacy entry (schema v2 and older — no id) gets
  `itemId` and `ts` embedded verbatim plus a hash of `text` — only the
  free-text part is hashed, to keep the collision surface small, since
  `log_entries.id` becomes a global primary key in Phase 2. Two machines
  migrating the same old file independently must agree on that entry's id,
  or the union in `mergeItem` would treat it as two different entries.
  Two _identical_ legacy entries (same item, `ts`, and `text` — a real
  duplicate row) would otherwise hash to the same id and collapse into one
  on merge; `migrate` disambiguates them with a deterministic occurrence
  index, since both sides see the same file in the same array order.
  Malformed log entries are dropped during migration instead of throwing:
  `null` and anything that isn't an object outright, and — for an entry with
  no id of its own — anything without a finite numeric `ts`, since that `ts`
  is what `legacyLogId` needs to derive a stable id. `text` is coerced to a
  string (`String(e.text ?? '')`) rather than dropped, so an entry with a
  real `ts` but missing/`null` text is still kept.
- **Items move between live/archived across a merge.** `mergeState` merges
  the full union of both sides' `items` + `arch` by id, then re-splits the
  result by the winning `archivedAt` — so "archived on one machine, edited
  on the other" resolves to whichever side is newer, in whichever bucket
  that side says the item belongs.
- `mergeById` (the old naive "incoming overwrites" import merge) is
  removed; `Actions.mergeImported` in `app.js` now goes through
  `D.mergeState`.
- **Import failures are caught and logged, not left as unhandled
  rejections.** `Actions.importJSON` (Electron) and the browser-mode
  `FileReader` handler both wrap the `mergeImported`/`mergeState` call in
  `try/catch`, `console.error` it with context, and alert the user; the
  browser path also tells a JSON parse failure apart from a merge failure
  instead of always saying "not valid JSON".
- **`boot()` refuses to save over a failed load.** If `Store.load()` throws
  (e.g. a corrupt data file `migrate()` can't handle), `Store.items`/`arch`
  stay at their empty initial value; without a guard the error would go
  unlogged and the next add/commit would silently save that empty Store
  over the user's real data file. `boot()` now catches the error, logs it,
  alerts the user, and sets a flag that makes `scheduleSave` a no-op until
  the app is restarted.
- **PURGE's confirm dialog says what actually happens now.** The record
  (notes, log text) is kept as a tombstone, will be synced to other devices
  in a later phase, and a newer edit merged in from another machine can
  bring it back (see above) — so the dialog says "Removes it from this and
  synced devices" rather than the old "permanently ... cannot be undone",
  which stopped being true once purge became a tombstone.

## Phase 2 notes (database)

Implemented as five migrations under `supabase/migrations/`, applied and
linted against the local stack (`npx supabase db reset`,
`npx supabase db lint`). No app code talks to Supabase yet — this phase is
schema, RLS and two RPCs only, tested directly against local
Postgres/PostgREST.

- **Schema matches the plan as written**, adjusted for what Phase 1 actually
  built: `items` and `log_entries` have the columns above, snake_case,
  `timestamptz` throughout (the client's epoch-ms numbers convert at the
  sync-engine boundary in a later phase, not here). Two indexes per table:
  `(user_id, synced_at, id)` for the pull query — `id` is there for keyset
  pagination, see the `synced_at` caveat below — plus `log_entries(item_id)`
  for the cascade delete and the ownership check inside `push_log_entries`.
- **`log_entries.item_id` is a composite foreign key on `(item_id, user_id)`**,
  referencing `items (id, user_id)` (which needs its own `unique (id,
user_id)`, added alongside the primary key, purely so it can be an FK
  target), not a plain `references items(id)`. A foreign key check bypasses
  RLS entirely, so a single-column FK only proves the item exists somewhere
  — it says nothing about who owns it, and the insert policy on
  `log_entries` only checks the log entry's own `user_id`. Without the
  composite key, user B could call
  `.from('log_entries').insert({ item_id: <A's item>, user_id: B, ... })`
  directly through PostgREST and it would succeed: B's row would satisfy
  both RLS (`user_id = B`) and the plain FK (the item exists), attaching a
  log entry to an item B doesn't own — bypassing `push_log_entries`'s own
  ownership check entirely, since that check only runs inside the RPC. The
  composite FK closes this at the schema level: `(item_id, user_id)` must
  jointly match a row in `items`, so it fails for any `item_id` not owned
  by that same `user_id`, whichever path is used to insert.
- **No delete policy on either table, deliberately.** PURGE is a tombstone
  (`deleted_at` set via an ordinary update — see `mergeItem`'s doc comment
  in `renderer/domain.js` for why deletion has to merge like any other
  edit) and the log is append-only, so the app never issues a SQL `DELETE`
  against either table. Omitting the policy means RLS denies every
  `DELETE` by default for `anon` and `authenticated` — the only roles the
  app and PostgREST use, since row security is "deny unless a policy
  grants it". (The table owner, `postgres` and `service_role` bypass RLS
  entirely, and so does `TRUNCATE`, which is why `DELETE`/`TRUNCATE` are
  also explicitly revoked from `anon`/`authenticated` — Supabase grants
  them by default otherwise.) So even a compromised client, or the push
  RPCs acting as the caller (`security invoker`), physically cannot
  hard-delete a row through the normal API. Rows only disappear via
  `on delete cascade` from `auth.users`, which runs as the table owner and
  isn't subject to RLS. Covered by an integration test: the owner's own
  direct `.delete()` on each table is rejected outright with a
  `42501`/"permission denied" error — the explicit `revoke delete` means
  this fails before RLS even gets a chance to evaluate a policy and match
  zero rows, which is what would happen if only the missing policy were
  relied on.
- **`log_entries` gets no update policy either**, append-only by design
  (unioned by id on the client, never diffed — `domain.js`'s `unionLogs`).
  Nothing in the app or `push_log_entries` ever updates a row once
  inserted. Covered by an integration test: the owner's own direct
  `.update()` on a log entry affects zero rows and leaves it unchanged.
- **`synced_at` is set by a `before insert or update` trigger**
  (`set_synced_at()`), not just a column default — a default only covers
  a bare `INSERT` that omits the column; it does nothing for `UPDATE` and
  nothing to stop a client passing its own value. The trigger overwrites
  `NEW.synced_at` unconditionally on every write. Verified directly in the
  integration tests by updating a row with a forged `synced_at` and
  asserting it comes back current.
  **This makes `synced_at` trustworthy as "the server touched this row",
  but it is not by itself a safe `gt(cursor)` pull cursor** — see the
  `synced_at_trigger` migration's comment for the full reasoning. In short:
  `now()` is transaction-start time, not commit time, so overlapping pushes
  can commit in an order their `synced_at` values don't reflect, and a
  naive cursor can permanently skip a row committed "late". And every row
  in one push shares one `synced_at`, so a paginated pull that stops
  partway through a batch can skip the rest of it. Phase 4 (the sync
  engine, which is the first phase that actually pulls) must pull with a
  lookback window rather than a bare `gt` — safe because `mergeItem`/
  `unionLogs` are idempotent — and must paginate on a `(synced_at, id)`
  keyset, never `synced_at` alone.
- **`push_items` / `push_log_entries` are `security invoker`, `set search_path
= ''`.** Invoker means RLS applies exactly as if the caller ran the SQL
  themselves — no privilege escalation — and both still force
  `user_id = auth.uid()` from the session, never from the payload, so a
  caller can't push rows into someone else's account by forging a
  `user_id` field. `search_path = ''` means every reference is
  schema-qualified (`public.items`, `auth.uid()`); `pg_catalog` — where
  `jsonb_array_elements`, `now()`, etc. live — stays implicitly searched
  even with an empty path, so only table/function names outside it need
  qualifying. `EXECUTE` on both is granted to `authenticated` only; the
  `revoke all ... from public` line doesn't actually cover `anon` (Supabase
  grants `anon` `EXECUTE` on new functions by default, independently of
  `public`), so it's revoked from `anon` explicitly too — harmless either
  way, since both raise when `auth.uid()` is null, but the SQL should say
  what it means.
- **The returned column is `row_id`, not `id`.** `plpgsql` implicitly
  declares each `returns table` column as a variable, and a bare `id`
  inside the function body is then ambiguous with the `items.id` /
  `log_entries.id` columns referenced in the same statements —
  `supabase db lint` caught this (`column reference "id" is ambiguous`)
  before it ever ran. `row_id` sidesteps it instead of schema-qualifying
  every column reference in every statement.
- **Each row in a push batch is applied inside its own
  `begin ... exception when others ... end`** and reported back
  individually as `{row_id, accepted, reason}`, so one bad row — a failed
  check constraint, a stale update, a missing parent item — never aborts
  the rest of the batch or rolls back the whole call.
- **Item-before-log-entry ordering and the FK.** The client is expected to
  push items before their log entries (a later sync-engine phase), but a
  batch can still race ahead of that — a superseded earlier batch, a
  retry, simple reordering. Rather than let the `item_id` foreign key
  raise and abort the whole `push_log_entries` call, the function checks
  ownership up front with an `exists` query against `items` and reports
  `reason = 'item_not_found'` for that one row, leaving the rest of the
  batch unaffected. The sync engine can retry a rejected log entry once
  its item has synced, rather than needing a strict global order. That
  same check folds "item doesn't exist yet" and "item belongs to someone
  else" into one rejection from the RPC — it does not hide whether an id
  exists at all (`items.id` is a global primary key, so a colliding
  `push_items` insert already reveals existence, just with a different
  rejection reason); what it and the composite FK above actually prevent
  is a log entry ending up attached to an item this caller doesn't own.
- **`push_items`'s "newest wins" is enforced in the `on conflict ... do
update ... where` clause**: `public.items.user_id = caller and
excluded.updated_at > public.items.updated_at`. A stale incoming
  `updated_at`, or an id that collides with a row owned by someone else,
  makes the update affect zero rows, reported as
  `reason = 'stale_or_not_owned'` rather than an error. The
  `items_update_own` RLS policy enforces the same ownership boundary
  independently underneath.
  **Known gap, not fixed here:** this compares `updated_at` only, but the
  client's `mergeItem` breaks a tie on equal `updated_at` by comparing
  `reviewed_at`, then `archived_at`, then `deleted_at`, then a
  `JSON.stringify` of the whole row — so on an exact `updated_at` tie with
  different content, the server and a client's local merge can pick
  different winners and never converge on their own (rare: needs identical
  millisecond timestamps). Reproducing that exact chain in SQL isn't
  practical — the `JSON.stringify` fallback has no SQL equivalent that
  agrees with it row for row — so instead of a `WHERE` clause that only
  partially agrees with `mergeItem`, Phase 4 should: when a push is
  rejected as `stale_or_not_owned` for a row this user owns and the local
  merge still prefers the local version, re-stamp its `updated_at` and push
  again.
- **Both tables are added to the `supabase_realtime` publication now**
  (`alter publication supabase_realtime add table ...`), even though
  nothing subscribes until Phase 6, so the migration set the plan asks
  for is complete in one phase. RLS still applies to Realtime's
  changefeed, so this doesn't expose anything cross-user by itself.
- **`@supabase/supabase-js` is a runtime dependency** (`dependencies`, not
  `devDependencies`) — the main process will need it starting Phase 3.
- **Integration tests live under `test/integration/`** and run via
  `npm run test:integration`; `npm test` now runs `test/*.test.js`
  (non-recursive), so it stays fast and Docker-free while integration
  tests in a subdirectory are excluded automatically.
  `test/integration/sync.test.js` reads the local stack's URL and keys
  fresh from `npx supabase status -o json` on every run (never
  hardcoded), creates two throwaway users through the admin API with
  per-run random passwords, and asserts: RLS isolation (including that B
  cannot attach a log entry to A's item, directly or via the RPC); newest-
  wins on `push_items`; the `synced_at` trigger and its use as a pull
  cursor (using the server's own returned timestamps as the cursor, not
  the test machine's clock); log-entry append-only/idempotent behaviour
  (a re-push with changed content is rejected and the stored row is
  unchanged); and that direct `UPDATE`/`DELETE` by the owner, where no
  policy grants them, affect zero rows. Cleanup is centralised in the
  suite's `after` hook, which deletes both users — the cascade removes
  every row they created, so no test cleans up its own rows.

## Phase 3 notes (auth)

Implemented under `sync/` (main-process-only CommonJS modules, no Electron
dependency except where noted) plus thin wiring in `main.js`/`preload.js`
and a small sign-in affordance in `renderer/`. No sync engine yet —
Phase 3 only gets a session; pushing/pulling rows is Phase 4.

- **Every piece of logic that isn't Electron itself lives in a plain,
  dependency-injected Node module under `sync/`**, so it's unit-testable
  under `node:test` without Electron or a live network call — the same
  split the rest of the app already uses between `domain.js` (pure) and
  `main.js`/`app.js` (DOM/IO/Electron wiring):
  - `sync/config.js` — resolves the URL/key, or reports that sync is
    disabled (`{ configured: false }`); `readFileSync` and `log` are
    both injected — `log` the same way `callback-server.js` and
    `auth-service.js` already do it — so tests never touch the real
    filesystem or spam stdout with the warn-path structured logs.
  - `sync/session-storage.js` — the storage adapter handed to
    supabase-js's `auth.storage` option. `encrypt`/`decrypt` are
    injected (Electron `safeStorage` in `main.js`, a reversible XOR fake
    in tests) — this module never imports Electron.
  - `sync/callback-request.js` — pure parsing of the loopback redirect's
    query string into either a success (`ok: true`, plus `code` and any
    `flowId`) or a failure (`ok: false`, plus `error` and
    `errorDescription`).
  - `sync/callback-server.js` — the one piece that's necessarily
    `node:http`, kept as thin as possible around
    `callback-request.js`'s parsing; `port`/`host`/`timeoutMs`/`log` are
    injectable so tests can use throwaway ports, short timeouts and a
    silent logger instead of the real 54390 / 10 minutes / stdout.
  - `sync/auth-service.js` — orchestrates `signInWithOtp` → wait for the
    callback → `exchangeCodeForSession`, plus `signOut`/`getStatus`/
    `onChange`. The supabase-js `client` and `waitForCallback` are both
    injected, so the whole flow is tested with fakes
    (`test/sync-auth-service.test.js`) as well as for real
    (`test/integration/auth.test.js`).
  - `sync/auth-client.js` — the one place that actually calls
    `createClient`; thin enough (no branching) that it isn't separately
    unit-tested, the same way `preload.js` isn't.
  - `sync/validate.js` — `isValidEmail`, used at the IPC boundary in
    `main.js` before anything reaches supabase-js.
  - `renderer/auth-view.js` — the one piece of `Auth.render()`'s logic
    that's pure (which panel to show, and whether to clear `#auth-error`
    — see the `render()` bullet below), so it's unit-tested the same way
    (`test/auth-view.test.js`) despite living in `renderer/`.
- **`signIn()` tags every log line one attempt produces — start, bind
  failure, OTP, callback, exchange — with a short `attemptId`**
  (`crypto.randomUUID()`), so concurrent or successive attempts can be
  told apart in the logs, per the observability rule. This includes a
  rejection of `pending.result` itself (a Supabase `?error=` redirect, a
  timeout, or a cancel) — found in review: that path used to be logged
  only by the callback server (no `attemptId`) and by `main.js`'s
  generic "sign-in failed" (also no `attemptId`), so the most common
  failure had no line correlating it with the rest of the attempt.
- **`signOut()` treats a server-side error as a warning, not a hard
  failure, when `getSession()` afterwards shows no session.** auth-js's
  own `_signOut` clears the local session even when the server call
  fails (e.g. offline), and still returns that error — throwing
  regardless would make `main.js` log "sign-out failed" and the Radar
  menu's click handler log it too, although the user really is signed
  out locally. It still throws if the local session is somehow still
  present.
- **One encrypted file, one JSON blob.** `session-storage.js` doesn't map
  supabase-js keys to separate files — it reads/decrypts the whole file
  into an object, mutates one key, re-encrypts and atomically rewrites
  it (temp file + rename, same pattern as the main data file). This
  matters because supabase-js's PKCE flow stores _two_ keys under one
  `storage` — the session itself (`sb-<ref>-auth-token`) and the code
  verifier (`sb-<ref>-auth-token-code-verifier`) written during
  `signInWithOtp` and read back during `exchangeCodeForSession` — and
  both need to survive in the same place.
- **A corrupt or undecryptable session file degrades to "no session",
  never a crash.** `getItem` catches a decrypt/parse failure, logs a
  warning with context (via an injectable `log`, same pattern as
  `config.js`, `callback-server.js` and `auth-service.js` — found in
  review, since this module used to reach for the module-level logger
  directly and a unit test exercising this path always printed to
  stdout), and returns `null` — supabase-js then just treats the user as
  signed out, same as a first run. The trade-off (flagged in review, left
  as-is): the very next `setItem` (e.g. a PKCE verifier written on the
  next sign-in attempt) then overwrites the file from an empty store, so
  a keyring that's briefly unavailable at startup would silently drop a
  still-valid session rather than just failing to read it. This is
  recoverable by signing in again, so it's treated as an accepted
  trade-off rather than data loss; moving an undecryptable file aside
  (e.g. to `.corrupt`) instead of overwriting it is a possible later
  improvement, not done here.
- **`safeStorage` unavailability disables auth, not the app.**
  `main.js`'s `buildAuthService()` checks
  `safeStorage.isEncryptionAvailable()` (false on a Linux box with no
  keyring/D-Bus secret service, which includes this dev container)
  before building anything, and returns `null` — logged as an error —
  rather than persisting an unencrypted session or throwing. Every IPC
  handler and the Radar menu treat a `null` authService exactly like
  "sync not configured": no sign-in UI, no Sign Out menu item. This is
  also why Phase 3 was verified with the unit suite plus a real
  `sync/auth-*` integration test against local Supabase rather than by
  running the packaged Electron app on this machine — see "Environment"
  in the task that produced this phase.
- **The loopback server is intentionally minimal and single-shot.** One
  `http.createServer`, listens only on `127.0.0.1:54390`, and `finish()`
  closes it on the _first_ request that parses as either a code or an
  error — a stray request to any other path 404s without settling
  anything. `Connection: close` is set on the settling response so
  `server.close()` doesn't linger on a keep-alive socket (observed
  adding ~3s per test before this header was added), and
  `server.closeAllConnections()` (Node 18.2+) is called right after, so a
  lingering (e.g. preconnect) socket can't hold the close up either.
  EADDRINUSE is surfaced as a plain rejection, not retried on another
  port — see the "Sign-in flow" section above for why that would just
  make the Supabase-side redirect allow-list fail instead.
- **`waitForCallback()` returns `{ listening, result, cancel }`, not one
  promise.** `listening` settles as soon as the port is bound (or rejects
  with a clear "Port 54390 is in use by another program — close it and
  try again" on EADDRINUSE); `result` settles the way the callback used
  to. `auth-service.js`'s `signIn()` awaits `listening` — and so binds
  the port — _before_ calling `signInWithOtp`, because a magic-link email
  already sent when the bind then fails can't be un-sent and both the
  local and hosted rate limits on it are tight. If `signInWithOtp` itself
  errors after the port is already bound, `signIn()` calls `cancel()`
  rather than leaving the listener running for the rest of the timeout.
- **The failure page HTML-escapes `error`/`error_description`, and caps
  their reflected length.** Both come straight off the query string of a
  request anyone can send to the loopback port while a sign-in is
  pending, so without escaping, a crafted redirect (or a local process)
  could run script on that origin — found in review and fixed with a
  failing-test-first regression in `test/sync-callback-server.test.js`.
  Every response from the server (success, failure or 404) also carries
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`
  and `X-Content-Type-Options: nosniff` as defence in depth. The success
  page's wording is the plan's own ("You can close this tab and return
  to Work Radar."), not a claim of having signed in — it's served before
  `exchangeCodeForSession` runs.
- **`sb_flow_id` is parsed off the callback and passed through.**
  supabase-js 2.117 appends `?sb_flow_id=<id>` to `emailRedirectTo`, and
  `exchangeCodeForSession(code, flowId ? { flowId } : undefined)` uses it
  instead of relying only on the fixed `<key>-code-verifier` storage
  entry, which auth-js itself calls a "deprecation-window dual write"
  that a future version could drop.
- **`signIn()` refuses a second concurrent call** rather than starting a
  second loopback listener (which would hit the same EADDRINUSE). A
  second attempt (e.g. a renderer double-submit — the optimistic
  "CHECK YOUR INBOX" state should already prevent this, but it's cheap
  insurance) throws immediately with a clear message instead of the
  confusing lower-level port error. `getStatus()` and every state pushed
  through `onChange` also carry a `pending` flag mirroring this, so a
  renderer that reloads mid-sign-in (`authStatus()` on init) shows "CHECK
  YOUR INBOX" again instead of the form, rather than only discovering the
  conflict by trying to submit and getting "already pending" back.
- **`signIn()` also refuses to start when a session already exists**
  (checked via `getStatus()`, right after the pending flag but still
  before the loopback listener is ever started) — the IPC handler in
  `main.js` accepted this before, and the service would happily emit
  `{ signedIn:false, pending:true }` for an already-signed-in user,
  briefly making the renderer look signed out.
- **`session-storage.js` serialises every `getItem`/`setItem`/
  `removeItem` through one per-instance promise queue**, and each write
  uses a unique `<file>.<pid>.<uuid>.tmp` path rather than a fixed
  `<file>.tmp`. auth-js is lockless in Node and expects overlapping calls
  (e.g. an autoRefresh save racing a sign-out's removal); each call is a
  read-modify-write over the whole file, so without either fix, two
  overlapping calls could drop each other's key or race on the same tmp
  path.
- **IPC surface**: `auth:status` (`{ configured, signedIn, email, pending }`
  or just `{ configured: false }`), `auth:signIn` (email —
  validated with `sync/validate.js` in `main.js` _before_ it reaches
  supabase-js; invalid input never starts a loopback server),
  `auth:signOut`, and a main → renderer push on `auth:stateChanged`
  driven by `authService.onChange` (itself wired to supabase-js's own
  `onAuthStateChange`, so a token refresh or an external sign-out is
  reflected too, not just this app's own sign-in/out calls).
- **Renderer**: `#auth-panel` starts `hidden` in `index.html` and is only
  ever unhidden after `authStatus()` reports `{ configured: true }` — so
  browser-fallback mode and an unconfigured desktop app show zero
  sign-in UI, per the plan. This depends on `app.css` not overriding the
  browser's built-in `[hidden] { display: none }` for these elements —
  found in review: `#auth-panel`/`#auth-form` both set `display: flex`
  in their own rules, which beats that default, so the `hidden`
  attribute alone did nothing and the form stayed visible regardless of
  `configured`/pending/signed-in state. Fixed with a scoped
  `#auth-panel[hidden], #auth-form[hidden] { display: none; }` rule
  (the `.auth-status` spans have no display override, so they already
  hid correctly on their own) and a regression test
  (`test/renderer-css.test.js`) asserting the override rule is present,
  since there's no jsdom/browser engine here to exercise the cascade
  itself. Submitting the email form flips to "CHECK
  YOUR INBOX" _before_ awaiting `authSignIn()` (which doesn't resolve
  until the whole round trip finishes or fails), then relies on the
  `auth:stateChanged` push to flip to the signed-in state — a failure
  instead shows the error and reverts to the form. On init/reload,
  `status.pending` renders the same "CHECK YOUR INBOX" state directly,
  ahead of any push. Sign Out is a Radar menu item (`main.js`'s
  `buildMenu()`), added only when `authService` is non-null, per the
  plan; it isn't yet disabled while signed out (left for a later pass —
  clicking it while signed out is a harmless no-op against a client with
  no session).
- **`render()` only clears `#auth-error` on a genuine transition into
  signed-in or pending, never on the signed-out/not-pending branch.**
  That branch is also what a _failed_ sign-in settles into: `signIn()`'s
  `finally` block pushes the settled `{ signedIn:false, pending:false }`
  status asynchronously (it awaits its own `getStatus()` and a file
  read), which arrives _after_ the IPC error reply — found in review and
  reproduced with an ordering script.
  Without this, that push reached `render()` and hid the very message
  `showError()` had just shown, for every failure (port in use, rate
  limit, disallowed signup, timeout, bad code). The view/clear-error
  decision is a pure function, `renderer/auth-view.js`'s
  `computeAuthView()` (unit-tested in `test/auth-view.test.js`), since
  there's no renderer DOM test harness to exercise `render()` itself.
- **On Linux, `buildAuthService()` also checks
  `safeStorage.getSelectedStorageBackend()`.** `isEncryptionAvailable()`
  can be `true` there with the `basic_text` backend (no keyring/D-Bus
  secret service), which encrypts with a hardcoded key rather than an
  OS-backed one. Auth still proceeds — refusing to persist a session at
  all would be worse — but this logs a warning so it's not a silent
  downgrade.
- **Integration test** (`test/integration/auth.test.js`) drives the real
  flow end to end against local Supabase: admin-creates a confirmed
  user, calls the real `sync/auth-service.js` `signIn()`, polls
  Mailpit's HTTP API (`GET /api/v1/messages`, then
  `/api/v1/message/:id`) for the magic-link email and regex-extracts the
  `.../auth/v1/verify?...` URL from its plain-text body, `fetch()`es
  that link with `redirect: 'follow'` so the 303 it returns actually
  reaches the real loopback server on 54390, and asserts: `signIn()`
  resolves, `getStatus()` reports the right email, the session file on
  disk is not plaintext and decrypts (via the test's fake XOR
  encryptor) to a session whose `user.email` matches, and a _second_,
  independently-constructed client/service reading that same file comes
  back already signed in (the "restorable" requirement) with no further
  network call. Cleanup deletes the admin-created user in `after`, same
  pattern as `test/integration/sync.test.js`. No rate-limit bump to
  `supabase/config.toml` was needed to get this passing repeatably.
- **Deliberately left as-is, from review**: a `Host` header check on the
  loopback server (only a denial-of-service against a pending sign-in —
  PKCE already stops a code-injection takeover — and the review flagged
  it as optional); and disabling the Radar menu's Sign Out item while
  already signed out (harmless no-op, already called out above as
  deferred to a later pass). Both are still open, not forgotten.

## Phase 4-5 notes (sync engine, first sync)

Implemented in `sync/sync-engine.js`, plus small pure helper modules it
depends on (`sync/mapping.js`, `sync/outbox.js`, `sync/sync-state.js`,
`sync/keyset.js`, `sync/classify-error.js`, `sync/stale-remediation.js`,
`sync/atomic-json-file.js`) and thin wiring in `main.js`/`preload.js`/
`renderer/app.js`. Built in one pass rather than two separate phases —
first sync (Phase 5) turned out to be almost entirely outbox bookkeeping
(“mark everything pending”) inside the same engine, not a separate code
path, so splitting it into its own commit would have meant re-opening
`sync-engine.js` immediately after.

- **Everything that isn't Electron is a plain, dependency-injected
  module**, same split as Phase 3's `sync/auth-*`. `sync/sync-engine.js`
  takes the one supabase-js `client` main.js already built for auth (see
  `buildSyncEngine()` in `main.js` — it shares auth's client rather than
  creating a second one) plus four push/pull functions that default to
  real implementations built from `client`, but can be overridden
  directly. This is the main testability decision of the phase: faking
  four plain async functions (`pushItemsRpc`, `pushLogEntriesRpc`,
  `pullItemsPage`, `pullLogEntriesPage`) is far simpler and more
  reliable than mocking the full `.from(...).select(...).gt(...).or(...)`
  PostgREST builder chain, and `test/sync-engine.test.js` does exactly
  that. `test/integration/sync-engine.test.js` then exercises the real
  default implementations against local Supabase.
- **The outbox is computed by main, never reported by the renderer.**
  `sync/outbox.js`'s `snapshotOf(data)` reduces a data file to `{ items:
{id: updatedAt}, logEntryIds: [...] }` — enough to answer "did this
  change since the last time the engine looked?" — and
  `diffSnapshot(prev, next)` is the actual diff: an item is pending if
  its id is new or its `updatedAt` moved; a log entry is pending if its
  id is new (log entries never change once written, so that's the only
  way one can need pushing). `sync-engine.js`'s `recordLocalSave()` runs
  this diff on every `data:save`, comparing the merged result against
  the last snapshot persisted in `sync-state.json` — the renderer's
  payload is just data, not a change list.
- **`sync-state.json`** (`sync/sync-state.js` for the shape,
  `sync/atomic-json-file.js` for the atomic read/write — same temp-file-
  then-rename pattern as the main data file and Phase 3's
  `session-storage.js`) lives in `userData` next to the data file and
  persists, per signed-in user id (not just "this machine" — a machine
  could in principle sign out and into a different account):
  `pendingItemIds`/`pendingLogEntryIds` (the outbox), `itemsCursor`/
  `logEntriesCursor` (ms epoch, or `null` before the first pull),
  `snapshot` (outbox.js's shape, for the next diff) and `firstSyncDone`.
  Keying by user id, not machine, is what makes "first sync" correct if
  the same machine is ever signed into a second account.
- **One mapping module, two shapes, unit-tested with round-trip tests.**
  `sync/mapping.js` is the only place ms-epoch numbers (domain.js's
  internal representation) convert to/from `timestamptz`: `itemToPushRow`/
  `logEntryToPushRow` produce the camelCase-with-ISO-strings shape
  `push_items`/`push_log_entries` expect, `rowToItem`/`rowToLogEntry`
  consume the snake_case-with-ISO-strings shape a plain `select('*')`
  pull returns. `archivedAt`/`deletedAt` come back as `undefined` (not
  `null`) when unset, matching domain.js's own convention.
- **Push order is items then log entries, in batches** (`pushBatchSize`,
  default 200), per the plan and because `push_log_entries` rejects a
  row as `item_not_found` until its parent item has synced. A rejected
  log entry just stays in the outbox — retried once the item itself
  succeeds, no strict global ordering needed beyond "try items first
  every cycle" (see the Phase 2 notes on why the RPC is built to allow
  this rather than erroring).
- **The known `stale_or_not_owned` tie-break gap is handled, not just
  documented.** `sync/stale-remediation.js`'s `localWinsOverRemote`
  answers "does the client's own `mergeItem`, given both versions,
  actually still prefer the local one?" — using `mergeItem` itself
  (injected, so this has no dependency on `renderer/`), not a
  reimplementation of its tie-break chain. `sync-engine.js` only fetches
  the remote row and re-stamps+leaves-pending on that rare exact-
  `updated_at`-tie disagreement, never on an ordinary "remote is
  genuinely newer" rejection (see `push_rpc_functions.sql`'s comment for
  why the RPC can't reproduce the full chain in SQL).
- **Pull uses a lookback window and (synced_at, id) keyset pagination**,
  per the `synced_at_trigger` migration's own comment on why a bare
  `gt(cursor)` isn't safe: `sync/keyset.js`'s `pullAll` starts each pull
  from `cursor - lookbackMs` (or the epoch, for a brand-new machine's
  first pull ever) and pages using `keysetOrFilter`, the standard
  two-clause PostgREST expansion of a compound-key `>` comparison
  (`synced_at > X OR (synced_at = X AND id > Y)`) — needed because every
  row in one push shares a single `synced_at`, so a page boundary can
  fall inside a batch. Re-pulling the lookback window on every cycle is
  safe because `mergeItem`/`unionLogs` are idempotent.
- **The cursor (and the outbox snapshot) are persisted only after the
  merge has actually been written to disk**, covered by a unit test
  asserting write order. A crash in between just re-pulls the same
  (idempotent) rows next cycle instead of losing them. The snapshot is
  refreshed on every pull-driven write too, not just on `recordLocalSave`
  — without this, an item nobody edits locally again (pulled once, never
  touched) would have no snapshot entry and get flagged "changed" (by
  the diff, which has never _seen_ its `updatedAt` before) on every
  future local save forever — harmless (the resulting push is rejected
  as `stale_or_not_owned`) but noisy.
- **Items are pulled and merged in fully before log entries are even
  requested**, mirroring the push order. This turns "a log entry's
  parent item is already on disk by the time it's processed" from a
  race into a guarantee: `log_entries.item_id` is a composite FK on
  `items(id, user_id)`, so a log entry can only exist in the database
  once its item does, and by pulling items first every cycle, any item
  this account has ever synced is on disk before its log entries are
  grouped and merged in. Log entries pulled for an item id somehow not
  found locally (should be unreachable given the above) are logged as
  an error and the log-entries cursor is _not_ advanced for that cycle,
  rather than silently dropping them.
- **The save race**: main merges an incoming `data:save` payload with
  what's currently on disk (`recordLocalSave`, via the Phase 1 domain
  merge) instead of overwriting it outright, per the option the plan's
  Phase 4 line calls out. This is what stops a renderer save that was
  queued before a background pull just merged in a remote change from
  clobbering it — the merge is exactly the same "newest `updatedAt`
  wins" rule that already reconciles two machines, applied here to
  reconcile "the renderer's stale view" against "what main just wrote".
  `main.js`'s `data:save` handler only takes this path while the sync
  engine is actually running (`syncEngineRunning`); fully local mode is
  unchanged. Covered by a unit test that seeds a newer "already pulled"
  version on disk and asserts a stale save can't undo it.
- **Triggers**: startup (`start()`, once signed in — called from
  `authService.onChange()` in `main.js`, never on its own), window focus
  (`BrowserWindow`'s own `focus` event, wired in `createWindow()` so a
  window recreated after all windows close on macOS still gets it), a
  60-second interval (`setInterval` inside `start()`), and a debounced
  trigger after `recordLocalSave` (default 3s, resets on every save so a
  burst of edits pushes once, shortly after the burst ends). All four
  funnel through the same `triggerNow()`, which coalesces overlapping
  triggers into at most one cycle running at a time and re-runs once
  more immediately after if another trigger fired mid-cycle, rather than
  queuing an unbounded backlog.
- **Retry with backoff, classified offline vs error.**
  `sync/classify-error.js` is a best-effort heuristic (there's no
  `navigator.onLine` in the main process, and supabase-js doesn't tag
  its own errors as network-vs-other) over the shapes `fetch`/undici and
  Postgres actually produce, erring towards OFFLINE on an ambiguous bare
  `TypeError` since a network blip is far more likely in practice than a
  genuinely new failure mode. A cycle that throws schedules a retry via
  `triggerNow()` at `min(backoffMaxMs, backoffBaseMs * 2^attempts)`
  (defaults 2s base, 5 min cap); any cycle that completes without
  throwing resets the backoff, regardless of whether it ended `pending`
  (row-level rejections, e.g. `item_not_found` waiting on its item) or
  `synced`.
- **Status in the header**: `SYNCED` (nothing pending) `· PENDING`
  (outbox non-empty, or the last save just queued something) `·
OFFLINE · ERROR`, pushed over `sync:stateChanged` (`{ state }`, `state`
  `null` meaning "hide it") and rendered by the pure
  `renderer/sync-view.js`'s `computeSyncView` — same dual-mode
  (browser global + CommonJS-under-node:test) pattern as `domain.js`/
  `auth-view.js`, and the same reason: there's no DOM test harness here,
  so the view/hide/colour-class decision is pulled out to be unit-
  testable on its own. Colour-keyed to the palette `domain.js` already
  uses for status/priority (green=SYNCED, amber=PENDING, grey=OFFLINE,
  red=ERROR). Lives in `#auth-panel` next to the sign-in status, hidden
  until main ever pushes a real state — which only happens once sync is
  configured _and_ signed in, and main explicitly pushes `{ state: null
}` on sign-out to hide it again, per the plan's "hidden when sync
  isn't configured, and a signed-out state" requirement.
- **Reload after a pull-driven merge** is a main → renderer push
  (`sync:reload`, no payload) rather than main handing the renderer the
  merged data directly — the renderer's `Store.load()` is already the
  single path that reads the data file and runs the Phase 1
  dedup-through-`mergeState` pass on load, so reusing it here (via a new
  `Sync.reload()` in `app.js`) means there is exactly one "read the data
  file into `Store`" code path, not two that could drift.
- **First sync (Phase 5) is outbox bookkeeping, not a data-copying
  step.** `bootstrapFirstSyncIfNeeded()` runs as the first step of every
  cycle; if `firstSyncDone` is false for this user, it reads the current
  data file, adds every existing item id and log entry id to the
  outbox, snapshots the file, and sets `firstSyncDone` — all persisted
  _before_ the push that follows, so a crash mid-first-sync retries the
  whole thing next cycle rather than silently skipping it (re-marking
  already-pushed ids is a harmless no-op; the RPCs are idempotent).
  Nothing here touches local data or bypasses the ordinary push-then-
  pull-then-merge that follows in the same cycle, which is what makes
  "never replace local data with remote data" fall out of the design
  rather than needing a special case: the first cycle pushes this
  machine's own data before it ever pulls anything, and every pull from
  then on (first or not) goes through the same union-based `mergeState`.
  Covered by an integration test with two machines that each have
  data before ever syncing, including an overlapping id where the
  genuinely newer copy must win on both sides afterward.
- **Structured logs**: every cycle logs one `sync cycle complete` (or
  `sync cycle failed`) line with a `cycleId` (`crypto.randomUUID()`,
  correlating every line one cycle produces — same pattern as Phase 3's
  `attemptId`), duration, per-table push/pull counts, and the resulting
  status; individual row rejections and the stale-push remediation path
  log with the same `cycleId` for context.
- **Integration tests** (`test/integration/sync-engine.test.js`) run two
  real `sync/sync-engine.js` instances — independent tmp `userData`
  dirs, independent supabase-js sessions, same underlying account — as
  "two machines" against local Supabase, using the engine's real default
  push/pull implementations (not fakes): offline edits made
  independently on both converge to identical state after syncing; a
  purge tombstone made on one propagates to the other as a tombstone,
  never a hard delete; log entries added concurrently on both machines
  (each racing ahead of the other pulling) both survive on both sides
  once fully synced; and first sync from two machines with overlapping
  data (including a shared id where one side's edit is genuinely newer)
  converges without either side's push replacing the other's newer data.
  `test/sync-engine.test.js` covers the engine's own logic (push/pull
  ordering, the save race, cursor-after-merge persistence, first-sync
  bootstrap, status/backoff transitions) with fakes, including a class
  of test-hygiene bug found while writing it: any test leaving a
  `recordLocalSave`-scheduled debounce timer or a failed cycle's retry
  timer running past the end of the test hangs the whole file (the
  timer eventually fires against a now-torn-down fixture, sometimes
  cascading into an unbounded offline-retry loop) — every test that
  creates an engine now stops it in a `finally` block.

## Open items

- Work data (people and projects at Octopus) would live in a personal Supabase
  account. Check with security/IT before real data is uploaded — they may
  prefer a company-owned Supabase org. Phases 1–4 can be built against local
  Supabase with fake data in the meantime.
- Free projects pause after about a week of inactivity. With local-first this
  only delays sync until the project is resumed.
