'use strict';

/**
 * Durable first-launch state. This deliberately lives beside the app settings,
 * rather than inside the exported project envelope. A backup can therefore be
 * restored without silently marking a new installation as onboarded.
 */
const fs = require('fs').promises;
const path = require('path');

const CURRENT_VERSION = 1;
const DEFAULT_STATE = Object.freeze({
  version: CURRENT_VERSION,
  status: 'new',
  step: 'welcome',
  mode: null,
  completedAt: null,
});

function createOnboardingStore({ filePath, read = readFile, write = writeFile } = {}) {
  if (!filePath) throw new TypeError('filePath is required');

  async function get() {
    const raw = await read(filePath);
    return normalize(raw);
  }

  async function update(patch = {}) {
    const current = await get();
    const next = normalize({ ...current, ...patch });
    await write(filePath, next);
    return next;
  }

  async function chooseLocal() {
    return update({ status: 'complete', step: 'done', mode: 'local', completedAt: Date.now() });
  }

  async function markSignedIn() {
    return update({ status: 'complete', step: 'done', mode: 'account', completedAt: Date.now() });
  }

  return { get, update, chooseLocal, markSignedIn };
}

function normalize(value) {
  if (!value || typeof value !== 'object') return { ...DEFAULT_STATE };
  const status = ['new', 'in_progress', 'complete'].includes(value.status)
    ? value.status
    : DEFAULT_STATE.status;
  const step = typeof value.step === 'string' && value.step ? value.step : DEFAULT_STATE.step;
  const mode = value.mode === 'local' || value.mode === 'account' ? value.mode : null;
  return {
    version: CURRENT_VERSION,
    status,
    step,
    mode,
    completedAt: Number.isFinite(value.completedAt) ? value.completedAt : null,
  };
}

async function readFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(temp, filePath);
}

module.exports = { CURRENT_VERSION, DEFAULT_STATE, createOnboardingStore, normalize };
