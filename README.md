# Work Radar (Electron)

A situational-awareness radar for the projects orbiting you — the things you must keep in mind, not a to-do list. Data lives in a real JSON file on disk, written atomically, with automatic daily backups.

## Run it

Development/builds use [Node.js](https://nodejs.org) 24 (`nvm use`). Packaged apps include their runtime; recipients do not need Node or npm.

```bash
cd work-radar
npm install      # downloads Electron (~150 MB, one time)
npm start
```

## Build a desktop app

```bash
npm ci
npm run build:mac -- --arm64 --publish never  # Apple Silicon DMG + ZIP
npm run build:mac -- --x64 --publish never    # Intel DMG + ZIP
npm run build:win -- --x64 --publish never    # installer + portable EXE
npm run build:linux -- --x64 --publish never  # AppImage
```

Build on the corresponding OS. Downloads appear in `dist/` with version,
platform, and architecture in their filenames. Every build command regenerates
the icon and release configuration through the same Electron Builder hook.

To make a build that is ready for invited users to sign in, supply
`WORK_RADAR_RELEASE_SUPABASE_URL` and `WORK_RADAR_RELEASE_SUPABASE_KEY` at
build time. Only a publishable/anon key is accepted. Both variables must be set
together; neither set produces a local-only build with the existing setup prompt.
`WORK_RADAR_REQUIRE_SYNC=1` makes missing configuration a build error.
Runtime `WORK_RADAR_SUPABASE_*` variables are not automatically embedded.

See [Distribution and release setup](docs/distribution.md) for GitHub Actions,
signing credentials, hosted Supabase checks, and fresh-install testing.
App builds run only on pushed `v*` tags or published GitHub releases (including
prereleases). Tag builds create a **draft** release; release-publication builds
upload workflow artifacts and leave the published release unchanged.
Ordinary branch pushes and manual workflow dispatch do not trigger app builds.
Automatic updates are deferred until the first release is validated.

### Launch on login

- **macOS:** System Settings → General → Login Items → add Work Radar.
- **Windows:** the NSIS installer offers a Start-menu/desktop shortcut; drop it in `shell:startup` to auto-launch.

## Where your data lives

A single JSON file in the OS app-data directory:

- **macOS:** `~/Library/Application Support/work-radar/work-radar-data.json`
- **Windows:** `%APPDATA%\work-radar\work-radar-data.json`
- **Linux:** `~/.config/work-radar/work-radar-data.json`

Writes are atomic (temp file + rename), so a crash mid-save can't corrupt it. A dated snapshot is copied to `backups/` once per day on launch (last 30 kept). **Radar → Reveal Auto-Backups** opens that folder. **Radar → Export PDF — Full details…** exports the full report; **Export PDF — Titles only…** exports project titles grouped by priority. PDF is the only export format.

Unlike the old single-file HTML version, this does **not** depend on browser storage or the file's path. Move the app, rename it, doesn't matter — the data directory is stable.

## Optional sync (Supabase)

Work Radar is **local-first**: the JSON file described above is always the
source of truth, and the app works fully offline with zero setup. Sync is an
entirely optional layer on top. A fresh installation opens a welcome flow where you can sign in with an existing invited account or continue without an account; the local-only choice is saved on this device.

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
needs four things set up before sign-in or sync will work at all (see
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

4. **Configure custom SMTP** for magic-link delivery to recipients outside
   your Supabase organization team. Creating an app user does not make them a
   Supabase team member. The default mail service is restricted to team addresses;
   see [Supabase SMTP documentation](https://supabase.com/docs/guides/auth/auth-smtp).

### Configuring it

The app ships with a **built-in default Supabase project URL** (a public
identifier, not a secret — see the secrets rule), so a development or unconfigured build only needs a
**publishable key** to turn on. Shared release builds can include both values
and go straight to sign-in, without a key prompt. The URL and key are each resolved
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
   with just a `publishableKey` uses the bundled release URL when available,
   otherwise the built-in default URL.

3. **Bundled release configuration** — `release-sync-config.json` in the
   packaged app's resources. Generated at build time and ignored by Git, this
   contains only the release project's URL and public key. It is ignored during
   `npm start`. Environment variables and the userData file take priority.
   A URL-only override to a different backend does not inherit the bundled key;
   supply that backend's own key. A trailing slash on the same URL is accepted.

4. **The startup "add your key" prompt** — if no key is found from the
   sources above, a small overlay asks for one instead of silently staying
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

## First launch, profiles, and recovery features

The first launch welcome explains the local-only path and the invited-user magic-link path. Work Radar never creates accounts or accepts a recipient email for briefings. A local-only choice remains available later through the account panel, and **Radar → Open Introduction** reopens the welcome text.

The signed-in email stays visible beside Synced, Pending, Offline, and Sync error. Each account uses an isolated local profile under the app data directory. If a device already has local projects, Work Radar asks before associating them with an account; it does not silently upload or merge them into another account.

Every project edit is retained as bounded recovery history (newest 100 versions per project). Open a project to compare a saved version with the current fields or restore it as a new edit. Activity notes and attachments remain separate from project snapshots. Attachments are copied into app-managed private storage when added, checked against the 10 MB type/size policy, and expose pending, uploading, available, failed, and offline states in the inspector. The desktop app opens files through the operating system after an explicit action.

Morning briefings are opt-in. Signed-in users can open the account panel to choose an IANA timezone, local time, weekdays, preview the deterministic due-project list, and send a test email. Delivery requires the protected Supabase Edge Function and a configured provider; applying the local migration alone does not enable sending. The function derives the recipient from the verified account email and skips empty briefings. See [the implementation plan](docs/history-attachments-briefing-plan.md), [briefing operations](docs/morning-briefing-operations.md), and [distribution setup](docs/distribution.md) for deployment configuration and rollback guidance.

Automatic JSON backups preserve history and attachment metadata. The desktop menu can still import existing JSON backups and full Work Radar archives with project data, history, attachment metadata, and checksum-verified attachment bytes.

## Migrating from the browser version

The old `work-radar.html` stored data in browser `localStorage`, which the Electron app can't read. To bring it over: open the old file, hit **EXPORT** to get a JSON backup, then in the Electron app choose **Radar → Import Backup…** and select it. Merge is non-destructive: for a matching ID, whichever side was edited more recently wins; everything else is added.

## Daily use

The app opens in **Today**, a quiet briefing of projects whose review or checkpoint is due
on or before today. Each row explains why it appears. Priority alone does not put a project
in Today, and an empty briefing means nothing is scheduled for attention.

**All** contains every live project, with search, status filters, sorting, and access to
the archive. Select a project to see its notes, activity history, and review controls.
In All, each row also has an **Edit** button that opens the full project editor directly.
The editor uses two columns on larger windows and one on smaller windows, with Save and Cancel
always visible. Saving or cancelling returns to the same filtered list and scroll position.
`Ctrl/Cmd+Enter` saves while editing; `Esc` cancels. Project editing is available only in All.

**Radar** plots every live project spatially. Higher-priority projects with nearer review dates
sit closer to the center; lower-priority projects and later or manually scheduled reviews sit
farther out. Dot colour represents category, with a legend beside the radar. Select a dot to
open the same project details and review controls available from the list views.

Projects can have a review rhythm (a number of days, or manual review), a specific next
review date, a **Waiting on** person/team/event, and a **Next checkpoint** with an optional
date. Existing projects retain their 14-day review rhythm. Dates use the local calendar,
so a checkpoint due today appears throughout today, independent of its creation time.

**Complete review** saves the optional status update and records the review together,
scheduling the next one using the project's rhythm or the selected next date. **Save update
only** records the note without changing the review date. **Snooze review…** has its own date
choice and postpones the review without marking it reviewed. Neither action clears a
checkpoint: complete or edit it separately when the expected event happens.

After a successful review, Today returns to the list when nothing else is due for that
project; otherwise it explains what still needs attention. Unsent update drafts and date
choices survive closing and reopening project details during the current app session.
Archive offers Undo, which restores the project without changing its review date.

Waiting-on text without a date does not itself add a project to Today. Blank next-review dates use the rhythm; manual rhythm without a
specific next date disables scheduled reviews.

PDF exports (full details or titles only), backup imports, and automatic backup access live in the **Radar**
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

`Cmd/Ctrl+N` new · `Cmd/Ctrl+F` search All · `Cmd/Ctrl+E` titles-only PDF · `Cmd/Ctrl+Shift+E` full PDF · `Cmd/Ctrl+I` import
In-window: `N` new · `/` search All · `E` edit · `R` (or `P`) complete review · `A` archive · `Esc` close

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

All build commands run the icon generator and regenerate public release configuration via `scripts/prepare-build.js`.

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
