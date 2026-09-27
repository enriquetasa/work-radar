export type BriefingItem = Record<string, unknown>;

export type BriefingProject = {
  id: string;
  name: string;
  priority: string;
  waitingOn: string;
  reasons: string[];
};

export type Briefing = {
  date: string;
  timezone: string;
  generatedAt: string;
  projects: BriefingProject[];
};

const PRIORITY: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function validTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function localDate(timestamp: unknown, timezone: string): string {
  if (typeof timestamp !== 'string' && typeof timestamp !== 'number') return '';
  const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp);
  if (Number.isNaN(date.getTime()) || !validTimezone(timezone)) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date);
}

export function asTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

export function addCalendarDays(date: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(days)) return '';
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function reviewDueDate(item: BriefingItem, timezone: string): string {
  const explicit = item.nextReviewOn;
  if (typeof explicit === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  const rawInterval = item.reviewIntervalDays;
  if (rawInterval === null || rawInterval === undefined || rawInterval === '') return '';
  const interval = Number(rawInterval);
  if (!Number.isFinite(interval)) return '';
  const base = localDate(asTimestamp(item.reviewedAt ?? item.addedAt), timezone);
  return addCalendarDays(base, interval);
}

export function attentionReasons(item: BriefingItem, date: string, timezone: string): string[] {
  const reasons: string[] = [];
  const review = reviewDueDate(item, timezone);
  const checkpoint = typeof item.checkpointOn === 'string' ? item.checkpointOn : '';
  if (review && review <= date)
    reasons.push(review < date ? `Review overdue · ${review}` : 'Review due today');
  if (checkpoint && /^\d{4}-\d{2}-\d{2}$/.test(checkpoint) && checkpoint <= date) {
    reasons.push(checkpoint < date ? `Checkpoint overdue · ${checkpoint}` : 'Checkpoint due today');
  }
  return reasons;
}

export function attentionProjects(items: BriefingItem[], date: string, timezone: string) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && !item.archivedAt && !item.deletedAt)
    .map((item) => ({ item, reasons: attentionReasons(item, date, timezone) }))
    .filter(({ reasons }) => reasons.length)
    .sort((a, b) => {
      const priority =
        (PRIORITY[String(a.item.priority)] ?? 9) - (PRIORITY[String(b.item.priority)] ?? 9);
      return priority || String(a.item.name || '').localeCompare(String(b.item.name || ''));
    });
}

export function buildBriefing(
  items: BriefingItem[],
  options: { localDate?: string; timezone: string; generatedAt?: string }
): Briefing {
  const timezone = validTimezone(options.timezone) ? options.timezone : 'UTC';
  const date =
    options.localDate && /^\d{4}-\d{2}-\d{2}$/.test(options.localDate)
      ? options.localDate
      : new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  const projects = attentionProjects(items, date, timezone).map(({ item, reasons }) => ({
    id: String(item.id || ''),
    name: String(item.name || ''),
    priority: String(item.priority || 'medium'),
    waitingOn: String(item.waitingOn || ''),
    reasons,
  }));
  return { date, timezone, generatedAt: options.generatedAt || new Date().toISOString(), projects };
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderBriefing(briefing: Briefing) {
  const title = `Work Radar briefing · ${briefing.date}`;
  const textRows = briefing.projects.length
    ? briefing.projects.map((project) => {
        const waiting = project.waitingOn ? ` · Waiting on ${project.waitingOn}` : '';
        return `- ${project.name} (${project.priority}) — ${project.reasons.join(', ')}${waiting}`;
      })
    : ['Nothing needs your attention today.'];
  const text = `${title}\n\n${textRows.join('\n')}\n\nGenerated ${briefing.generatedAt} (${briefing.timezone}).\n\nDisable this email in Work Radar settings.`;
  const htmlRows = briefing.projects.length
    ? briefing.projects
        .map(
          (project) =>
            `<li><strong>${escapeHtml(project.name)}</strong> <span>(${escapeHtml(project.priority)})</span> — ${escapeHtml(project.reasons.join(', '))}${project.waitingOn ? ` <em>Waiting on ${escapeHtml(project.waitingOn)}</em>` : ''}</li>`
        )
        .join('')
    : '<li>Nothing needs your attention today.</li>';
  return {
    subject: title,
    text,
    html: `<main><h1>${escapeHtml(title)}</h1><ul>${htmlRows}</ul><p>Generated ${escapeHtml(briefing.generatedAt)} (${escapeHtml(briefing.timezone)}).</p><p>Disable this email in Work Radar settings.</p></main>`,
  };
}
