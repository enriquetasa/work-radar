'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRealtimeSync } = require('../sync/realtime.js');

// A logger that records every call (per level) instead of discarding it —
// same shape/pattern as test/sync-engine.test.js's spyLog.
function spyLog() {
  const calls = { debug: [], info: [], warn: [], error: [], critical: [] };
  const log = {};
  Object.keys(calls).forEach((level) => {
    log[level] = (...args) => calls[level].push(args);
  });
  return { log, calls };
}

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, critical() {} };

function makeFakeClient({ removeChannel } = {}) {
  const channels = [];
  const topics = new Map(); // topic -> still-open channel for it, if any

  function makeChannel(topic) {
    const handlers = { items: [], log_entries: [] };
    const bindings = [];
    let statusCb = null;
    let unsubscribeCalled = false;
    // 'closed' (never subscribed, or a fresh channel) -> 'active' (a
    // `.subscribe()` call landed) -> 'leaving' (torn down via
    // removeChannel, whether or not the async leave has settled yet).
    let state = 'closed';
    const ch = {
      topic,
      bindings,
      on(type, filter, cb) {
        assert.equal(type, 'postgres_changes');
        if (handlers[filter.table].length > 0) {
          // Duplicate filter for a table already bound on this
          // (reused) channel — dropped, never added, same as the real
          // client. This is what actually starves a re-subscribed
          // channel of its own event callbacks in the production bug.
          return ch;
        }
        bindings.push(filter);
        handlers[filter.table].push(cb);
        return ch;
      },
      subscribe(cb) {
        if (state !== 'closed') return ch; // no-op — see note 3 above
        state = 'active';
        statusCb = cb;
        return ch;
      },
      _emit(table, payload) {
        handlers[table].forEach((fn) => fn(payload));
      },
      _status(status, err) {
        statusCb(status, err);
      },
      _unsubscribeCalled: () => unsubscribeCalled,
      _markRemoved() {
        unsubscribeCalled = true;
        state = 'leaving';
      },
      // Real RealtimeClient.removeChannel() only calls this on an 'ok'
      // leave — a test overrides it (e.g. `ch.teardown = () => {...}`)
      // to observe or fail sync/realtime.js's own non-'ok' teardown call.
      teardown() {
        this._teardownCalled = true;
      },
    };
    channels.push(ch);
    return ch;
  }

  const client = {
    channel(topic) {
      const existing = topics.get(topic);
      if (existing) return existing;
      const ch = makeChannel(topic);
      topics.set(topic, ch);
      return ch;
    },
    async removeChannel(ch) {
      ch._markRemoved();
      // Always a real tick later, like a leave ack over the socket —
      // never synchronous, even for the default 'ok' — so a caller that
      // doesn't await this can still run `client.channel(sameTopic)`
      // before it settles and observe the still-open channel (note 1
      // above).
      const result = await Promise.resolve(removeChannel ? removeChannel(ch) : 'ok');
      // Mirrors RealtimeClient._remove(), which filters `this.channels`
      // by topic — a newer channel that reused this topic while this
      // one was still leaving must survive this older leave's
      // completion, not be de-registered along with it.
      if (topics.get(ch.topic) === ch) topics.delete(ch.topic);
      return result;
    },
    _channels: channels,
  };
  return client;
}

async function flush() {
  // fireOnChange resolves onChange through a Promise.resolve().then(...)
  // chain — give it a turn of the microtask queue before asserting.
  await new Promise((resolve) => setImmediate(resolve));
}

test('subscribe registers postgres_changes handlers for both tables', () => {
  const client = makeFakeClient();
  const onChange = () => {};
  const realtime = createRealtimeSync({ client, onChange, log: silentLog });

  realtime.subscribe('user-1');

  assert.equal(client._channels.length, 1);
  const ch = client._channels[0];
  assert.match(ch.topic, /^work-radar-sync:user-1:[0-9a-f-]{36}$/);
  assert.deepEqual(ch.bindings, [
    { event: '*', schema: 'public', table: 'items' },
    { event: '*', schema: 'public', table: 'log_entries' },
  ]);
});

test('a postgres_changes event on items triggers onChange, without reading the payload', async () => {
  const client = makeFakeClient();
  let calls = 0;
  const onChange = async () => {
    calls += 1;
  };
  const realtime = createRealtimeSync({ client, onChange, log: silentLog });
  realtime.subscribe('user-1');

  const ch = client._channels[0];
  ch._emit('items', { eventType: 'UPDATE', new: { id: 'secret-row-content' } });
  await flush();

  assert.equal(calls, 1);
});

test('a postgres_changes event on log_entries also triggers onChange', async () => {
  const client = makeFakeClient();
  let calls = 0;
  const onChange = async () => {
    calls += 1;
  };
  const realtime = createRealtimeSync({ client, onChange, log: silentLog });
  realtime.subscribe('user-1');

  const ch = client._channels[0];
  ch._emit('log_entries', { eventType: 'INSERT' });
  await flush();

  assert.equal(calls, 1);
});

test('SUBSCRIBED triggers exactly one catch-up pull', async () => {
  const client = makeFakeClient();
  let calls = 0;
  const onChange = async () => {
    calls += 1;
  };
  const realtime = createRealtimeSync({ client, onChange, log: silentLog });
  realtime.subscribe('user-1');

  const ch = client._channels[0];
  ch._status('SUBSCRIBED');
  await flush();

  assert.equal(calls, 1);
});

test('CHANNEL_ERROR, TIMED_OUT and CLOSED are logged but never trigger a pull themselves', async () => {
  const client = makeFakeClient();
  let calls = 0;
  const onChange = async () => {
    calls += 1;
  };
  const { log, calls: logCalls } = spyLog();
  const realtime = createRealtimeSync({ client, onChange, log });
  realtime.subscribe('user-1');

  const ch = client._channels[0];
  ch._status('CHANNEL_ERROR', new Error('boom'));
  ch._status('TIMED_OUT');
  ch._status('CLOSED');
  await flush();

  assert.equal(calls, 0, 'none of these statuses should call onChange on their own');
  assert.equal(logCalls.warn.length, 3, 'all three statuses are logged');
});

test('unsubscribe removes the channel and stops routing further events to onChange', async () => {
  const client = makeFakeClient();
  let calls = 0;
  const onChange = async () => {
    calls += 1;
  };
  const realtime = createRealtimeSync({ client, onChange, log: silentLog });
  realtime.subscribe('user-1');
  const ch = client._channels[0];

  realtime.unsubscribe();
  await flush();

  assert.ok(ch._unsubscribeCalled(), 'client.removeChannel must have been called');

  // A straggling event from the now-removed channel (a real socket can
  // deliver one more message before it actually closes) must not still
  // trigger a pull.
  ch._emit('items', { eventType: 'UPDATE' });
  ch._status('CLOSED');
  await flush();
  assert.equal(calls, 0);
});

// unsubscribe() sets `entry.closing` synchronously, before the async
// removeChannel() teardown kicks off, so by the time the underlying
// channel's own CLOSED status callback actually fires (simulated here
// via ch._status, standing in for what a real socket delivers once the
// server acks the close), the module must recognise this as a close it
// asked for and log debug — not the "unexpectedly" warning (found in
// review: this branch existed but was unreachable before the fix).
test('a CLOSED status from a channel this module tore down via unsubscribe() logs debug, not a warning', async () => {
  const client = makeFakeClient();
  const { log, calls: logCalls } = spyLog();
  const realtime = createRealtimeSync({ client, onChange: async () => {}, log });
  realtime.subscribe('user-1');
  const ch = client._channels[0];

  realtime.unsubscribe();
  ch._status('CLOSED');
  await flush();

  assert.equal(logCalls.debug.length, 1);
  assert.match(logCalls.debug[0][0], /unsubscribe requested/);
  assert.equal(
    logCalls.warn.length,
    0,
    'a close this module itself asked for must not also warn as unexpected'
  );
});

test('unsubscribe logs a warning when removeChannel resolves something other than ok, and tears the channel down itself', async () => {
  const client = makeFakeClient({ removeChannel: async () => 'timed out' });
  const { log, calls: logCalls } = spyLog();
  const realtime = createRealtimeSync({ client, onChange: async () => {}, log });
  realtime.subscribe('user-1');
  const ch = client._channels[0];

  realtime.unsubscribe();
  await flush();

  assert.equal(logCalls.warn.length, 1);
  const [, ctx] = logCalls.warn[0];
  assert.equal(ctx.userId, 'user-1');
  assert.equal(typeof ctx.channelId, 'string');
  assert.equal(ctx.result, 'timed out');
  assert.equal(logCalls.error.length, 0);
  assert.ok(ch._teardownCalled, 'a non-ok removeChannel result must still be torn down');
});

test('a channel.teardown() that throws after a non-ok removeChannel result is caught and logged, not thrown', async () => {
  const client = makeFakeClient({ removeChannel: async () => 'timed out' });
  const { log, calls: logCalls } = spyLog();
  const realtime = createRealtimeSync({ client, onChange: async () => {}, log });
  realtime.subscribe('user-1');
  const ch = client._channels[0];
  ch.teardown = () => {
    throw new Error('teardown boom');
  };

  assert.doesNotThrow(() => realtime.unsubscribe());
  await flush();

  assert.equal(logCalls.warn.length, 1, 'the non-ok result is still logged as a warning');
  assert.equal(logCalls.error.length, 1, 'the teardown failure is logged as its own error');
  const [, ctx] = logCalls.error[0];
  assert.equal(ctx.userId, 'user-1');
  assert.equal(typeof ctx.channelId, 'string');
  assert.match(ctx.err.message, /teardown boom/);
});

test('unsubscribe logs an error (not an unhandled rejection) when removeChannel rejects', async () => {
  const client = makeFakeClient({
    removeChannel: async () => {
      throw new Error('socket already gone');
    },
  });
  const { log, calls: logCalls } = spyLog();
  const realtime = createRealtimeSync({ client, onChange: async () => {}, log });
  realtime.subscribe('user-1');

  assert.doesNotThrow(() => realtime.unsubscribe());
  await flush();

  assert.equal(logCalls.error.length, 1);
  const [, ctx] = logCalls.error[0];
  assert.equal(ctx.userId, 'user-1');
  assert.equal(typeof ctx.channelId, 'string');
  assert.match(ctx.err.message, /socket already gone/);
  assert.equal(logCalls.warn.length, 0);
});

test('unsubscribe with nothing subscribed is a harmless no-op', async () => {
  const client = makeFakeClient();
  const realtime = createRealtimeSync({ client, onChange: () => {}, log: silentLog });

  realtime.unsubscribe();
  await flush();

  assert.equal(client._channels.length, 0);
});

test('re-subscribing without an explicit unsubscribe first tears down the old channel — no leaks', async () => {
  const client = makeFakeClient();
  let calls = 0;
  const onChange = async () => {
    calls += 1;
  };
  const realtime = createRealtimeSync({ client, onChange, log: silentLog });

  realtime.subscribe('user-1');
  const first = client._channels[0];
  realtime.subscribe('user-2'); // e.g. sign-out then sign-in as someone else
  const second = client._channels[1];
  await flush();

  assert.ok(first._unsubscribeCalled(), 'the first channel must be removed, not leaked');
  assert.equal(client._channels.length, 2);

  // Events from the stale first channel must not still reach onChange —
  // only the new, current subscription should.
  first._emit('items', { eventType: 'UPDATE' });
  await flush();
  assert.equal(calls, 0);

  second._emit('items', { eventType: 'UPDATE' });
  await flush();
  assert.equal(calls, 1);
});

test('subscribing again for the same user before the previous channel finishes leaving still delivers events', async () => {
  const client = makeFakeClient();
  let calls = 0;
  const onChange = async () => {
    calls += 1;
  };
  const realtime = createRealtimeSync({ client, onChange, log: silentLog });

  realtime.subscribe('user-1');
  realtime.subscribe('user-1'); // re-subscribe without awaiting the first's teardown

  // Whichever channel object this second subscription actually holds —
  // a fresh one, or (pre-fix) the same still-leaving one the first
  // subscription held — is always the most recently created one.
  const second = client._channels[client._channels.length - 1];
  second._emit('items', { eventType: 'UPDATE' });
  await flush();

  assert.equal(
    calls,
    1,
    'the second subscription must receive its own events even if the first channel was still open for the same topic'
  );
});

test('a rejecting onChange is caught and logged, never thrown out of the event handler', async () => {
  const client = makeFakeClient();
  const onChange = async () => {
    throw new Error('pull failed');
  };
  const { log, calls: logCalls } = spyLog();
  const realtime = createRealtimeSync({ client, onChange, log });
  realtime.subscribe('user-1');

  const ch = client._channels[0];
  assert.doesNotThrow(() => ch._emit('items', { eventType: 'UPDATE' }));
  await flush();

  assert.equal(logCalls.error.length, 1);
});

test('subscribe requires a userId', () => {
  const client = makeFakeClient();
  const realtime = createRealtimeSync({ client, onChange: () => {}, log: silentLog });
  assert.throws(() => realtime.subscribe(), /userId/);
  assert.throws(() => realtime.subscribe(''), /userId/);
});

test('createRealtimeSync requires a client and an onChange callback', () => {
  assert.throws(() => createRealtimeSync({ onChange: () => {}, log: silentLog }), /client/);
  assert.throws(() => createRealtimeSync({ client: makeFakeClient(), log: silentLog }), /onChange/);
});

test('logs carry userId and channelId context on subscribe/unsubscribe', async () => {
  const client = makeFakeClient();
  const { log, calls: logCalls } = spyLog();
  const realtime = createRealtimeSync({ client, onChange: async () => {}, log });

  realtime.subscribe('user-42');
  const [, subscribingCtx] = logCalls.info[0];
  assert.equal(subscribingCtx.userId, 'user-42');
  assert.equal(typeof subscribingCtx.channelId, 'string');
  assert.ok(subscribingCtx.channelId.length > 0);

  realtime.unsubscribe();
  await flush();
  const unsubscribingLine = logCalls.info.find((args) => args[0].startsWith('realtime: unsub'));
  assert.equal(unsubscribingLine[1].userId, 'user-42');
  assert.equal(unsubscribingLine[1].channelId, subscribingCtx.channelId);
});
