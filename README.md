# Work Radar (Electron)

A situational-awareness radar for the projects orbiting you — the things you must keep in mind, not a to-do list. Data lives in a real JSON file on disk, written atomically, with automatic daily backups.

## Run it

Requires [Node.js](https://nodejs.org) (18+).

```bash
cd work-radar
npm install      # downloads Electron (~150 MB, one time)
npm start
```

## Build a desktop app

```bash
npm run build:mac     # → dist/Work Radar-2.0.0.dmg
npm run build:win     # → dist/Work Radar Setup 2.0.0.exe
npm run build:linux   # → dist/Work Radar-2.0.0.AppImage
```

Install the artifact from `dist/` like any other app. On macOS the build is unsigned, so the first launch needs right-click → Open (or `System Settings → Privacy & Security → Open Anyway`). Signing requires an Apple Developer ID — add it to the `build.mac` block in `package.json` if you want notarization.

### Launch on login

- **macOS:** System Settings → General → Login Items → add Work Radar.
- **Windows:** the NSIS installer offers a Start-menu/desktop shortcut; drop it in `shell:startup` to auto-launch.

## Where your data lives

A single JSON file in the OS app-data directory:

- **macOS:** `~/Library/Application Support/work-radar/work-radar-data.json`
- **Windows:** `%APPDATA%\work-radar\work-radar-data.json`
- **Linux:** `~/.config/work-radar/work-radar-data.json`

Writes are atomic (temp file + rename), so a crash mid-save can't corrupt it. A dated snapshot is copied to `backups/` once per day on launch (last 30 kept). **Radar → Reveal Auto-Backups** opens that folder. **Radar → Export JSON Backup…** still writes a portable copy anywhere you choose — good for dropping into a synced folder.

Unlike the old single-file HTML version, this does **not** depend on browser storage or the file's path. Move the app, rename it, doesn't matter — the data directory is stable.

## Optional sync (Supabase)

Work Radar is **local-first**: the JSON file described above is always the
source of truth, and the app works fully offline with zero setup. Sync is an
entirely optional layer on top — if it isn't configured, no sign-in UI is
shown at all and nothing changes about how the app behaves.

When configured, sync lets the same data follow you between machines:

- Every local change is pushed to a Supabase project; changes made elsewhere
  are pulled and merged in (newest edit wins per item, log entries are
  additive and never lost).
- A Realtime subscription nudges the app to pull promptly when something
  changes elsewhere, backed by a 60-second poll and a check on window focus
  so it stays eventually consistent either way.
- The secret Supabase key never ships in the app — only the **publishable**
  key does, which is a public identifier, not a secret. Row Level Security
  on the server is what actually protects your data: each user can only
  ever read or write their own rows.

### Setting up a Supabase project

The app never creates the server side of sync for you — a hosted project
needs three things set up before sign-in or sync will work at all (see
[Phase 0 of the sync plan](docs/supabase-sync-plan.md#phases) and the
[Sign-in flow](docs/supabase-sync-plan.md#sign-in-flow) for the full
detail):

1. **Apply the migrations** in `supabase/migrations` — the tables, RLS
   policies and `push_*` RPCs sync depends on don't exist otherwise, and
   every push/pull will fail with `SYNC ERROR`:

   ```bash
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```

2. **Set the auth redirect** — in the hosted project's Auth settings, set
   both **Site URL** and **Redirect URLs** to
   `http://127.0.0.1:54390/auth/callback` (the app's loopback callback
   address), and set the magic-link expiry to 10 minutes. If these don't
   match exactly, Supabase sends the browser somewhere else and the sign-in
   code exchange never happens.
3. **Turn off sign-ups and create your user by hand** — the app signs in
   with `shouldCreateUser: false`, so it never creates accounts itself. In
   the dashboard, disable public sign-ups and create the user(s) who should
   be able to sign in; anyone else gets a sign-in error instead of "CHECK
   YOUR INBOX".

### Configuring it

The app ships with a **built-in default Supabase project URL** (a public
identifier, not a secret — see the secrets rule), so sync only needs a
**publishable key** to turn on. The URL and key are each resolved
independently, checked in this order:

1. **Environment variables** — `WORK_RADAR_SUPABASE_URL` and
   `WORK_RADAR_SUPABASE_KEY`:

   ```bash
   WORK_RADAR_SUPABASE_URL="https://your-project.supabase.co" \
   WORK_RADAR_SUPABASE_KEY="your-publishable-key" \
   npm start
   ```

2. **A `sync-config.json` file** dropped into the app's `userData` directory
   (the same folder the data file lives in — see "Where your data lives"
   above), for a packaged build where setting env vars isn't convenient:

   ```json
   {
     "url": "https://your-project.supabase.co",
     "publishableKey": "your-publishable-key"
   }
   ```

   Either field can be present on its own — a file with just a `url`
   points sync at a different project without supplying a key yet; a file
   with just a `publishableKey` uses the built-in default URL.

3. **The startup "add your key" prompt** — if no key is found from either
   source above, a small overlay asks for one instead of silently staying
   local forever. Paste a publishable key (`sb_publishable_…`) or a legacy
   anon JWT and hit **SAVE** to write it into `sync-config.json` and bring
   sync up immediately, no restart needed; **NOT NOW** keeps the app fully
   local for this run only — nothing is remembered, so it asks again next
   launch.

**Every key, from every source above, is validated the same way** —
whether it's typed into the prompt, dropped in via `sync-config.json`, or
set as `WORK_RADAR_SUPABASE_KEY` — before it's ever used. Anything that
looks like a secret or service key (`sb_secret_…` anywhere in the value, or
a JWT whose role is `service_role`) is rejected and never written to disk
or used to configure sync, since only the publishable key is meant to
leave RLS as the sole thing protecting your data (see the sign-in flow doc
for why).

How you find out differs by source. Typing a bad key into the startup
prompt shows a clear on-screen error right there, and nothing is saved. A
bad key from an env var or `sync-config.json` gets no on-screen message —
only a warning in the logs — and is simply treated exactly like no key at
all from that source: if a valid key is found elsewhere (e.g. one already
saved via the prompt on an earlier run), that one is used instead and sync
comes up normally; if not, sync stays unconfigured and the startup prompt
appears asking for a key, the same as if none had ever been set. This
applies equally to `WORK_RADAR_SUPABASE_KEY` and a hand-edited
`sync-config.json` — a typo'd or accidentally-secret key from either one
never silently wins over a good key available from another source.

Never commit real values for either the URL override or the key — keep them
out of version control, per the secrets rule (env vars locally, or the
`userData` file on a real machine). Setting both env vars skips the startup
prompt entirely. If no key is ever supplied, the app just keeps prompting
(and staying local) on every launch, exactly as it did before sync existed.

### Signing in

Sign-in uses a passwordless magic-link email (no passwords stored anywhere):

1. Enter your email in the auth panel and submit. The panel switches to
   "CHECK YOUR INBOX".
2. Click the link in the email **on the same machine** you signed in from —
   the flow uses PKCE, and only that machine holds the matching verifier.
   Keep Work Radar open and click the link within 10 minutes, the loopback
   listener's timeout. If you instead see a "port 54390 in use" error
   before any email is sent, close whatever else is using that port and
   try again — the app never falls back to a different port.
3. The link opens a local page confirming you can close the tab and return
   to Work Radar; the app exchanges the code for a session in the
   background and the panel updates to show you're signed in.
4. **Radar → Sign Out** ends the session.

The signed-in session is stored encrypted on disk (via Electron's
`safeStorage`), so you stay signed in across restarts.

Signing in also requires an OS-level secret store — Keychain on macOS, DPAPI
on Windows, or a libsecret/kwallet-backed Secret Service on Linux. Without
one, `safeStorage` has nothing to use, auth stays disabled (no sign-in UI
appears) and an error is logged, even with a valid sync config. On Linux
without a keyring/D-Bus secret service, `safeStorage` may still report
itself available via its `basic_text` backend — in that case the session is
only obfuscated on disk, not meaningfully encrypted.

### Sync status indicator

Once signed in, a status indicator appears in the header:

| Indicator      | Meaning                                                            |
| -------------- | ------------------------------------------------------------------ |
| `◈ SYNCED`     | Everything local has been pushed; nothing pending.                 |
| `◈ PENDING`    | A local change is queued to push (or just about to be).            |
| `◈ OFFLINE`    | The last sync attempt couldn't reach Supabase; will retry.         |
| `◈ SYNC ERROR` | The last sync attempt failed for a reason other than connectivity. |

The indicator is hidden entirely when sync isn't configured, or while
signed out.

### Developing against sync

Sync-related unit tests (`sync/`, `renderer/*-view.js`) run as part of
`npm test`/`npm run check` using fakes — no network or database needed.

Exercising the real thing needs a local Supabase stack:

```bash
npx supabase start     # first time: downloads and starts the local stack
npx supabase status    # prints the local URL, keys and Mailpit's UI address
npm run test:integration
```

`test/integration/*.test.js` creates throwaway users against the local
stack, drives real sign-in/push/pull/Realtime flows, and cleans up after
itself. It never touches a hosted Supabase project. See
`docs/supabase-sync-plan.md` for the full design and per-phase notes.

### Open item: work data needs a security/IT sign-off

Work Radar's data (people and projects at Octopus) is company data. Before
pointing sync at real data, check with security/IT — they may prefer a
company-owned Supabase organization over a personal one. Until that
sign-off happens, develop and test against the local Supabase stack with
fake data only.

## Migrating from the browser version

The old `work-radar.html` stored data in browser `localStorage`, which the Electron app can't read. To bring it over: open the old file, hit **EXPORT** to get a JSON backup, then in the Electron app choose **Radar → Import Backup…** and select it. Merge is non-destructive: for a matching ID, whichever side was edited more recently wins; everything else is added.

## Daily use

The app opens in **Today**, a quiet briefing of projects whose review or checkpoint is due
on or before today. Each row explains why it appears. Priority alone does not put a project
in Today, and an empty briefing means nothing is scheduled for attention.

**All** contains every live project, with search, status filters, sorting, and access to
the archive. Select a project to see its notes, activity history, and review controls.
The dark radar aesthetic remains, with a compact header and no spatial radar graphic.

Projects can have a review rhythm (a number of days, or manual review), a specific next
review date, a **Waiting on** person/team/event, and a **Next checkpoint** with an optional
date. Existing projects retain their 14-day review rhythm. Dates use the local calendar,
so a checkpoint due today appears throughout today, independent of its creation time.

**Reviewed** records a review and schedules the next one using that project's rhythm.
A custom next date overrides that occurrence. Snoozing changes the review date without
marking the project reviewed. Neither action clears a checkpoint: complete or edit it
separately when the expected event happens. Waiting-on text without a date does not itself
add a project to Today. Blank next-review dates use the rhythm; manual rhythm without a
specific next date disables scheduled reviews.

JSON export, import, PDF reporting, and automatic backup access live in the **Radar**
application menu. Daily local backups continue automatically alongside optional cloud sync.

### Sync upgrade

Apply the new scheduling migration in `supabase/migrations` to your Supabase project before
using these fields across machines (`npx supabase db push` for your linked project).
It adds review rhythm/date, waiting-on, and checkpoint fields and updates `push_items`.
The migration is additive; older clients' omitted scheduling fields are preserved by the
server when updating a project. Until the migration is applied, sync reports an error and keeps
pending changes on the device rather than sending them to a server that cannot store the new fields.
Upgrade your other clients to edit the new fields.

## Keyboard

`Cmd/Ctrl+N` new · `Cmd/Ctrl+F` search All · `Cmd/Ctrl+E` export · `Cmd/Ctrl+I` import
In-window: `N` new · `/` search All · `E` edit · `R` (or `P`) reviewed · `A` archive · `Esc` close

## Development

```bash
npm test           # unit tests (node:test) for the pure domain logic
npm run lint       # eslint
npm run format     # prettier --write   (format:check to verify only)
npm run check      # lint + format:check + test — the pre-merge gate
npm run icon       # regenerate build/icon.* from scripts/make-icon.js
npm run test:integration   # sync tests against a local Supabase stack — see
                            # "Developing against sync" above
```

`npm run build` runs the icon generator first (`prebuild`).

## Architecture

```
main.js          Main process — owns ALL disk IO, window, menu, daily backups.
logger.js        Structured JSON logger for the main process (one line per event).
preload.js       contextBridge: exposes a tiny window.radarAPI (load/save/export/import).
renderer/        UI. No Node access; talks to disk only through radarAPI over IPC.
  index.html     Markup + strict CSP (script-src 'self').
  app.css        Styles.
  domain.js      Pure, DOM-free logic (migrate, staleness, filter/sort, merge).
                 Loaded as a browser global AND require()-able under node:test.
  app.js         State store, render, actions. Falls back to localStorage if run
                 outside Electron, so the same code works in a plain browser too.
  sync-view.js,
  auth-view.js   Pure view-state helpers for the sync/auth UI (see below).
sync/            Optional sync/auth (main-process only). See "Optional sync
                 (Supabase)" above and docs/supabase-sync-plan.md.
supabase/        Local Supabase project config + SQL migrations for sync.
scripts/
  make-icon.js   Renders the radar dock icon to build/icon.* (zero deps).
test/
  *.test.js            Unit tests (fakes only, no network).
  integration/*.test.js Tests against a real local Supabase stack.
```

Security defaults: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP locked to self. The renderer never sees Node or the filesystem directly.

The split between `domain.js` (pure) and `app.js` (DOM/IO) is what makes the
core logic unit-testable without spinning up Electron or a headless browser.
