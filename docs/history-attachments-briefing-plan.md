# First-launch welcome, project history, attachments, and morning briefing

Draft implementation plan — 27 September 2026. Target: Supabase Free.

This document proposes the implementation; it does not enable services, send
email, apply migrations, or change application behavior.

## Product scope and defaults

| Feature              | First release                                                                                 | Proposed default                                                              |
| -------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| First-launch welcome | Explain Work Radar, sign in with an existing account or stay local, and start a first project | Shown once per local installation/profile; local-only option always available |
| Project history      | Browse saved versions, compare fields, restore a version                                      | Automatic recording; retain the newest 100 versions per project               |
| Attachments          | Add, open, download, remove, and sync project files                                           | Private files; 10 MB per file; download on demand                             |
| Morning briefing     | One email listing projects needing attention                                                  | Opt-in; weekdays at 08:00 in a user-confirmed timezone; skip empty briefings  |

Keep the existing Today/All interface, individual ownership, offline operation,
activity logs, and daily local backups. Add History and Attachments sections in
the project inspector, a first-launch welcome screen, and a small briefing settings panel. Shared projects,
AI summaries, mobile clients, and calendar integrations are outside this work.

Email is the proposed briefing channel based on the preceding discussion.
The email provider and sender domain are deployment choices, not requirements
for drafting or building the local parts. Resend is a candidate because Supabase
documents an integration; do not assume its delivery allowance is included in
Supabase or that a sender domain is already configured.

## Existing implementation and constraints

- `renderer/domain.js` owns project fields, date calculations, Today selection,
  and merge behavior. Dates currently follow the device's local calendar.
- `main.js` owns disk access. `preload.js` exposes a narrow IPC interface.
- `sync/sync-engine.js` persists and merges the main JSON file. Its outbox tracks
  changed item IDs; several saves can become a single uploaded item state.
- `items` holds current project state; `log_entries` holds append-only notes.
  Neither is a complete history of saved project versions.
- `push_items` accepts a project update only when its client timestamp is newer.
  Realtime, periodic polling, and window focus trigger pulls.
- Current database policies restrict rows to their owner. Attachment and history
  access must enforce the same parent-project ownership.
- The existing sync plan identifies account switching with a shared local file
  as an open issue. New queues and caches must not carry one account's data into
  another account.
- Another agent is changing packaging, including `main.js` and `README.md`.
  Implement feature modules separately, then integrate against that agent's
  completed changes. Do not overwrite its working tree edits.

## Phase 0 — persistence and compatibility foundation

1. Introduce one serialized commit path for local edits, restores, imports, and
   incoming sync merges. Extend the existing data-file queue so a local project
   change and its history record are committed atomically in the same versioned
   JSON envelope. Derive pending history uploads from durable records after a
   crash; do not rely on an in-memory event callback.
2. Upgrade serialization, migration, merge, export/import, and sync write paths
   to preserve new metadata. Today, rebuilding an envelope from only `items`,
   `arch`, and `lastExport` could discard newly added top-level fields.
3. Bind cloud queues and cached files to a user ID. A different account must use
   a separate local profile; unsynced local-only data needs an explicit initial
   association. Sign-out stops transfers and invalidates in-flight results.
4. Apply additive database migrations before enabling each feature in clients.
   Detect missing server capabilities and show that the feature is unavailable
   while retaining pending local work. Preserve existing project sync.
5. Continue supporting old backup imports. New clients preserve old clients'
   omitted fields. Reject opening a newer local data schema in an older binary
   rather than silently rewriting it without history or attachment metadata.

Acceptance: interrupted writes and concurrent pulls cannot lose a saved edit or
its history; switching users cannot upload or display another profile's data.

## Phase 0a — first-launch welcome and sign-in

### Welcome flow

On the first launch of a fresh installation/profile, show a focused welcome
screen before the empty Today view. Use the existing visual style, keyboard
navigation, labeled fields, and accessible focus handling.

Suggested opening copy: **Welcome to Work Radar. Keep your projects in view,
remember what you're waiting on, and know what needs your attention today.**

1. Offer **Sign in** and **Continue without an account**. Explain that sign-in
   is for invited users with an existing account. Signing in enables syncing projects, history, and
   attachments between devices and optional morning emails. Users do not need
   to create a Supabase account or find an API key.
2. For sign-in, ask only for an email address and use the
   existing passwordless magic-link flow. Show sending, check-your-inbox, and
   verified states. Explain that the link must be opened on this computer while
   Work Radar is running. Support changing the email, retrying, resending after
   the permitted cooldown, and returning to local-only use.
3. After authentication, pull existing cloud projects before suggesting a first
   project. If local data already exists, explicitly offer to associate and sync
   it with this account, or use a separate profile. Do not silently upload or
   merge an existing local dataset just because authentication succeeded.
4. Offer an optional **Morning briefing** step once that feature is available:
   explain the email, confirm timezone/time/weekdays, and leave delivery off
   unless the user enables it. Local-only users can enable it after signing in.
5. Finish with **Create your first project**, **Import a backup**, or **Start
   using Work Radar**. Existing users with synced projects go straight to Today.
   Explain that projects appear in Today when a review or checkpoint is due;
   avoid making an empty Today screen look like a failed import or sync.

An account is not required to use local projects, history, or
attachments. Persist the local-only choice so the welcome or key prompt does
not reappear on every launch. Sign-in and briefing setup remain available later
through settings; provide a Help/menu action to reopen the introduction.

### Visible account identity in the interface

Keep the signed-in email visible in the main header alongside the sync status,
for example **you@example.com · Synced**. Account identity answers which account
is connected; Synced/Pending/Offline/Sync error describes its transfer state.
Changing the transfer state must not hide or replace the account identity.

The current `Auth.render()` in `renderer/app.js` writes “Cloud connected” into
`auth-email-label` and puts the email only in a tooltip. `Sync.render()` adds
`sync-has-status`, and `renderer/app.css` hides the account element when that
class is present. Replace this behavior with visible email text sourced from the
current authenticated session; remove the rule that suppresses it during sync.
Use text content rather than HTML when displaying the email.

Make the account indicator a keyboard-accessible control opening a small account
panel with **Signed in as**, the full email address, **Sign out**, and access to
briefing settings when available. At narrow widths, truncate the visible email
if necessary but keep the full address accessible through that panel and an
accessible label. A hover tooltip alone is insufficient.

While the session remains signed in, keep its email visible during pending
uploads, offline operation, and sync errors. On session expiry, show **Sign in
again** rather than claiming the user is still authenticated. Clear the previous
account identity on sign-out or profile change. For local-only use, show **Local
only** with a Sign in action when cloud access is configured. During initial
session loading, show a neutral loading state without briefly displaying a stale
account. Do not use the last typed sign-in email as authenticated identity.

Acceptance: after sign-in and after restart, the correct email is visible beside
every applicable sync state; sign-out and profile changes clear it immediately;
long emails remain readable through keyboard and pointer interaction; local-only
and expired-session states are accurate. Cover the header layout at supported
window sizes as well as auth/sync state transitions.

### First-run detection and recovery

Persist a versioned onboarding record in the main-process settings store with
the current step and completion/skip state. Scope it to the local installation
or profile, not cloud project data or exported backups. Do not infer first launch
from an empty project list or a signed-out session.

Resume unfinished setup after restart, checking the real auth session before
showing a success state. If the callback listener/verifier is no longer valid,
offer a new sign-in attempt. A sent email alone does not complete sign-in.
Signing out, deleting the last project, and upgrading the app must not restart
the welcome flow. Existing installations with data or a saved session should
bypass mandatory onboarding; a fresh installation of an existing user's account
still offers Sign in. Lost connectivity, expired links, unavailable secure
session storage, or failed initial sync must leave a usable local path.

### Existing-account access and release configuration

Account creation and self-service registration are deferred. Keep the current
`sync/auth-service.js` setting `shouldCreateUser: false` and keep public sign-ups
disabled in Supabase. Existing accounts continue to be provisioned by the
operator outside the app. Do not add a Create account button, registration form,
or account-creation endpoint in this implementation.

Explain that cloud access is currently invite-only. For sign-in failures, provide
retry and local-only options with neutral wording that does not expose whether
an email belongs to an account. Confirm successful sign-in only after link
verification and a valid session. Keep deployment documentation aligned with
this existing-account-only policy.
[Supabase passwordless authentication](https://supabase.com/docs/guides/auth/auth-email-passwordless).

Coordinate with the packaging work to bundle the public project URL/key in
normal releases. Hide technical configuration behind advanced setup. A build
with no backend configuration should explain that cloud accounts are unavailable
in that build and offer local use, rather than presenting a broken sign-in form.

Configure custom SMTP for verification/sign-in email to recipients outside the
Supabase organization team. This is separate configuration from the morning
briefing's provider adapter, even if both use one provider. Validate callback
redirects and email templates in a packaged build, and handle Auth/provider rate
limits with clear retry states. [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp).

Acceptance: a fresh install shows the welcome once; existing-account sign-in
works through verification; an unknown email never creates an account; no sign-up
action is shown; local-only choice survives restart; existing
users and upgrades bypass mandatory setup; interrupted/failed authentication can
recover; initial sync never silently associates another profile's data; briefing
email stays disabled unless selected; missing backend configuration and
invite-only deployments show accurate choices.

## Phase 1 — project history

### User behavior

- Show newest-first saved versions with date, action, and changed-field summary.
- Capture create, explicit edit/save, review, snooze, checkpoint completion,
  archive/unarchive, purge, import changes, and restore. Do not capture every
  keystroke or duplicate records on a routine pull.
- Snapshot project fields, including scheduling and archive/deletion state.
  Keep activity-log entries and attachment records separate; restoring a project
  version must not delete later activity or remove files.
- Compare a selected version with the current project before restoring it.
  Restore makes a new edit with a fresh timestamp and revision ID, preserving
  project identity and recording the restored-from revision.
- Preserve existing newest-edit-wins conflict behavior. A restore is queued like
  any edit, and the UI must report when it loses to a newer remote change.
- Existing projects receive a baseline on upgrade. Explain that earlier versions
  cannot be reconstructed. Provide recovery access to tombstoned projects while
  their retained history exists.

### Storage and synchronization

Add `item_revisions`: revision ID, item ID, owner ID, snapshot schema version,
snapshot JSON, action, source device, client time, server receipt time,
restored-from revision ID, and origin/status metadata as needed.

Record each local mutation with a stable UUID and retain it through retries.
Upload all pending revisions independently of the coalesced current-item outbox;
an offline sequence of five saves must remain five recoverable versions even if
only the final item state is accepted by the server. A superseded local version
is labeled accordingly rather than presented as an accepted cloud state.

Use a database trigger to capture accepted changes from older clients and other
authorized writers. Carry the revision ID with new-client item mutations so the
trigger and explicit revision upload converge on one record. Validate ownership,
immutable content, and duplicate-ID behavior server-side. Baseline existing rows
in the migration. Use server receipt ordering for pagination; client timestamps
describe edit time, not a guaranteed global sequence.

Clients may read and append their own revisions, but not rewrite history.
Retention is handled by a bounded server maintenance job and matching local
cleanup. Keep the newest 100 versions per project; never remove unacknowledged
local revisions. Cache recent history and fetch older retained pages on demand.
Document that this is bounded recovery history, not an unlimited audit archive.

Include retained history in JSON exports and daily backups. Deduplicate revision
IDs on import. Normal sync and import must preserve history already on disk.

Acceptance: five offline saves survive restart and sync; repeated uploads create
no duplicates; restoring a version is itself undoable; older-client edits are
captured; two users cannot read or append each other's revisions.

## Phase 2 — private attachments

### User behavior

- Add files through an OS file picker. Show name, size, and transfer state:
  pending, uploading, available, failed, or unavailable offline.
- Copy a selected file into app-managed storage immediately. Moving or deleting
  the original must not break the attachment or queued upload.
- Open downloaded files through the OS after an explicit user action. Use a
  restricted initial set: PDF, PNG/JPEG/WebP, plain text/Markdown, CSV, and common
  Office documents. Do not render executable or active HTML content in Electron.
- Permit local-only attachments without sign-in. Sync them after the user
  associates the local profile with their account.
- Cache files when uploaded or opened, with a proposed 250 MB evictable download
  cache. Never evict the only local copy of a pending upload or local-only file.

### Storage and transfers

Add `item_attachments`: ID, item ID, owner ID, display filename, object key,
content type, byte size, checksum, creation time, sync timestamp, and deletion
tombstone. Store bytes in a private `project-attachments` bucket using generated
keys such as `<user-id>/<item-id>/<attachment-id>`; filenames are metadata.

Enforce parent ownership on both metadata and Storage operations. A UUID path
alone is not authorization. Validate file size/type in the main process and at
the bucket/service boundary; use the proposed 10 MB limit on both sides.
Keep all filesystem and network operations behind validated main-process IPC.

Use a durable upload/download queue separate from item sync. Reserve metadata,
upload to an immutable key, then mark the attachment ready. Readers only see
ready, nondeleted files. Because database and object writes are not one
transaction, make every step retryable and reconcile abandoned reservations and
orphaned objects after a grace period. Verify checksums on downloads.

Removal creates a tombstone before asynchronous object deletion. An offline
device must not recreate a deleted attachment when it reconnects. Purging a
project schedules its attachments for deletion too. Retain deletion markers so
old clients can converge; explain that project-history restore does not restore
removed attachment bytes.

Download on demand using authenticated requests; avoid public URLs and permanent
signed links. Track bytes to provide a useful storage estimate and clear quota
errors. Check total project usage in the Supabase dashboard before rollout; the
Free allowance may already be shared with other data/users.

### Backup behavior

JSON exports and daily JSON backups include metadata, not file bytes, and must
say so. Add an explicit full-backup archive containing project data, retained
history, a manifest, and attachment bytes. Fetch uncached files when online;
list missing files when offline and never report an incomplete archive as a
complete backup. Validate paths and checksums when importing an archive.

Acceptance: queued files survive restart; retry after each transfer step produces
one attachment; owner checks cover direct Storage access; offline deletion does
not resurrect files; full-backup round trips restore the actual file contents.

## Phase 3 — morning email briefing

### Content and settings

- Send to the signed-in account's verified email address. Do not accept arbitrary
  recipient addresses from a client payload.
- Offer enable/disable, time, weekdays, an IANA timezone, preview, and test email.
  Suggest the device timezone at setup, but save it as an explicit account
  setting; travel must not silently move the scheduled send time.
- Include projects with a review or checkpoint due today or overdue, sorted by
  priority then name. Explain why each project appears and include waiting-on
  context. Exclude archived/deleted projects. Priority alone does not qualify.
- Omit full notes and attachment contents. No AI is needed. Build escaped HTML
  and plain-text versions from the same deterministic briefing model.
- Skip delivery when nothing is due. Show the preview even when it is empty.
- State that email reflects the latest cloud-synced data; unsynced offline edits
  cannot influence it. Include the snapshot generation time.

### Scheduling and delivery

Add `briefing_preferences` (owner, enabled, timezone, local time, weekdays) and
`briefing_deliveries` (owner, local date, state, attempt count, lease/retry time,
provider ID, and sanitized error). Enforce one scheduled delivery per owner/local
date with a unique constraint. Users can read their own delivery status; only
server code can claim jobs and update delivery results.

Extract a timezone-explicit attention calculation from `renderer/domain.js` and
use matching shared fixtures in the client and function runtime. Preserve current
Today semantics. When device and briefing timezones differ, label the preview's
timezone. Cover legacy schedules whose next-review date is derived from a
timestamp, explicit dates, manual reviews, snoozes, and DST transitions.

Use one Cron job every five minutes to invoke a protected Edge Function. Store
the scheduler credential securely server-side. The function claims eligible
deliveries atomically, reads only the selected owner's projects, and sends through
a configured email-provider adapter. No provider or privileged Supabase secrets
ship in Electron. User-triggered previews/test sends authenticate the current
user, derive the recipient server-side, and are rate limited separately.

Use the delivery ID as the provider idempotency key where supported. A database
claim alone cannot prevent duplicates when a provider accepts a send but the
response is lost. Select and verify the provider's idempotency/reconciliation
behavior before launch; do not blindly retry an ambiguous send beyond that
provider's deduplication window. Bound retry attempts and honor rate limits.

On recovery from downtime, allow one late delivery within two hours of the
scheduled time; skip older missed days rather than emailing a backlog. Recheck
the enabled setting before sending. Treat successful delivery as provider
acceptance, not proof that the user received or read the message.

Keep delivery metadata for 30 days and avoid storing rendered email bodies.
The app displays last attempted/sent/failed status and a disable control. Email
includes clear instructions for disabling briefings in settings.

Acceptance: app-closed delivery works; repeated scheduler invocations and two
workers do not double-send; DST and timezone fixtures match the preview;
empty/disabled briefings send nothing; downtime recovery respects the late-send
window; secrets and other users' content never appear in responses or logs.

## Free-plan budget and limitations

As checked on 27 September 2026, Supabase Free includes a 500 MB database,
1 GB file storage, 5 GB uncached egress, 5 GB cached egress, and 500,000 Edge
Function invocations per month. The platform's maximum file size is 50 MB;
this plan deliberately proposes a smaller app limit. Free projects can pause
after a week of inactivity and do not include automatic database backups.
[Supabase pricing](https://supabase.com/pricing).

One five-minute scheduler is 8,640 invocations in a 30-day month, before retries
and tests. History retention and file downloads are more likely to matter for
capacity than a personal daily email. Treat provider email charges separately;
no paid service or Supabase upgrade is assumed.

Cloud briefings are best-effort on Free. Do not promise that scheduled jobs
prevent project pausing, or add artificial keep-alive traffic. A paused project
cannot send its own failure alert. Surface missed/failed delivery when the app
next connects; always retain the local Today view as the usable fallback.

## Delivery sequence and verification

| Milestone | Deliverable                                                                            | Gate                                                     |
| --------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 0         | Persistence/profile foundation and additive schema strategy                            | Crash, migration, account-switch tests                   |
| 0a        | First-launch welcome, existing-account sign-in, visible account email, local-only path | Fresh install, upgrade, auth recovery, and consent tests |
| 1         | Local history, cloud revisions, compare/restore UI                                     | Offline, conflict, deduplication, RLS tests              |
| 2         | Attachment UI, durable transfers, full-backup archive                                  | Transfer interruption, quota, ownership, recovery tests  |
| 3         | Briefing preview/settings, scheduler, email adapter                                    | Calendar parity, auth, retry, duplicate-send tests       |
| 4         | Integrated release candidate                                                           | Two-device and packaged-app smoke tests                  |

Use existing `node:test` conventions for pure logic and injected IO. Extend the
local Supabase integration suite for migrations, RPCs, triggers, Storage policies,
and worker claims. Run `npm run check` and relevant integration tests for each
implementation milestone; use fake data and a stub email provider during normal
development. No new tests are needed for this planning document alone.

Before release, verify first-launch setup, visible account email across sync
states and restarts, invited-user sign-in, unknown-email
handling without account creation, persistent local-only choice, fresh install
and upgrade, old backup import, a two-device
offline conflict, restore and resync, failed attachment upload, and a briefing
with the desktop app closed. Confirm that the packaging file allowlist includes
any new main-process modules. Keep feature enablement independent so an email
provider problem does not block history or attachments.

Apply hosted migrations and Storage configuration first, validate with test
accounts, verify public sign-ups remain disabled and configure Auth SMTP, then release
the client. Configure briefing sender/domain credentials and enable
Cron after test delivery is verified. Existing repository guidance requires
company security/IT sign-off before uploading real work data; development can
continue locally with synthetic data. This is not a blocker for drafting or
implementing the features.

For rollback, disable the affected feature or scheduler and retain its tables,
local records, and queued files. Avoid destructive down-migrations or downgrading
to a client that cannot preserve the new local schema.

## Supporting documentation

- [Supabase Cron](https://supabase.com/docs/guides/cron): scheduled SQL and HTTP jobs.
- [Storage access control](https://supabase.com/docs/guides/storage/security/access-control): private object policies.
- [Sending email from Edge Functions](https://supabase.com/docs/guides/functions/examples/send-emails): provider integration example.
- Repository references: `docs/supabase-sync-plan.md`, `renderer/domain.js`,
  `sync/sync-engine.js`, `sync/outbox.js`, `sync/mapping.js`, and existing migrations.
