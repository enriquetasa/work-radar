'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePreferences, attentionProjects, renderBriefing } = require('../briefing.js');

test('briefing preferences are opt-in and normalized', () => {
  assert.deepEqual(
    normalizePreferences({ time: 'bad', weekdays: ['mon', 'mon', 'bogus'] }, 'Europe/London'),
    {
      enabled: false,
      time: '08:00',
      timezone: 'Europe/London',
      weekdays: ['mon'],
    }
  );
});

test('attention briefing includes only due projects and sorts by priority then name', () => {
  const rows = attentionProjects(
    [
      { id: 'b', name: 'Beta', priority: 'high', nextReviewOn: '2026-09-27' },
      { id: 'a', name: 'Alpha', priority: 'critical', checkpointOn: '2026-09-26' },
      { id: 'z', name: 'Later', priority: 'critical', nextReviewOn: '2026-09-28' },
      {
        id: 'x',
        name: 'Archived',
        priority: 'critical',
        nextReviewOn: '2026-09-26',
        archivedAt: 1,
      },
    ],
    '2026-09-27'
  );
  assert.deepEqual(
    rows.map(({ item }) => item.id),
    ['a', 'b']
  );
  assert.match(rows[0].reasons[0], /overdue/);
});

test('legacy review rhythm derives a timezone calendar date', () => {
  const rows = attentionProjects(
    [
      {
        id: 'legacy',
        name: 'Legacy',
        priority: 'medium',
        reviewedAt: Date.parse('2026-03-07T23:30:00Z'),
        reviewIntervalDays: 1,
      },
    ],
    '2026-03-09',
    'America/New_York'
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0].reasons[0], /overdue/);
});

test('briefing renderer escapes project content', () => {
  const rendered = renderBriefing({
    date: '2026-09-27',
    timezone: 'UTC',
    generatedAt: 'now',
    projects: [
      { name: '<script>', priority: 'high', reasons: ['Review due today'], waitingOn: '& team' },
    ],
  });
  assert.doesNotMatch(rendered.html, /<script>/);
  assert.match(rendered.html, /&lt;script&gt;/);
  assert.match(rendered.text, /<script>/);
});
