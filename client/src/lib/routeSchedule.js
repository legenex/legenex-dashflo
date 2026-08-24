// Pure helpers for RouteMember.schedule, the exact shape
// client/src/lib/distribution/schedule.js's isWithinSchedule reads:
//   { timezone: 'America/New_York', windows: [{ days:[0..6], start:'HH:MM', end:'HH:MM' }] }
// Split out from RouteScheduleEditor.jsx so this can be unit tested without a
// DOM environment (this repo has none - see vitest.config.js, environment: 'node').

export const SCHEDULE_DAYS = [
  { idx: 1, label: 'Monday' },
  { idx: 2, label: 'Tuesday' },
  { idx: 3, label: 'Wednesday' },
  { idx: 4, label: 'Thursday' },
  { idx: 5, label: 'Friday' },
  { idx: 6, label: 'Saturday' },
  { idx: 0, label: 'Sunday' },
];

export const DEFAULT_SCHEDULE_ROW = { enabled: false, start: '00:00', end: '23:59' };

export function parseSchedule(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function scheduleToRows(schedule) {
  const rows = Object.fromEntries(SCHEDULE_DAYS.map((d) => [d.idx, { ...DEFAULT_SCHEDULE_ROW }]));
  const windows = Array.isArray(schedule?.windows) ? schedule.windows : [];
  for (const w of windows) {
    const days = Array.isArray(w.days) ? w.days : [];
    for (const d of days) {
      if (rows[d]) rows[d] = { enabled: true, start: w.start || '00:00', end: w.end || '23:59' };
    }
  }
  return rows;
}

// Serializes day-rows back to the schedule.js contract. Returns '' (always
// on) when no day is enabled, matching isWithinSchedule's own no-restriction
// default rather than persisting a schedule object that means the same thing.
export function rowsToScheduleJson(rows, timezone) {
  const enabledDays = SCHEDULE_DAYS.filter((d) => rows[d.idx].enabled);
  if (enabledDays.length === 0) return '';
  const windows = enabledDays.map((d) => ({ days: [d.idx], start: rows[d.idx].start, end: rows[d.idx].end }));
  return JSON.stringify({ timezone, windows });
}
