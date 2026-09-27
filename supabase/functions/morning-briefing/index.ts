import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildBriefing, renderBriefing, validTimezone } from './model.ts';
import { processDeliveryClaims } from './worker.ts';
import { classifyRequest } from './auth.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const schedulerSecret = Deno.env.get('BRIEFING_SCHEDULER_SECRET') || '';
const provider = Deno.env.get('BRIEFING_EMAIL_PROVIDER') || 'resend';
const resendKey = Deno.env.get('RESEND_API_KEY') || '';
const sender = Deno.env.get('BRIEFING_FROM') || '';
const admin = createClient(supabaseUrl, serviceKey);

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const cors = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });

type Preferences = {
  enabled: boolean;
  timezone: string;
  time: string;
  weekdays: string[];
};

type BriefingResult = { skipped: boolean; reason?: string; providerId?: string };

type FrozenPayload = {
  recipient: string;
  from: string;
  subject: string;
  html: string;
  text: string;
};

class ProviderError extends Error {
  retryAfterSeconds?: number;

  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ProviderError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function normalizePreferences(input: unknown, fallbackTimezone = 'UTC'): Preferences {
  const source = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const timezone =
    typeof source.timezone === 'string' && validTimezone(source.timezone)
      ? source.timezone
      : validTimezone(fallbackTimezone)
        ? fallbackTimezone
        : 'UTC';
  const time =
    typeof source.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(source.time)
      ? source.time
      : typeof source.local_time === 'string' &&
          /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(source.local_time)
        ? source.local_time.slice(0, 5)
        : '08:00';
  const weekdays = Array.isArray(source.weekdays)
    ? [
        ...new Set(
          source.weekdays.filter(
            (day): day is string => typeof day === 'string' && WEEKDAYS.includes(day)
          )
        ),
      ]
    : WEEKDAYS.slice(0, 5);
  return { enabled: source.enabled === true, timezone, time, weekdays };
}

function dbPreferences(preferences: Preferences, ownerId: string) {
  return {
    owner_id: ownerId,
    enabled: preferences.enabled,
    timezone: preferences.timezone,
    local_time: preferences.time,
    weekdays: preferences.weekdays,
    updated_at: new Date().toISOString(),
  };
}

function toSafeError(error: unknown): string {
  if (error instanceof ProviderError) return error.message.slice(0, 240);
  if (error instanceof Error && error.message === 'briefing email provider is not configured')
    return error.message;
  return 'briefing delivery failed';
}

function safeStoredError(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return value.replace(/[\r\n]+/g, ' ').slice(0, 240);
}

async function authenticatedUser(request: Request) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

async function getPreferences(ownerId: string): Promise<Preferences | null> {
  const { data, error } = await admin
    .from('briefing_preferences')
    .select('enabled,timezone,local_time,weekdays')
    .eq('owner_id', ownerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return normalizePreferences({
    enabled: data.enabled,
    timezone: data.timezone,
    local_time: data.local_time,
    weekdays: data.weekdays,
  });
}

async function readOwnedItems(ownerId: string) {
  const { data, error } = await admin.from('items').select('*').eq('user_id', ownerId);
  if (error) throw error;
  return (data || []).map((row) => ({
    ...row,
    archivedAt: row.archived_at,
    deletedAt: row.deleted_at,
    reviewIntervalDays: row.review_interval_days,
    nextReviewOn: row.next_review_on,
    waitingOn: row.waiting_on,
    checkpoint: row.checkpoint,
    checkpointOn: row.checkpoint_on,
    reviewedAt: row.reviewed_at,
    addedAt: row.added_at,
  }));
}

async function send(message: FrozenPayload, idempotencyKey: string) {
  if (provider !== 'resend' || !resendKey)
    throw new Error('briefing email provider is not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${resendKey}`,
      'content-type': 'application/json',
      // Resend retains this key for 24 hours. Delivery IDs are stable across
      // worker retries, so a lost provider response cannot duplicate a send.
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      from: message.from,
      to: [message.recipient],
      subject: message.subject,
      html: message.html,
      text: message.text,
    }),
  });
  if (response.ok) {
    const body = await response.json().catch(() => ({}));
    return body.id || idempotencyKey;
  }
  const retryAfter = Number(response.headers.get('retry-after'));
  const retrySeconds =
    Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(Math.ceil(retryAfter), 3600)
      : undefined;
  throw new ProviderError(`provider rejected briefing (${response.status})`, retrySeconds);
}

async function prepareDelivery(
  claim: { id: unknown; lease_until: unknown },
  payload: FrozenPayload
): Promise<FrozenPayload> {
  const { data, error } = await admin.rpc('prepare_briefing_delivery', {
    p_delivery_id: claim.id,
    p_lease_until: claim.lease_until,
    p_payload: payload,
  });
  if (error) throw error;
  return data as FrozenPayload;
}

async function sendForUser(
  ownerId: string,
  idempotencyKey: string,
  claim?: { id: unknown; lease_until: unknown; payload?: unknown }
): Promise<BriefingResult> {
  const preferences = await getPreferences(ownerId);
  if (!preferences?.enabled) return { skipped: true, reason: 'disabled' };

  const { data, error } = await admin.auth.admin.getUserById(ownerId);
  if (error) throw error;
  const user = data.user;
  // email_confirmed_at is the Auth-side verification bit. A client supplied
  // address is never accepted, even for a test action.
  if (!user?.email || !user.email_confirmed_at)
    return { skipped: true, reason: 'unverified_email' };
  if (provider !== 'resend' || !resendKey)
    throw new Error('briefing email provider is not configured');

  let payload = claim?.payload as FrozenPayload | null;
  if (
    !payload ||
    typeof payload !== 'object' ||
    !payload.recipient ||
    !payload.from ||
    !payload.subject ||
    !payload.html ||
    !payload.text
  ) {
    if (!sender) throw new Error('briefing email provider is not configured');
    const briefing = buildBriefing(await readOwnedItems(ownerId), {
      timezone: preferences.timezone,
      generatedAt: new Date().toISOString(),
    });
    if (!briefing.projects.length) return { skipped: true, reason: 'empty' };
    const rendered = renderBriefing(briefing);
    payload = {
      recipient: user.email,
      from: sender,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    };
    if (claim) payload = await prepareDelivery(claim, payload);
  }
  return { skipped: false, providerId: await send(payload, idempotencyKey) };
}

async function finishDelivery(
  claim: Record<string, unknown>,
  state: 'sent' | 'skipped' | 'failed',
  providerId: string | null,
  error: string | null,
  retryAfterSeconds = 0
) {
  const { error: finishError } = await admin.rpc('finish_briefing_delivery', {
    p_delivery_id: claim.id,
    p_lease_until: claim.lease_until,
    p_state: state,
    p_provider_id: providerId,
    p_error: error,
    p_retry_after_seconds: retryAfterSeconds,
  });
  if (finishError) throw finishError;
}

async function processClaims() {
  const { error: purgeError } = await admin.rpc('purge_briefing_metadata');
  if (purgeError) console.error('briefing metadata purge failed');
  const { data: claims, error } = await admin.rpc('claim_briefing_deliveries', { batch_size: 50 });
  if (error) throw error;
  await processDeliveryClaims(claims || [], {
    sendForUser,
    finishDelivery,
    safeError: toSafeError,
  });
}

async function savePreferences(userId: string, input: unknown) {
  const preferences = normalizePreferences(input);
  const { data, error } = await admin
    .from('briefing_preferences')
    .upsert(dbPreferences(preferences, userId))
    .select('enabled,timezone,local_time,weekdays')
    .single();
  if (error) throw error;
  return normalizePreferences({
    enabled: data.enabled,
    timezone: data.timezone,
    local_time: data.local_time,
    weekdays: data.weekdays,
  });
}

async function handleUserAction(
  user: { id: string; email?: string | undefined; email_confirmed_at?: string | null },
  body: Record<string, unknown>
) {
  if (body.action === 'preferences') {
    if (body.preferences === undefined)
      return json({ ok: true, preferences: await getPreferences(user.id) });
    return json({ ok: true, preferences: await savePreferences(user.id, body.preferences) });
  }
  if (body.action === 'preview') {
    const saved = await getPreferences(user.id);
    const preferences = normalizePreferences(body.preferences || saved || {});
    const briefing = buildBriefing(await readOwnedItems(user.id), {
      timezone: preferences.timezone,
      localDate: typeof body.localDate === 'string' ? body.localDate : undefined,
      generatedAt: new Date().toISOString(),
    });
    return json({ ok: true, briefing, rendered: renderBriefing(briefing) });
  }
  if (body.action === 'status') {
    const preferences = await getPreferences(user.id);
    const [{ data, error }, { data: test, error: testError }] = await Promise.all([
      admin
        .from('briefing_deliveries')
        .select('local_date,state,attempt_count,last_attempt_at,sent_at,error')
        .eq('owner_id', user.id)
        .order('local_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin
        .from('briefing_test_sends')
        .select('state,provider_id,error,created_at,finished_at')
        .eq('owner_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (error) throw error;
    if (testError) throw testError;
    return json({
      ok: true,
      preferences,
      latestDelivery: data ? { ...data, error: safeStoredError(data.error) } : null,
      latestTest: test ? { ...test, error: safeStoredError(test.error) } : null,
    });
  }
  if (body.action !== 'test') return json({ error: 'unsupported action' }, 400);
  if (!user.email || !user.email_confirmed_at)
    return json({ error: 'verified account email unavailable' }, 403);

  const { data: testId, error: claimError } = await admin.rpc('claim_briefing_test_send', {
    p_owner_id: user.id,
  });
  if (claimError) throw claimError;
  if (!testId) return json({ error: 'test briefing rate limited' }, 429);
  try {
    const result = await sendForUser(user.id, `test-${testId}`);
    const state = result.skipped ? 'skipped' : 'sent';
    const { error } = await admin.rpc('finish_briefing_test_send', {
      p_test_id: testId,
      p_state: state,
      p_provider_id: result.providerId || null,
      p_error: null,
    });
    if (error) throw error;
    return json({
      ok: true,
      status: result.skipped ? 'skipped' : 'sent',
      skipped: result.skipped,
      reason: result.reason || null,
      providerId: result.providerId || null,
    });
  } catch (error) {
    const safeError = toSafeError(error);
    await admin.rpc('finish_briefing_test_send', {
      p_test_id: testId,
      p_state: 'failed',
      p_provider_id: null,
      p_error: safeError,
    });
    return json({ ok: false, status: 'failed', error: safeError }, 502);
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS')
    return new Response(null, {
      headers: {
        ...cors,
        'access-control-allow-headers': 'authorization, content-type, x-scheduler-secret',
      },
    });
  const suppliedSchedulerSecret = request.headers.get('x-scheduler-secret') || '';
  const access = classifyRequest({
    schedulerSecret,
    suppliedSchedulerSecret,
    hasAuthorization: Boolean(request.headers.get('authorization')),
  });
  if (access === 'scheduler') {
    try {
      await processClaims();
      return json({ ok: true });
    } catch (_error) {
      console.error('morning briefing scheduler failed');
      return json({ error: 'briefing worker failed' }, 500);
    }
  }

  if (access !== 'user') return json({ error: 'authentication required' }, 401);
  const user = await authenticatedUser(request);
  if (!user) return json({ error: 'authentication required' }, 401);
  let body: Record<string, unknown> = {};
  if (request.method !== 'GET') {
    const parsed = await request.json().catch(() => null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return json({ error: 'invalid request' }, 400);
    body = parsed as Record<string, unknown>;
  }
  if (request.method === 'GET') body.action = 'preferences';
  try {
    return await handleUserAction(user, body);
  } catch (_error) {
    console.error('morning briefing user action failed');
    return json({ error: 'briefing request failed' }, 500);
  }
});
