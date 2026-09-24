'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const D = require('../renderer/domain.js');
const NOW = new Date(2026, 8, 24, 10).getTime();
const create = (fields = {}) =>
  D.createItem(
    { name: 'Project', status: 'active', priority: 'medium', ...fields },
    NOW,
    () => 'project'
  );

test('existing projects get a two-week calendar cadence and migration is idempotent', () => {
  const legacy = { id: 'legacy', name: 'Legacy', reviewedAt: new Date(2026, 8, 10, 23).getTime() };
  const [item] = D.migrate([legacy], NOW);
  assert.equal(item.reviewIntervalDays, 14);
  assert.equal(item.nextReviewOn, '2026-09-24');
  assert.equal(item.waitingOn, '');
  assert.equal(item.checkpointOn, '');
  assert.deepEqual(D.migrate([item], NOW + D.DAY), [item]);
  assert.equal(D.isDueToday(item, NOW), true, 'due for the whole calendar day');
});

test('manual cadence and explicit one-off dates survive migration and creation', () => {
  const manual = create({ reviewIntervalDays: null });
  assert.equal(manual.nextReviewOn, '');
  assert.equal(D.isDueToday(manual, NOW + 100 * D.DAY), false);
  const override = create({ reviewIntervalDays: null, nextReviewOn: '2026-09-24' });
  assert.deepEqual(D.migrate([override], NOW)[0], {
    ...override,
    category: '',
    notes: '',
    archivedAt: undefined,
    deletedAt: undefined,
  });
  assert.equal(D.isDueToday(override, NOW), true);
});

test('invalid imported schedules are normalized without impossible calendar dates', () => {
  const schedule = D.normalizeSchedule({
    reviewedAt: NOW,
    reviewIntervalDays: -3,
    nextReviewOn: '2026-02-30',
    checkpointOn: 'tomorrow',
    waitingOn: {},
    checkpoint: null,
  });
  assert.deepEqual(schedule, {
    reviewIntervalDays: 14,
    nextReviewOn: '2026-10-08',
    waitingOn: '',
    checkpoint: '',
    checkpointOn: '',
  });
});

test('Today includes due reviews and checkpoints, excludes future and unscheduled waiting', () => {
  const items = [
    create({ name: 'Review', nextReviewOn: '2026-09-24' }),
    create({ name: 'Checkpoint', checkpoint: 'Budget decision', checkpointOn: '2026-09-23' }),
    create({
      name: 'Future',
      priority: 'critical',
      nextReviewOn: '2026-09-25',
      checkpointOn: '2026-09-25',
    }),
    create({ name: 'Waiting', waitingOn: 'Alex' }),
    create({ name: 'Archived', nextReviewOn: '2026-09-24', archivedAt: NOW }),
    create({ name: 'Deleted', nextReviewOn: '2026-09-24', deletedAt: NOW }),
  ];
  const state = {
    items,
    arch: [],
    ui: { view: 'today', filter: 'dormant', search: 'irrelevant', sort: 'name' },
  };
  assert.deepEqual(
    D.selectVisible(state, NOW).map((i) => i.name),
    ['Checkpoint', 'Review']
  );
  assert.deepEqual(D.attentionReasons(items[0], NOW), ['Review due today']);
  assert.deepEqual(D.attentionReasons(items[1], NOW), ['Checkpoint overdue · 2026-09-23']);
});

test('reviewing and snoozing do not hide an outstanding checkpoint', () => {
  const item = create({
    reviewIntervalDays: 7,
    nextReviewOn: '2026-09-20',
    waitingOn: 'Alex',
    checkpoint: 'Budget decision',
    checkpointOn: '2026-09-24',
  });
  const reviewed = D.reviewItem(item, NOW);
  assert.equal(reviewed.nextReviewOn, '2026-10-01');
  assert.equal(reviewed.checkpointOn, item.checkpointOn);
  assert.equal(reviewed.waitingOn, 'Alex');
  assert.deepEqual(D.attentionReasons(reviewed, NOW), ['Checkpoint today']);
  const snoozed = D.snoozeItem(item, '2026-10-02', NOW);
  assert.equal(snoozed.reviewedAt, item.reviewedAt);
  assert.equal(snoozed.checkpoint, item.checkpoint);
  assert.equal(D.isDueToday(snoozed, NOW), true);
  assert.equal(D.reviewItem(item, NOW, '2026-10-05').nextReviewOn, '2026-10-05');
  assert.equal(D.snoozeItem(item, 'invalid', NOW), item);
});

test('cadence edits recalculate dates, explicit overrides survive unrelated edits and merge', () => {
  const item = create({ reviewIntervalDays: 7, nextReviewOn: '2026-09-25' });
  const changed = D.updateItem(item, { reviewIntervalDays: 30 }, NOW + 1);
  assert.equal(changed.nextReviewOn, '2026-10-24');
  const manual = D.updateItem(changed, { reviewIntervalDays: null }, NOW + 2);
  assert.equal(manual.nextReviewOn, '');
  const override = D.updateItem(
    manual,
    { nextReviewOn: '2026-11-01', checkpointOn: '2026-10-15' },
    NOW + 3
  );
  const edited = D.updateItem(override, { notes: 'new notes' }, NOW + 4);
  assert.equal(edited.nextReviewOn, '2026-11-01');
  const merged = D.mergeItem(item, edited);
  assert.equal(merged.nextReviewOn, '2026-11-01');
  assert.equal(merged.checkpointOn, '2026-10-15');
  assert.equal(merged.reviewIntervalDays, null);
});

test('All filters/search include waiting and checkpoint context; archive remains separate', () => {
  const items = [create({ waitingOn: 'Alex', status: 'watch' }), create({ name: 'Other' })];
  const arch = [create({ name: 'Archived', archivedAt: NOW })];
  assert.equal(
    D.selectVisible(
      { items, arch, ui: { view: 'all', search: 'alex', filter: 'watch', sort: 'name' } },
      NOW
    ).length,
    1
  );
  assert.equal(
    D.selectVisible(
      { items, arch, ui: { view: 'archive', search: '', filter: 'watch', sort: 'name' } },
      NOW
    )[0].name,
    'Archived'
  );
});

test('review dates use local days across UTC boundaries and daylight-saving transitions', () => {
  const modulePath = require.resolve('../renderer/domain.js');
  const script = `const D = require(${JSON.stringify(modulePath)});
    const start = new Date(2026, 9, 31, 23, 30).getTime();
    const item = D.createItem({ reviewIntervalDays: 1 }, start, () => 'id');
    process.stdout.write(JSON.stringify({ date: D.localDate(start), next: item.nextReviewOn, due: D.isDueToday(item, new Date(2026, 10, 1, 0, 1).getTime()) }));`;
  const result = JSON.parse(
    execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: 'America/New_York' },
      encoding: 'utf8',
    })
  );
  assert.deepEqual(result, { date: '2026-10-31', next: '2026-11-01', due: true });
});

test('cadence bounds prevent invalid or unsyncable next dates', () => {
  for (const value of [0, -1, 1.5, 3651, Number.MAX_SAFE_INTEGER, Infinity, '7']) {
    assert.equal(create({ reviewIntervalDays: value }).reviewIntervalDays, 14);
  }
  assert.equal(create({ reviewIntervalDays: 3650 }).reviewIntervalDays, 3650);
});

test('PDF report includes escaped scheduling and follow-up context', () => {
  const item = create({
    reviewIntervalDays: 7,
    waitingOn: 'Alex & team',
    checkpoint: '<Decision>',
    checkpointOn: '2026-09-30',
  });
  const report = D.buildReportHTML([item], NOW);
  assert.ok(report.includes('Next review: 2026-10-01'));
  assert.ok(report.includes('Review rhythm: every 7 days'));
  assert.ok(report.includes('Waiting on: Alex &amp; team'));
  assert.ok(report.includes('Checkpoint: &lt;Decision&gt; (2026-09-30)'));
});
