'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fsp = require('node:fs').promises;
const { readJsonFile, writeJsonFileAtomic } = require('./atomic-json-file');
const { assertScope } = require('./attachment-validation');

const QUEUE_SCHEMA = 1;

function emptyQueueState() {
  return { schema: QUEUE_SCHEMA, accounts: {} };
}

function normalizeState(raw) {
  if (!raw || raw.schema !== QUEUE_SCHEMA || !raw.accounts || typeof raw.accounts !== 'object') {
    return emptyQueueState();
  }
  const accounts = {};
  for (const [scope, value] of Object.entries(raw.accounts)) {
    if (!value || !Array.isArray(value.pending)) continue;
    try {
      assertScope(scope);
      accounts[scope] = {
        pending: value.pending.filter((job) => job && typeof job.id === 'string'),
      };
    } catch {
      continue;
    }
  }
  return { schema: QUEUE_SCHEMA, accounts };
}

function createAttachmentQueue(options = {}) {
  const {
    filePath,
    now = Date.now,
    randomUUID = crypto.randomUUID,
    readFile = readJsonFile,
    writeFile = writeJsonFileAtomic,
    retryBaseMs = 2_000,
    retryMaxMs = 5 * 60_000,
  } = options;
  if (!filePath) throw new Error('createAttachmentQueue requires filePath');
  let queue = Promise.resolve();

  function transaction(mutator) {
    const run = queue.then(async () => {
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      const state = normalizeState((await readFile(filePath)) || emptyQueueState());
      const result = await mutator(state);
      await writeFile(filePath, state);
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  function account(state, scope) {
    assertScope(scope);
    return (state.accounts[scope] ||= { pending: [] });
  }

  async function enqueue(scope, job) {
    return transaction((state) => {
      const target = account(state, scope);
      const existing = target.pending.find((entry) => entry.id === job.id && entry.op === job.op);
      if (existing) {
        Object.assign(existing, job, { id: existing.id, op: existing.op });
        return existing;
      }
      const entry = {
        id: String(job.id),
        op: job.op || 'upload',
        queuedAt: job.queuedAt ?? now(),
        attempts: Number.isSafeInteger(job.attempts) ? job.attempts : 0,
        nextAttemptAt: job.nextAttemptAt ?? now(),
        lastError: job.lastError || null,
        token: job.token || randomUUID(),
      };
      target.pending.push(entry);
      return entry;
    });
  }

  async function list(scope, { dueOnly = false, at = now() } = {}) {
    return transaction((state) => {
      const jobs = [...account(state, scope).pending];
      return dueOnly ? jobs.filter((job) => (job.nextAttemptAt ?? 0) <= at) : jobs;
    }).then((jobs) => jobs.map((job) => ({ ...job })));
  }

  async function acknowledge(scope, id, op) {
    return transaction((state) => {
      const target = account(state, scope);
      const before = target.pending.length;
      target.pending = target.pending.filter((job) => !(job.id === id && (!op || job.op === op)));
      return before !== target.pending.length;
    });
  }

  async function fail(scope, id, op, error, { at = now() } = {}) {
    return transaction((state) => {
      const job = account(state, scope).pending.find((entry) => entry.id === id && entry.op === op);
      if (!job) return null;
      job.attempts += 1;
      const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, job.attempts - 1));
      job.nextAttemptAt = at + delay;
      job.lastError = String(error?.message || error || 'attachment transfer failed').slice(0, 500);
      return { ...job };
    });
  }

  async function clear(scope) {
    return transaction((state) => {
      const target = account(state, scope);
      const count = target.pending.length;
      target.pending = [];
      return count;
    });
  }

  return { enqueue, list, acknowledge, fail, clear, emptyQueueState, normalizeState };
}

module.exports = { QUEUE_SCHEMA, emptyQueueState, normalizeState, createAttachmentQueue };
