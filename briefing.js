'use strict';

// Shared deterministic briefing model. The renderer and the server function
// use the same field names and ordering rules, while the server remains the
// authority for delivery and the recipient address.
const WEEKDAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const DEFAULT_PREFERENCES = Object.freeze({
  enabled: false,
  time: '08:00',
  timezone: null,
  weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
});

function validTimezone(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function normalizePreferences(
  input = {},
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
) {
  const source = input && typeof input === 'object' ? input : {};
  const fallbackTimezone = validTimezone(timezone) ? timezone : 'UTC';
  const chosenDays = Array.isArray(source.weekdays)
    ? source.weekdays.filter((day) => WEEKDAYS.includes(day))
    : DEFAULT_PREFERENCES.weekdays;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(source.time)
    ? source.time
    : DEFAULT_PREFERENCES.time;
  return {
    enabled: source.enabled === true,
    time,
    timezone: validTimezone(source.timezone) ? source.timezone : fallbackTimezone,
    weekdays: [...new Set(chosenDays)],
  };
}

function dateInTimezone(timestamp, timezone) {
  if (typeof timestamp === 'string') {
    const numeric = Number(timestamp);
    timestamp =
      Number.isFinite(numeric) && timestamp.trim() !== '' ? numeric : Date.parse(timestamp);
  }
  if (!Number.isFinite(timestamp)) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || undefined }).format(
      new Date(timestamp)
    );
  } catch {
    return new Date(timestamp).toISOString().slice(0, 10);
  }
}

function addCalendarDays(date, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function reviewDueDate(item, timezone) {
  if (typeof item.nextReviewOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.nextReviewOn))
    return item.nextReviewOn;
  const interval = item.reviewIntervalDays;
  if (interval === null || interval === undefined || !Number.isFinite(Number(interval))) return '';
  const baseValue = item.reviewedAt ?? item.addedAt;
  const base = dateInTimezone(baseValue, timezone);
  return addCalendarDays(base, Number(interval));
}

function attentionReasons(item, localDate, timezone) {
  const reasons = [];
  const review = reviewDueDate(item, timezone);
  const checkpoint = item && item.checkpointOn;
  if (review && review <= localDate)
    reasons.push(review < localDate ? `Review overdue · ${review}` : 'Review due today');
  if (checkpoint && checkpoint <= localDate)
    reasons.push(
      checkpoint < localDate ? `Checkpoint overdue · ${checkpoint}` : 'Checkpoint due today'
    );
  return reasons;
}

function attentionProjects(items, localDate, timezone) {
  const priority = { critical: 0, high: 1, medium: 2, low: 3 };
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && !item.archivedAt && !item.deletedAt)
    .map((item) => ({ item, reasons: attentionReasons(item, localDate, timezone) }))
    .filter(({ reasons }) => reasons.length)
    .sort((a, b) => {
      const p = (priority[a.item.priority] ?? 9) - (priority[b.item.priority] ?? 9);
      return p || String(a.item.name || '').localeCompare(String(b.item.name || ''));
    });
}

function buildBriefing(
  items,
  { localDate, timezone, generatedAt = new Date().toISOString() } = {}
) {
  const date =
    localDate ||
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone || undefined }).format(new Date());
  const projects = attentionProjects(items, date, timezone).map(({ item, reasons }) => ({
    id: item.id,
    name: String(item.name || ''),
    priority: item.priority || 'medium',
    waitingOn: item.waitingOn || '',
    reasons,
  }));
  return { date, timezone: timezone || null, generatedAt, projects };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderBriefing(briefing) {
  const title = `Work Radar briefing · ${briefing.date}`;
  const textRows = briefing.projects.length
    ? briefing.projects.map((p) => {
        const waiting = p.waitingOn ? ` · Waiting on ${p.waitingOn}` : '';
        return `- ${p.name} (${p.priority}) — ${p.reasons.join(', ')}${waiting}`;
      })
    : ['Nothing needs your attention today.'];
  const text = `${title}\n\n${textRows.join('\n')}\n\nGenerated ${briefing.generatedAt}${briefing.timezone ? ` (${briefing.timezone})` : ''}.\n\nDisable this email in Work Radar settings.`;
  const htmlRows = briefing.projects.length
    ? briefing.projects
        .map(
          (p) =>
            `<li><strong>${escapeHtml(p.name)}</strong> <span>(${escapeHtml(p.priority)})</span> — ${escapeHtml(p.reasons.join(', '))}${p.waitingOn ? ` <em>Waiting on ${escapeHtml(p.waitingOn)}</em>` : ''}</li>`
        )
        .join('')
    : '<li>Nothing needs your attention today.</li>';
  const html = `<main><h1>${escapeHtml(title)}</h1><ul>${htmlRows}</ul><p>Generated ${escapeHtml(briefing.generatedAt)}${briefing.timezone ? ` (${escapeHtml(briefing.timezone)})` : ''}.</p><p>Disable this email in Work Radar settings.</p></main>`;
  return { subject: title, text, html };
}

module.exports = {
  WEEKDAYS,
  DEFAULT_PREFERENCES,
  normalizePreferences,
  validTimezone,
  attentionReasons,
  attentionProjects,
  buildBriefing,
  escapeHtml,
  renderBriefing,
};
