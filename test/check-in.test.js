'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const D = require('../renderer/domain.js');

function fixture(save = async () => ({ ok: true })) {
  const context = {
    window: { WorkRadarDomain: D },
    document: {},
    console,
    Date,
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  vm.runInNewContext(
    source.slice(0, source.indexOf('// Boot')) +
      `\nrender = () => {}; renderCheckInNotice = () => {};
      this.fixture = { Store, CheckIn, detailDraft, Persist,
        notice: () => checkInNotice,
        resetProfile: () => { detailDrafts.clear(); saveGeneration++; checkInNotice = null; }
      };`,
    context
  );
  const f = context.fixture;
  f.Persist.save = save;
  f.Store.items = [
    D.createItem(
      {
        name: 'Project',
        priority: 'medium',
        status: 'active',
        nextReviewOn: D.localDate(),
        reviewIntervalDays: 14,
      },
      Date.now() - D.DAY,
      () => 'project'
    ),
  ];
  return f;
}

test('complete review persists the note and review together in one save', async () => {
  const payloads = [];
  const f = fixture(async (payload) => {
    payloads.push(payload);
    return { ok: true };
  });
  f.detailDraft('project').note = 'Spoke with the team';
  await f.CheckIn.review('project', '2030-10-10');
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].historyAction, 'review');
  assert.equal(payloads[0].items[0].nextReviewOn, '2030-10-10');
  assert.equal(payloads[0].items[0].log[0].text, 'Spoke with the team');
  assert.equal(f.detailDraft('project').note, '');
  assert.match(f.notice().message, /Reviewed/);
});

test('failed review restores the project and keeps its draft and chosen date', async () => {
  const f = fixture(async () => ({ ok: false }));
  const before = f.Store.items[0];
  Object.assign(f.detailDraft('project'), {
    note: 'Do not lose this',
    reviewChoice: 'custom',
    reviewDate: '2030-10-10',
  });
  await f.CheckIn.review('project', '2030-10-10');
  assert.equal(f.Store.items[0], before);
  assert.equal(f.detailDraft('project').note, 'Do not lose this');
  assert.equal(f.detailDraft('project').reviewDate, '2030-10-10');
  assert.equal(f.detailDraft('project').pending, false);
  assert.match(f.notice().message, /Could not save/);
});

test('a pending save prevents duplicate submissions and keeps any newer draft', async () => {
  let resolve;
  let calls = 0;
  const f = fixture(() => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  f.detailDraft('project').note = 'First update';
  const saving = f.CheckIn.update('project');
  await Promise.resolve();
  await f.CheckIn.update('project');
  assert.equal(calls, 1);
  f.detailDraft('project').note = 'Newer draft';
  resolve({ ok: true });
  await saving;
  assert.equal(f.Store.items[0].log.length, 1);
  assert.equal(f.detailDraft('project').note, 'Newer draft');
});

test('saving only an update leaves the review due and preserves the next-review choice', async () => {
  const f = fixture();
  const before = f.Store.items[0];
  Object.assign(f.detailDraft('project'), { note: 'Progress', reviewChoice: '3' });
  await f.CheckIn.update('project');
  assert.equal(f.Store.items[0].nextReviewOn, before.nextReviewOn);
  assert.equal(f.Store.items[0].reviewedAt, before.reviewedAt);
  assert.equal(f.detailDraft('project').reviewChoice, '3');
  assert.equal(D.isDueToday(f.Store.items[0]), true);
});

test('snoozing preserves the draft and reports outstanding checkpoints', async () => {
  const f = fixture();
  f.Store.items[0].checkpoint = 'Approval';
  f.Store.items[0].checkpointOn = D.localDate();
  const reviewedAt = f.Store.items[0].reviewedAt;
  f.detailDraft('project').note = 'Unsent';
  await f.CheckIn.snooze('project', '2030-10-10');
  assert.equal(f.detailDraft('project').note, 'Unsent');
  assert.equal(f.Store.items[0].reviewedAt, reviewedAt);
  assert.equal(D.isDueToday(f.Store.items[0]), true);
  assert.match(f.notice().message, /Still needs attention: Checkpoint today/);
});

test('archive Undo restores the original review date and review timestamp', async () => {
  const f = fixture();
  const before = f.Store.items[0];
  await f.CheckIn.archive('project');
  assert.equal(f.Store.items.length, 0);
  assert.equal(f.Store.arch.length, 1);
  await f.notice().undo();
  assert.equal(f.Store.arch.length, 0);
  assert.equal(f.Store.items[0].nextReviewOn, before.nextReviewOn);
  assert.equal(f.Store.items[0].reviewedAt, before.reviewedAt);
});

test('a save completing after a profile change cannot show stale feedback', async () => {
  let resolve;
  const f = fixture(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  f.detailDraft('project').note = 'Old account';
  const saving = f.CheckIn.update('project');
  await Promise.resolve();
  f.resetProfile();
  resolve({ ok: true });
  await saving;
  assert.equal(f.notice(), null);
  assert.equal(f.detailDraft('project').note, '');
});
