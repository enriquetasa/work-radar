# Morning briefing operations

The briefing is opt-in. The desktop client may save local preferences before an
account is connected, but the Edge Function is the authority for cloud
preferences, delivery, recipients, and test-send rate limits. It accepts only a
verified `auth.users.email_confirmed_at` address and always filters `items` by
that user’s `user_id`.

## Database setup

Review and apply the migrations in order with the normal deployment process.
The reliability migration is additive because the initial briefing migration
may already be present:

```sh
supabase db push
```

The migration creates the preference and delivery tables, owner-only read
policies, server-only claim/finish functions, a ten-minute test-send limit,
expired-lease recovery, and a 30-day metadata purge. It does not send email or
schedule a hosted job. Keep `auth.enable_signup` disabled for the invite-only
deployment.

## Edge Function secrets

Store these as server-side Edge Function secrets or in the deployment secret
store. Never put them in Electron, the repository, or a client payload.

- `BRIEFING_SCHEDULER_SECRET`: a high-entropy value used only by the scheduler
  request header.
- `RESEND_API_KEY`: the provider API key.
- `BRIEFING_FROM`: a verified Resend sender, including the display name if
  desired.
- `BRIEFING_EMAIL_PROVIDER`: `resend` for the current adapter.

For example, set placeholders through the Supabase CLI after replacing them in
the operator’s secret manager:

```sh
supabase secrets set \
  BRIEFING_SCHEDULER_SECRET='REPLACE_FROM_SECRET_MANAGER' \
  RESEND_API_KEY='REPLACE_FROM_SECRET_MANAGER' \
  BRIEFING_FROM='Work Radar <briefing@example.com>' \
  BRIEFING_EMAIL_PROVIDER='resend'
```

The Resend adapter sends `briefing_deliveries.id` as `Idempotency-Key`.
Resend’s idempotency window is documented as 24 hours; the worker caps attempts
and does not invent a new key for a recovered claim. Verify the provider sender
domain and this behavior with a synthetic recipient before enabling scheduling.

## Five-minute scheduler

Configure one protected HTTP job after the function and secrets are verified. Deploy with the repository config, which sets `[functions.morning-briefing] verify_jwt = false`; the function then enforces either `x-scheduler-secret` or a valid bearer token itself. If deploying with a CLI or dashboard override, explicitly disable gateway JWT verification for this function (equivalent to `supabase functions deploy morning-briefing --no-verify-jwt`) so the scheduler header reaches the handler.
The job must send `x-scheduler-secret` and invoke the deployed
`morning-briefing` function. A scheduler request is the only global processing
path; an authenticated desktop request can only read/update its own preferences,
preview its own cloud data, read its own status, or request a self-only test.

Supabase Cron can call the function through `pg_net`. Keep the scheduler URL and
secret in Vault/operator-managed secrets rather than committing a project URL
or credential. The following is a deployment template; review the project URL,
Vault key names, and role permissions before running it:

```sql
select cron.schedule(
  'work-radar-morning-briefing',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/morning-briefing',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-scheduler-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'BRIEFING_SCHEDULER_SECRET')
    ),
    body := '{}'::jsonb
  );
  $$
);
```

Do not run this template until a test invocation has been observed with a
synthetic account and the sender domain has passed provider verification. A
function/provider failure leaves a bounded failed delivery record; the next
scheduler invocation can recover it while its lease is expired. A missed
schedule is eligible only during the two hours after the user’s local scheduled
time, so downtime does not create a backlog of old messages.

History retention is independent of the email worker. If Supabase Cron is
available, schedule the trusted revision cleanup once per day (and review the
role used by the job):

```sql
select cron.schedule(
  'work-radar-prune-item-revisions',
  '17 3 * * *',
  $$ select public.prune_item_revisions(100); $$
);
```

Attachment reconciliation also requires a trusted service-role operator for
objects left behind after an administrator deletes a parent row. The normal
client cannot list metadata-less or pending Storage objects under the private
bucket, so do not widen Storage read policies for cleanup. Run the service
reconciliation procedure only after reviewing the owner scope and grace
period.

## Function actions

The authenticated function API uses JSON actions:

- `preferences` with optional `preferences: { enabled, time, timezone,
weekdays }` reads or updates only the token owner’s settings.
- `preview` optionally accepts the same preferences and `localDate` and returns
  the deterministic cloud-data preview plus text/HTML rendering.
- `status` returns the owner’s latest delivery metadata.
- `test` claims the owner’s rate-limited test slot and sends only to the
  verified Auth email.

Empty or disabled briefings are recorded as skipped and send no provider
request. Rendered bodies are frozen only in the service-only payload column while a claim is active or retryable within the two-hour late window, then cleared on terminal success, skip, final failure, or expiry. Client column grants exclude the payload, and all remaining delivery metadata is purged after 30 days.
