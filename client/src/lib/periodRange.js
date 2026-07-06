// Shared period definitions + window resolver for the dashboards.
import {
  startOfDay, endOfDay, subDays, startOfMonth, endOfMonth, subMonths, startOfYear, endOfYear, subYears,
} from 'date-fns';

export const PERIODS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: 'Last 7' },
  { value: 'this_month', label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'last60', label: 'Last 60' },
  { value: 'custom', label: 'Custom' },
];

// Resolve a period value (+ optional custom {from,to}) into a { start, end } window.
export function resolvePeriod(value, custom) {
  const now = new Date();
  switch (value) {
    case 'today':
      return { start: startOfDay(now), end: endOfDay(now) };
    case 'yesterday': {
      const y = subDays(now, 1);
      return { start: startOfDay(y), end: endOfDay(y) };
    }
    case 'last7':
      return { start: startOfDay(subDays(now, 6)), end: endOfDay(now) };
    case 'this_month':
      return { start: startOfMonth(now), end: endOfDay(now) };
    case 'last_month': {
      const lm = subMonths(now, 1);
      return { start: startOfMonth(lm), end: endOfMonth(lm) };
    }
    case 'last60':
      return { start: startOfDay(subDays(now, 59)), end: endOfDay(now) };
    case 'last_year': {
      const ly = subYears(now, 1);
      return { start: startOfYear(ly), end: endOfYear(ly) };
    }
    case 'custom':
      return {
        start: custom?.from ? startOfDay(new Date(custom.from)) : startOfDay(subDays(now, 29)),
        end: custom?.to ? endOfDay(new Date(custom.to)) : endOfDay(now),
      };
    default:
      return { start: startOfMonth(now), end: endOfDay(now) };
  }
}

// Prior window of equal length immediately before the given window (for trend %).
export function priorWindow({ start, end }) {
  const len = end.getTime() - start.getTime();
  return { start: new Date(start.getTime() - len), end: new Date(start.getTime()) };
}

export const PERIOD_LABELS = PERIODS.reduce((m, p) => { m[p.value] = p.label; return m; }, {});

// The standardized preset set used by every Finance + Report date filter.
export const STANDARD_PERIODS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_month', label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'last_year', label: 'Last Year' },
  { value: 'custom', label: 'Custom' },
];