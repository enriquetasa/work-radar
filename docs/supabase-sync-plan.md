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

## Open items

- Work data (people and projects at Octopus) would live in a personal Supabase
  account. Check with security/IT before real data is uploaded — they may
  prefer a company-owned Supabase org. Phases 1–4 can be built against local
  Supabase with fake data in the meantime.
- Free projects pause after about a week of inactivity. With local-first this
  only delays sync until the project is resumed.
