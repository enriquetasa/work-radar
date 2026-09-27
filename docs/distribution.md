# Sharing Work Radar

The first release is for invited users: download, open, enter an email, then
open the magic link on the same computer. Each account has a separate radar.
Users can keep using the app offline without signing in. Collaborative radars
and automatic app updates are separate follow-up work.

## Build locally

Use Node 24 (`nvm use`) and `npm ci`. Build on each target OS. For a shared
build, set these environment variables in the build process:

| Variable                          | Purpose                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `WORK_RADAR_RELEASE_SUPABASE_URL` | Hosted project HTTPS origin                              |
| `WORK_RADAR_RELEASE_SUPABASE_KEY` | Publishable key or legacy anon key                       |
| `WORK_RADAR_REQUIRE_SYNC`         | Set to `1` to reject a build without cloud configuration |

Then run the relevant command from the README, adding `--publish never`.
Do not put actual values into tracked files. The build hook writes only the
public URL and key to the ignored `build/release-sync-config.json`, and
Electron Builder copies that file into the app's resources. It is readable by
recipients, as intended for Supabase publishable keys. Secret/service-role keys
are rejected. Runtime environment variables and userData are never copied.

With neither release variable set, a local-only build remains possible. Every
build replaces the generated configuration; an invalid configuration fails the
build and removes the stale generated file. The app reads bundled configuration
only when packaged. Custom runtime/file configuration remains supported; a
URL-only override to a different project requires that project's key.

## Automated draft releases

`.github/workflows/release.yml` runs on `v*` tags and manual dispatch:

1. Check that a tag matches `package.json` (for example `v2.0.0`).
2. Run lint, formatting, and unit tests.
3. Start a fresh local Supabase stack, applying all committed migrations, and
   run the authentication, two-device, realtime, and isolation integration tests.
4. Build macOS arm64 and x64 DMG/ZIP downloads, Windows x64 installer/portable
   EXEs, and a Linux x64 AppImage on their respective operating systems.
5. Upload downloads as workflow artifacts. Tag runs also collect them in a
   draft GitHub release with SHA-256 checksums. Reruns can replace assets only
   while the release remains a draft; published releases are never overwritten.

In GitHub repository Settings → Secrets and variables → Actions, configure:

- Repository variable `WORK_RADAR_RELEASE_SUPABASE_URL`.
- Repository secret `WORK_RADAR_RELEASE_SUPABASE_KEY` (public, but kept out of
  tracked files and ordinary workflow output).

The workflow fails if either value is missing. It never applies migrations to
production, changes hosted auth settings, or publishes a release automatically.
Review the draft notes and finish the checks below before publishing. If the
repository is private, downloads require repository access; use an appropriately
accessible distribution location when sharing outside that group. Never bundle
GitHub access tokens into the app.

## Signing

Unsigned builds can be used for initial testing, with operating-system warnings.
For ordinary distribution, configure signing before building the release:

- macOS: `MAC_CSC_LINK` (base64 certificate or supported certificate URL),
  `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
  `APPLE_TEAM_ID` as repository secrets. Electron Builder signs and notarizes
  when those credentials are present. Use a Developer ID Application certificate.
- Windows: `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` for a supported signing
  certificate. Hardware/cloud signing may require adapting the Windows signing
  configuration to your provider instead of a certificate file.

When the Mac signing certificate secret is configured, CI mounts the finished
DMG and verifies the app's signature, stapled notarization ticket, and Gatekeeper
acceptance before uploading the downloads. A failed check blocks that artifact.

Credentials are passed only to the matching platform's build step. Supplying
signing credentials does not replace checking the actual downloaded artifacts:
verify macOS signing/notarization and Windows Authenticode on fresh machines.
There is no claim that an unsigned draft is ready for ordinary distribution.

## Supabase migration and hosted readiness

Desktop packaging does not change the database schema. The backend must already
have all six migrations, through `20260924120000_project_review_schedule.sql`.
That last migration adds review/checkpoint fields and replaces `push_items`;
legacy clients that omit the new fields preserve their stored values on updates.
It does not drop existing project data.

From an authenticated terminal in this project:

```bash
npx supabase migration list --linked
npx supabase db push --linked --dry-run
```

Confirm the linked project is the intended release backend. These commands read
migration history and preview pending changes. Review any pending SQL before
running `npx supabase db push --linked`. Apply backend changes **before** handing
out a client that requires them. Never run a database reset against production.
Existing applied migration files should remain immutable; future schema changes
belong in new migrations. Recipients never run the CLI or migrations themselves.

Migration history alone does not verify manually edited schema or hosted auth:

- Check RLS is enabled and the deployed schema/RPCs match the migrations.
- Set Site URL and allowed redirect to
  `http://127.0.0.1:54390/auth/callback`; use a 10-minute magic-link expiry.
- Disable public signups and create/confirm the invited users' accounts.
- Configure custom SMTP and test delivery to an invited address outside the
  Supabase organization team. The default SMTP service cannot deliver to them.
- Confirm the cloud data destination has any required company approval described
  in the README when handling work data.

No production credentials or production data are needed by release CI. It uses
an isolated local stack and throwaway users. A passing local suite establishes
client/schema compatibility, not the hosted project's current configuration or
real email delivery.

## Fresh-install and upgrade checks

Use a clean OS account or disposable VM for each platform, keeping the existing
development app-data folder untouched:

- Open the shared build without Node, environment variables, or a config file.
  It should show email sign-in, not the key prompt. Dismiss/skip sign-in and
  confirm local editing still works.
- Sign in with an invited account, open the email on the same machine with the
  app still running, and verify session restoration after a restart.
- Sign in to the same account on a second machine. Edit on both, edit while one
  is offline, reconnect, and confirm convergence including review schedules,
  checkpoints, archived items, and logs.
- Use a different account on a separate clean OS profile to confirm its cloud
  radar is isolated. Local data is scoped to the OS profile, not an account
  switch; signing out does not clear the existing local radar.
- Upgrade an existing installation. Confirm local JSON, daily backups, and sign-in
  remain available. Export a backup before the manual upgrade test.
- Check the Windows portable EXE on a clean machine and the Linux AppImage with
  a working keyring. Linux keyring availability affects persisted sign-in.
- Test the hosted magic link and callback port. The local listener uses fixed
  port 54390, and the link must be opened on the computer requesting it.

The app keeps its stable `work-radar` app-data directory. The Windows portable
EXE requires no installer but is not a USB data container: data and encrypted
sessions stay in the OS profile. On another computer, sign in again and sync.
Manual upgrades retain app data; automatic updates will be added after this
first release is proven.
