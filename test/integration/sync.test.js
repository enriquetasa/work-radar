'use strict';
/* ============================================================
   WORK RADAR — integration tests: Supabase sync (Phase 2, database)
   Exercises the LOCAL Supabase stack directly over supabase-js: RLS
   isolation between two users, the push_items / push_log_entries RPCs,
   and the synced_at trigger.

   Needs `npx supabase start` already running (see README/plan). Never
   targets a hosted project — the URL and keys are read fresh from
   `supabase status -o json` every run rather than hardcoded (see the
   secrets rule); no key is ever committed.

   Deliberately excluded from `npm test` (slow, needs the local stack) —
   run via `npm run test:integration`.
   ============================================================ */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createClient } = require('@supabase/supabase-js');

const logger = require('../../logger.js');

// Read the running local stack's URL and keys fresh, every run — see the
// module doc comment above. Throws with a clear message if the stack
// isn't up, rather than a confusing fetch-failed error from supabase-js.
function readLocalSupabaseConfig() {
  let raw;
  try {
    raw = execFileSync('npx', ['supabase', 'status', '-o', 'json'], { encoding: 'utf8' });
  } catch (err) {
    throw new Error(
      'Could not read `supabase status -o json` — is the local stack running ' +
        '(`npx supabase start`)? ' +
        err.message
    );
  }
  const status = JSON.parse(raw);
  if (!status.API_URL || !status.PUBLISHABLE_KEY || !status.SECRET_KEY) {
    throw new Error('supabase status did not include API_URL/PUBLISHABLE_KEY/SECRET_KEY');
  }
  return {
    url: status.API_URL,
    publishableKey: status.PUBLISHABLE_KEY,
    secretKey: status.SECRET_KEY,
  };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// A push_items row, camelCase per the RPC's contract (push_rpc_functions
// migration). Fields not overridden get sensible, valid defaults.
function itemPayload(overrides) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: 'Untitled',
    status: 'active',
    priority: 'medium',
    category: '',
    notes: '',
    addedAt: iso(now),
    updatedAt: iso(now),
    reviewedAt: iso(now),
    ...overrides,
  };
}

function logEntryPayload(itemId, overrides) {
  return {
    id: crypto.randomUUID(),
    itemId,
    ts: iso(Date.now()),
    text: 'note',
    ...overrides,
  };
}

// Pushes one item via the RPC and asserts it was accepted, so setup steps
// fail loudly (rather than leaving a test to dereference null/undefined
// data) when the push itself is rejected or errors.
async function pushAcceptedItem(client, overrides) {
  const item = itemPayload(overrides);
  const { data, error } = await client.rpc('push_items', { items: [item] });
  assert.equal(error, null, 'push_items setup call must not error');
  assert.equal(data[0].accepted, true, 'push_items setup call must be accepted');
  return item;
}

// Creates a confirmed test user and a signed-in client for it. The
// password is generated per-run and used only to drive these tests —
// never persisted, never a real account. If sign-in fails after the user
// was created, the user is deleted here rather than left behind, since it
// never makes it into userA/userB for the suite's `after` hook to clean up.
async function createSignedInUser(admin, config, label) {
  const email = `work-radar-test-${label}-${crypto.randomUUID()}@example.com`;
  const password = crypto.randomBytes(24).toString('hex');
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;

  const client = createClient(config.url, config.publishableKey);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) {
    const { error: cleanupError } = await admin.auth.admin.deleteUser(data.user.id);
    if (cleanupError) {
      logger.error('failed to clean up test user after sign-in failure', {
        err: cleanupError,
        userId: data.user.id,
        label,
      });
    }
    throw signInError;
  }

  logger.info('integration test user created', { userId: data.user.id, label });
  return { client, userId: data.user.id, email };
}

let admin;
let config;
let userA;
let userB;

before(async () => {
  config = readLocalSupabaseConfig();
  admin = createClient(config.url, config.secretKey);
  userA = await createSignedInUser(admin, config, 'a');
  userB = await createSignedInUser(admin, config, 'b');
});

after(async () => {
  // Deleting the auth user cascades to their items/log_entries (on delete
  // cascade), so no separate row cleanup is needed. Each deletion is
  // independent so one failure doesn't skip the other. deleteUser resolves
  // with { error } rather than throwing (like the rest of supabase-js
  // auth), so a try/catch here would never fire — check error explicitly
  // and log it with context instead of swallowing a failed cleanup.
  for (const user of [userA, userB]) {
    if (!user) continue;
    const { error } = await admin.auth.admin.deleteUser(user.userId);
    if (error) {
      logger.error('failed to clean up integration test user', { err: error, userId: user.userId });
    }
  }
});

test('push_items inserts a new item, server-stamped synced_at', async () => {
  const item = itemPayload({ name: 'Alpha project' });
  const { data, error } = await userA.client.rpc('push_items', { items: [item] });
  assert.equal(error, null);
  assert.deepEqual(data, [{ row_id: item.id, accepted: true, reason: null }]);

  const { data: row, error: selectError } = await userA.client
    .from('items')
    .select('*')
    .eq('id', item.id)
    .single();
  assert.equal(selectError, null);
  assert.equal(row.name, 'Alpha project');
  assert.ok(row.synced_at, 'synced_at must be set');
  // Sanity: server-set, so it lands close to "now", not far in the past.
  assert.ok(Date.now() - new Date(row.synced_at).getTime() < 60_000);
});

test('push_items rejects a stale update — newest updated_at wins', async () => {
  const id = crypto.randomUUID();
  const now = Date.now();
  const first = itemPayload({ id, name: 'Original', updatedAt: iso(now) });
  const stale = itemPayload({ id, name: 'Stale overwrite attempt', updatedAt: iso(now - 60_000) });

  const { data: firstResult, error: firstError } = await userA.client.rpc('push_items', {
    items: [first],
  });
  assert.equal(firstError, null);
  assert.equal(firstResult[0].accepted, true);

  const { data: staleResult, error: staleError } = await userA.client.rpc('push_items', {
    items: [stale],
  });
  assert.equal(staleError, null);
  assert.equal(staleResult[0].accepted, false);
  assert.equal(staleResult[0].reason, 'stale_or_not_owned');

  const { data: row, error: selectError } = await userA.client
    .from('items')
    .select('name')
    .eq('id', id)
    .single();
  assert.equal(selectError, null);
  assert.equal(row.name, 'Original', 'the older push must not have overwritten the newer row');
});

test('synced_at is server-set and ignores a client-supplied value', async () => {
  const id = crypto.randomUUID();
  await pushAcceptedItem(userA.client, { id, name: 'Before' });

  const { error: updateError } = await userA.client
    .from('items')
    .update({ name: 'After', synced_at: '2000-01-01T00:00:00Z' })
    .eq('id', id);
  assert.equal(updateError, null);

  const { data: row, error: selectError } = await userA.client
    .from('items')
    .select('name, synced_at')
    .eq('id', id)
    .single();
  assert.equal(selectError, null);
  assert.equal(row.name, 'After');
  assert.ok(
    new Date(row.synced_at).getFullYear() > 2000,
    'the trigger must overwrite a client-supplied synced_at with the server clock'
  );
});

test('RLS isolation: user B cannot read, update or forge-insert into user A rows', async () => {
  const id = crypto.randomUUID();
  await pushAcceptedItem(userA.client, { id, name: "A's item" });

  // B can't see it.
  const { data: seenByB, error: selectError } = await userB.client
    .from('items')
    .select('*')
    .eq('id', id);
  assert.equal(selectError, null);
  assert.deepEqual(seenByB, []);

  // B's update matches zero rows (RLS hides the row rather than erroring).
  const { data: updatedByB, error: updateError } = await userB.client
    .from('items')
    .update({ name: 'HACKED' })
    .eq('id', id)
    .select();
  assert.equal(updateError, null);
  assert.deepEqual(updatedByB, []);

  const { data: stillA, error: stillAError } = await userA.client
    .from('items')
    .select('name')
    .eq('id', id)
    .single();
  assert.equal(stillAError, null);
  assert.equal(stillA.name, "A's item", "unaffected by B's update attempt");

  // B can't insert a row claiming to belong to A.
  const forgedId = crypto.randomUUID();
  const now = iso(Date.now());
  const { error: insertError } = await userB.client.from('items').insert({
    id: forgedId,
    user_id: userA.userId,
    name: 'forged',
    status: 'active',
    priority: 'low',
    added_at: now,
    updated_at: now,
    reviewed_at: now,
  });
  assert.ok(insertError, 'inserting with a forged user_id must be rejected by RLS');

  // And push_items (SECURITY INVOKER, so still subject to RLS) can't be
  // used to overwrite A's row either, even though it always stamps
  // user_id from B's own auth.uid() rather than trusting the payload.
  const { data: attack, error: rpcError } = await userB.client.rpc('push_items', {
    items: [itemPayload({ id, name: 'RPC HACK', updatedAt: iso(Date.now() + 1_000_000) })],
  });
  assert.equal(rpcError, null);
  assert.equal(attack[0].accepted, false);
  assert.equal(attack[0].reason, 'stale_or_not_owned');
  const { data: unaffected, error: unaffectedError } = await userA.client
    .from('items')
    .select('name')
    .eq('id', id)
    .single();
  assert.equal(unaffectedError, null);
  assert.equal(unaffected.name, "A's item");
});

test('RLS + composite FK: user B cannot attach a log entry to user A item, directly or via the RPC', async () => {
  const itemId = crypto.randomUUID();
  await pushAcceptedItem(userA.client, { id: itemId, name: "A's item for log FK test" });

  // Direct PostgREST insert: satisfies RLS (log_entries_insert_own only
  // checks the entry's own user_id, which is honestly B) but must be
  // rejected by the composite (item_id, user_id) foreign key on
  // log_entries, since (itemId, B) has no matching row in items.
  const forgedEntryId = crypto.randomUUID();
  const { error: insertError } = await userB.client.from('log_entries').insert({
    id: forgedEntryId,
    item_id: itemId,
    user_id: userB.userId,
    ts: iso(Date.now()),
    text: "trying to attach directly to A's item",
  });
  assert.ok(insertError, 'a direct insert with a forged item_id must be rejected by the FK');

  const { count, error: countError } = await userB.client
    .from('log_entries')
    .select('*', { count: 'exact', head: true })
    .eq('id', forgedEntryId);
  assert.equal(countError, null);
  assert.equal(count, 0);

  // And the RPC path, which already had its own ownership check.
  const { data: fromB, error: rpcError } = await userB.client.rpc('push_log_entries', {
    entries: [logEntryPayload(itemId, { text: "trying to attach via RPC to A's item" })],
  });
  assert.equal(rpcError, null);
  assert.equal(fromB[0].accepted, false);
  assert.equal(fromB[0].reason, 'item_not_found');
});

test('push_log_entries is append-only and idempotent, and handles push-before-item', async () => {
  const itemId = crypto.randomUUID();
  const entry = logEntryPayload(itemId, { text: 'first note' });

  // The item hasn't been pushed yet — rejected, not a batch-aborting error.
  const { data: tooEarly, error: tooEarlyError } = await userA.client.rpc('push_log_entries', {
    entries: [entry],
  });
  assert.equal(tooEarlyError, null);
  assert.equal(tooEarly[0].accepted, false);
  assert.equal(tooEarly[0].reason, 'item_not_found');

  await pushAcceptedItem(userA.client, { id: itemId, name: 'Has a log' });

  const { data: pushed, error: pushedError } = await userA.client.rpc('push_log_entries', {
    entries: [entry],
  });
  assert.equal(pushedError, null);
  assert.equal(pushed[0].accepted, true);

  // Pushing the exact same entry again is a no-op, not a duplicate row —
  // and crucially, changed content on the re-push is also discarded, not
  // applied: log entries are append-only, never updated once inserted.
  const changed = { ...entry, text: 'a different note trying to overwrite the first' };
  const { data: again, error: againError } = await userA.client.rpc('push_log_entries', {
    entries: [changed],
  });
  assert.equal(againError, null);
  assert.equal(again[0].accepted, false);
  assert.equal(again[0].reason, 'duplicate');

  const { data: rows, error: selectError } = await userA.client
    .from('log_entries')
    .select('text')
    .eq('id', entry.id);
  assert.equal(selectError, null);
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0].text,
    'first note',
    'the original text must survive an id-colliding re-push'
  );

  // B can't attach a log entry to A's item — reported the same as
  // "item doesn't exist", not "item belongs to someone else".
  const { data: fromB, error: fromBError } = await userB.client.rpc('push_log_entries', {
    entries: [logEntryPayload(itemId, { text: "trying to attach to A's item" })],
  });
  assert.equal(fromBError, null);
  assert.equal(fromB[0].accepted, false);
  assert.equal(fromB[0].reason, 'item_not_found');
});

test('log_entries has no update policy: the owner cannot change a stored entry', async () => {
  const itemId = crypto.randomUUID();
  await pushAcceptedItem(userA.client, { id: itemId, name: 'Item for update-policy test' });
  const entry = logEntryPayload(itemId, { text: 'original text' });
  const { error: pushError } = await userA.client.rpc('push_log_entries', { entries: [entry] });
  assert.equal(pushError, null);

  // Even the owner's own direct UPDATE must match zero rows: there is no
  // update policy on log_entries (append-only by design), so RLS denies
  // it by default rather than erroring.
  const { data: updated, error: updateError } = await userA.client
    .from('log_entries')
    .update({ text: 'edited text' })
    .eq('id', entry.id)
    .select();
  assert.equal(updateError, null);
  assert.deepEqual(updated, []);

  const { data: row, error: selectError } = await userA.client
    .from('log_entries')
    .select('text')
    .eq('id', entry.id)
    .single();
  assert.equal(selectError, null);
  assert.equal(row.text, 'original text', 'the row must be unchanged');
});

test('no delete policy (and no DELETE grant) on either table: the owner cannot hard-delete a row', async () => {
  const itemId = crypto.randomUUID();
  await pushAcceptedItem(userA.client, { id: itemId, name: 'Item for delete-policy test' });
  const entry = logEntryPayload(itemId, { text: 'a log entry' });
  const { error: pushError } = await userA.client.rpc('push_log_entries', { entries: [entry] });
  assert.equal(pushError, null);

  // DELETE is revoked from authenticated/anon on both tables (defense in
  // depth beyond the missing delete policy — see the RLS migration), so
  // this errors outright ("permission denied") rather than RLS silently
  // matching zero rows.
  const { error: deleteEntryError } = await userA.client
    .from('log_entries')
    .delete()
    .eq('id', entry.id);
  assert.ok(deleteEntryError, 'DELETE on log_entries must be rejected');
  assert.equal(deleteEntryError.code, '42501');

  const { error: deleteItemError } = await userA.client.from('items').delete().eq('id', itemId);
  assert.ok(deleteItemError, 'DELETE on items must be rejected');
  assert.equal(deleteItemError.code, '42501');

  // Both rows must still exist — PURGE is a tombstone update, never a SQL
  // DELETE, and this proves the database enforces that even if app code
  // tried to issue one.
  const { data: stillItem, error: stillItemError } = await userA.client
    .from('items')
    .select('id')
    .eq('id', itemId)
    .maybeSingle();
  assert.equal(stillItemError, null);
  assert.ok(stillItem, 'the item row must still exist');

  const { data: stillEntry, error: stillEntryError } = await userA.client
    .from('log_entries')
    .select('id')
    .eq('id', entry.id)
    .maybeSingle();
  assert.equal(stillEntryError, null);
  assert.ok(stillEntry, 'the log entry row must still exist');
});

test('synced_at works as a pull cursor: only rows changed after it come back', async () => {
  const idOld = crypto.randomUUID();
  await pushAcceptedItem(userA.client, { id: idOld, name: 'Old news' });

  // Use the server's own synced_at for the older row as the cursor — not
  // the test machine's clock, which the design deliberately keeps
  // separate from the server clock (see the synced_at_trigger migration's
  // comment on why the two can disagree).
  const { data: oldRow, error: oldRowError } = await userA.client
    .from('items')
    .select('synced_at')
    .eq('id', idOld)
    .single();
  assert.equal(oldRowError, null);
  const cursor = oldRow.synced_at;

  const idNew = crypto.randomUUID();
  await pushAcceptedItem(userA.client, { id: idNew, name: 'Fresh news' });

  const { data: newRow, error: newRowError } = await userA.client
    .from('items')
    .select('synced_at')
    .eq('id', idNew)
    .single();
  assert.equal(newRowError, null);
  assert.ok(
    new Date(newRow.synced_at).getTime() > new Date(cursor).getTime(),
    "the newer row's synced_at must be strictly greater than the older row's"
  );

  const { data: pulled, error } = await userA.client
    .from('items')
    .select('id, synced_at')
    .gt('synced_at', cursor)
    .order('synced_at', { ascending: true });
  assert.equal(error, null);
  const pulledIds = pulled.map((r) => r.id);
  assert.ok(pulledIds.includes(idNew), 'the row changed after the cursor must be pulled');
  assert.ok(
    !pulledIds.includes(idOld),
    'the row changed before (or at) the cursor must not be pulled'
  );
});

test('schedules survive legacy edits, reject stale changes, and explicitly clear', async () => {
  const now = Date.now();
  const item = await pushAcceptedItem(userA.client, {
    reviewIntervalDays: 7,
    nextReviewOn: '2026-10-01',
    waitingOn: 'Alex',
    checkpoint: 'Budget decision',
    checkpointOn: '2026-09-28',
    updatedAt: iso(now),
  });
  const read = async () => {
    const { data, error } = await userA.client
      .from('items')
      .select('review_interval_days, next_review_on, waiting_on, checkpoint, checkpoint_on')
      .eq('id', item.id)
      .single();
    assert.equal(error, null);
    return data;
  };
  const expected = {
    review_interval_days: 7,
    next_review_on: '2026-10-01',
    waiting_on: 'Alex',
    checkpoint: 'Budget decision',
    checkpoint_on: '2026-09-28',
  };
  assert.deepEqual(await read(), expected);

  // An older app knows none of the schedule keys; its newer title edit
  // must leave all schedule data intact.
  await pushAcceptedItem(userA.client, {
    id: item.id,
    name: 'Edited by old app',
    updatedAt: iso(now + 1000),
  });
  assert.deepEqual(await read(), expected);

  const { data: stale, error: staleError } = await userA.client.rpc('push_items', {
    items: [{ ...item, updatedAt: iso(now), reviewIntervalDays: 1 }],
  });
  assert.equal(staleError, null);
  assert.equal(stale[0].accepted, false);
  assert.deepEqual(await read(), expected);

  await pushAcceptedItem(userA.client, {
    id: item.id,
    updatedAt: iso(now + 2000),
    reviewIntervalDays: null,
    nextReviewOn: '',
    waitingOn: null,
    checkpoint: '',
    checkpointOn: null,
  });
  assert.deepEqual(await read(), {
    review_interval_days: null,
    next_review_on: null,
    waiting_on: '',
    checkpoint: '',
    checkpoint_on: null,
  });
});

test('legacy inserts use fortnightly reviews; invalid cadence does not abort a batch', async () => {
  const good = itemPayload({ name: 'Legacy default' });
  const bad = itemPayload({ reviewIntervalDays: 0 });
  const { data, error } = await userA.client.rpc('push_items', { items: [bad, good] });
  assert.equal(error, null);
  assert.equal(data[0].accepted, false);
  assert.equal(data[1].accepted, true);
  const { data: row, error: readError } = await userA.client
    .from('items')
    .select('review_interval_days, next_review_on, waiting_on, checkpoint, checkpoint_on')
    .eq('id', good.id)
    .single();
  assert.equal(readError, null);
  assert.deepEqual(row, {
    review_interval_days: 14,
    next_review_on: null,
    waiting_on: '',
    checkpoint: '',
    checkpoint_on: null,
  });
});
