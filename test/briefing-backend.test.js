'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildBriefing: clientBuildBriefing } = require('../briefing.js');

async function backendModules() {
  const [model, worker] = await Promise.all([
    import('../supabase/functions/morning-briefing/model.ts'),
    import('../supabase/functions/morning-briefing/worker.ts'),
  ]);
  return { model, worker };
}

test('server model matches desktop model for legacy DB timestamps and explicit dates', async () => {
  const { model } = await backendModules();
  const items = [
    {
      id: 'iso',
      name: 'ISO',
      priority: 'high',
      reviewedAt: '2026-03-07T23:30:00.000Z',
      reviewIntervalDays: 1,
    },
    { id: 'explicit', name: 'Explicit', priority: 'critical', nextReviewOn: '2026-03-09' },
    {
      id: 'archived',
      name: 'Archived',
      priority: 'critical',
      nextReviewOn: '2026-03-08',
      archivedAt: '2026-03-01T00:00:00Z',
    },
  ];
  const client = clientBuildBriefing(items, {
    localDate: '2026-03-09',
    timezone: 'America/New_York',
    generatedAt: 'fixture',
  });
  const server = model.buildBriefing(items, {
    localDate: '2026-03-09',
    timezone: 'America/New_York',
    generatedAt: 'fixture',
  });
  assert.deepEqual(server, client);
});

test('worker marks provider failures while continuing to the next leased claim', async () => {
  const { worker } = await backendModules();
  const finished = [];
  const claims = [
    { id: 'delivery-1', owner_id: 'owner-1', lease_until: '2026-09-27T08:10:00Z' },
    { id: 'delivery-2', owner_id: 'owner-2', lease_until: '2026-09-27T08:10:00Z' },
  ];
  await worker.processDeliveryClaims(claims, {
    sendForUser: async (ownerId, idempotencyKey) => {
      if (ownerId === 'owner-1') {
        const error = new Error('provider unavailable');
        error.retryAfterSeconds = 42;
        throw error;
      }
      assert.equal(idempotencyKey, 'delivery-2');
      return { skipped: false, providerId: 'provider-2' };
    },
    finishDelivery: async (...args) => finished.push(args),
    safeError: () => 'provider rejected briefing (503)',
  });
  assert.deepEqual(
    finished.map((entry) => [entry[0].id, entry[1], entry[4]]),
    [
      ['delivery-1', 'failed', 42],
      ['delivery-2', 'sent', 0],
    ]
  );
});

test('worker keeps the delivery id as the idempotency key on repeated claims', async () => {
  const { worker } = await backendModules();
  const keys = [];
  const finished = [];
  const claim = { id: 'stable-delivery', owner_id: 'owner-1', lease_until: '2026-09-27T08:10:00Z' };
  await worker.processDeliveryClaims([claim, claim], {
    sendForUser: async (_ownerId, idempotencyKey) => {
      keys.push(idempotencyKey);
      return { skipped: false, providerId: `provider-for-${idempotencyKey}` };
    },
    finishDelivery: async (...args) => finished.push(args),
    safeError: () => 'unused',
  });
  assert.deepEqual(keys, ['stable-delivery', 'stable-delivery']);
  assert.equal(
    finished.every((entry) => entry[0].lease_until === claim.lease_until),
    true
  );
});

test('worker records empty briefings as skipped without calling a provider', async () => {
  const { worker } = await backendModules();
  let providerCalls = 0;
  const finished = [];
  await worker.processDeliveryClaims([{ id: 'empty', owner_id: 'owner', lease_until: 'lease' }], {
    sendForUser: async () => {
      providerCalls += 1;
      return { skipped: true };
    },
    finishDelivery: async (...args) => finished.push(args),
    safeError: () => 'unused',
  });
  assert.equal(providerCalls, 1);
  assert.equal(finished[0][1], 'skipped');
  assert.equal(finished[0][2], null);
});

test('SQL and worker enforce scheduler-only claim completion and 30-day retention', () => {
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'supabase/migrations/20260927150000_morning_briefing_reliability.sql'
    ),
    'utf8'
  );
  const functionSource = fs.readFileSync(
    path.join(__dirname, '..', 'supabase/functions/morning-briefing/index.ts'),
    'utf8'
  );
  assert.match(migration, /state = 'claimed'\s+and\s+lease_until = p_lease_until/);
  assert.match(migration, /created_at < now\(\) - interval '30 days'/);
  assert.match(migration, /state = 'claimed' and coalesce\(d\.lease_until, now_utc\) <= now_utc/);
  assert.match(functionSource, /classifyRequest/);
  assert.match(functionSource, /prepareDelivery/);
  assert.ok(functionSource.includes('claim?.payload'));
  assert.match(migration, /payload = case/);
  assert.match(migration, /revoke select on public.briefing_deliveries from authenticated/);
  assert.match(functionSource, /'Idempotency-Key': idempotencyKey/);
  assert.match(functionSource, /email_confirmed_at/);
  assert.match(functionSource, /latestTest/);
  assert.match(functionSource, /safeStoredError/);
  assert.match(functionSource, /status: result\.skipped \? 'skipped' : 'sent'/);
  assert.match(
    fs.readFileSync(path.join(__dirname, '..', 'supabase/config.toml'), 'utf8'),
    /\[functions\.morning-briefing\][\s\S]*verify_jwt = false/
  );
});

test('function endpoint access policy rejects anonymous requests and separates scheduler from user auth', async () => {
  const { classifyRequest } = await import('../supabase/functions/morning-briefing/auth.ts');
  assert.equal(
    classifyRequest({
      schedulerSecret: 'secret',
      suppliedSchedulerSecret: '',
      hasAuthorization: false,
    }),
    'unauthorized'
  );
  assert.equal(
    classifyRequest({
      schedulerSecret: 'secret',
      suppliedSchedulerSecret: '',
      hasAuthorization: true,
    }),
    'user'
  );
  assert.equal(
    classifyRequest({
      schedulerSecret: 'secret',
      suppliedSchedulerSecret: 'secret',
      hasAuthorization: false,
    }),
    'scheduler'
  );
  assert.equal(
    classifyRequest({
      schedulerSecret: 'secret',
      suppliedSchedulerSecret: 'wrong',
      hasAuthorization: true,
    }),
    'user'
  );
  assert.equal(
    classifyRequest({
      schedulerSecret: '',
      suppliedSchedulerSecret: 'anything',
      hasAuthorization: false,
    }),
    'unauthorized'
  );
});
