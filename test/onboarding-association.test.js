'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const domain = require('../renderer/domain.js');
const authView = require('../renderer/auth-view.js');
const syncView = require('../renderer/sync-view.js');
const onboardingView = require('../renderer/onboarding-view.js');

function loadRenderer({ onboardingState, profileAssociate, profileUseSeparate } = {}) {
  const ids = [
    'welcome-overlay',
    'app',
    'welcome-local',
    'welcome-import',
    'welcome-signin',
    'welcome-back',
    'welcome-signin-form',
    'welcome-create',
    'welcome-dismiss',
    'welcome-associate',
    'welcome-keep-local',
    'welcome-start-actions',
    'welcome-final-actions',
    'welcome-association',
    'welcome-title',
    'welcome-email',
    'welcome-signin-status',
    'welcome-association-status',
    'auth-panel',
    'auth-form',
    'auth-signed-in',
    'auth-pending',
    'local-status',
    'auth-error',
    'auth-email-label',
    'account-email',
    'auth-submit',
    'auth-email',
    'account-menu',
    'briefing-open-btn',
    'account-signout',
  ];
  const elements = new Map(
    ids.map((id) => [
      id,
      {
        id,
        hidden: false,
        inert: false,
        textContent: '',
        value: '',
        placeholder: '',
        onclick: null,
        onsubmit: null,
        focus() {},
        setAttribute() {},
      },
    ])
  );
  const calls = { associate: 0, separate: 0 };
  const api = {
    onboardingGet: async () => onboardingState || { status: 'complete' },
    profileAssociate: async () => {
      calls.associate += 1;
      return profileAssociate || { ok: true };
    },
    profileUseSeparate: async () => {
      calls.separate += 1;
      return profileUseSeparate || { ok: true };
    },
    onboardingMarkSignedIn: async () => ({ ok: true }),
  };
  const window = {
    radarAPI: api,
    WorkRadarDomain: domain,
    WorkRadarAuthView: authView,
    WorkRadarSyncView: syncView,
    addEventListener() {},
  };
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { id, hidden: false, textContent: '', focus() {} });
      return elements.get(id);
    },
    addEventListener() {},
  };
  const context = {
    window,
    document,
    console,
    localStorage: { getItem: () => null, setItem() {} },
    alert() {},
    setInterval() {},
    setTimeout,
    clearTimeout,
    Date,
    URL,
    WorkRadarOnboardingView: onboardingView,
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const beforeBoot = source.slice(0, source.indexOf('// Boot'));
  vm.runInNewContext(`${beforeBoot}\nthis.__Onboarding = Onboarding; this.__Auth = Auth;`, context);
  return { onboarding: context.__Onboarding, auth: context.__Auth, elements, calls };
}

test('association controls remain clickable when auth reveals them after onboarding returns early', async () => {
  const fixture = loadRenderer();
  fixture.auth.status = { configured: true, signedIn: true, profileRequired: false };
  await fixture.onboarding.init();

  fixture.auth.status.profileRequired = true;
  fixture.onboarding.requireAssociation();
  assert.equal(fixture.elements.get('welcome-association').hidden, false);
  await fixture.elements.get('welcome-associate').onclick();
  await fixture.elements.get('welcome-keep-local').onclick();
  assert.equal(fixture.calls.associate, 1);
  assert.equal(fixture.calls.separate, 1);
});

test('restored sessions show association controls during initial onboarding', async () => {
  const fixture = loadRenderer();
  fixture.auth.status = { configured: true, signedIn: true, profileRequired: true };
  await fixture.onboarding.init();
  assert.equal(fixture.elements.get('welcome-association').hidden, false);
  await fixture.elements.get('welcome-keep-local').onclick();
  assert.equal(fixture.calls.separate, 1);
});

test('association API failures are shown in the association status', async () => {
  const fixture = loadRenderer({ profileAssociate: { ok: false, error: 'PROFILE LOCKED' } });
  fixture.auth.status = { configured: true, signedIn: true, profileRequired: true };
  await fixture.onboarding.init();
  await fixture.elements.get('welcome-associate').onclick();
  assert.equal(fixture.elements.get('welcome-association-status').textContent, 'PROFILE LOCKED');
});
