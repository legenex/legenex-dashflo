import { describe, it, expect } from 'vitest';
import { isWithinSchedule } from '@/lib/distribution/schedule.js';
import { exhaustedCap } from '@/lib/distribution/engine.js';
import { parseSchedule } from '@/lib/routeSchedule';
import { parseCaps } from '@/lib/routeCaps';
import { parseFilters } from '@/lib/routeFilters';

// These pin the editors' persisted JSON shape against the REAL runtime
// functions that read it, so a UI change can never drift from what the
// engine actually enforces.

describe('RouteScheduleEditor <-> schedule.js contract', () => {
  it('no day enabled serializes to empty (always on), matching isWithinSchedule default', () => {
    expect(parseSchedule('')).toBeNull();
    expect(isWithinSchedule(Date.now(), null, 'UTC')).toBe(true);
  });

  it('a Monday-only 09:00-17:00 window is honoured by the real evaluator', () => {
    const schedule = { timezone: 'UTC', windows: [{ days: [1], start: '09:00', end: '17:00' }] };
    const mondayNoon = Date.UTC(2026, 7, 24, 12, 0, 0); // 2026-08-24 is a Monday
    const mondayLate = Date.UTC(2026, 7, 24, 20, 0, 0);
    const tuesdayNoon = Date.UTC(2026, 7, 25, 12, 0, 0);
    expect(isWithinSchedule(mondayNoon, schedule)).toBe(true);
    expect(isWithinSchedule(mondayLate, schedule)).toBe(false);
    expect(isWithinSchedule(tuesdayNoon, schedule)).toBe(false);
  });

  it('parseSchedule tolerates a plain object as well as a JSON string', () => {
    const obj = { timezone: 'UTC', windows: [] };
    expect(parseSchedule(obj)).toEqual(obj);
    expect(parseSchedule(JSON.stringify(obj))).toEqual(obj);
    expect(parseSchedule('not json')).toBeNull();
  });
});

describe('RouteCapsEditor <-> engine.js exhaustedCap contract', () => {
  it('an unset cap never exhausts', () => {
    expect(parseCaps('')).toEqual({});
    expect(exhaustedCap({})).toBeNull();
  });

  it('a daily limit of 5 with a count of 5 already used is exhausted on the next lead', () => {
    const caps = parseCaps(JSON.stringify({ daily: { limit: 5 } }));
    // The editor never writes `count`; the engine injects it at evaluation
    // time from CapCounter. Simulate that here to prove the shape matches.
    const withCount = { daily: { limit: caps.daily.limit, count: 5 } };
    expect(exhaustedCap(withCount)).toBeTruthy();
    const belowLimit = { daily: { limit: caps.daily.limit, count: 2 } };
    expect(exhaustedCap(belowLimit)).toBeNull();
  });

  it('parseCaps round-trips through the editor serialization', () => {
    const json = JSON.stringify({ total: { limit: 100 }, daily: { limit: 10 } });
    expect(parseCaps(json)).toEqual({ total: { limit: 100 }, daily: { limit: 10 } });
  });
});

describe('RouteFiltersPanel filters parsing', () => {
  it('parses a JSON string or object, and defaults to an empty object', () => {
    expect(parseFilters('')).toEqual({});
    expect(parseFilters('not json')).toEqual({});
    expect(parseFilters(JSON.stringify({ states: ['CA', 'NV'] }))).toEqual({ states: ['CA', 'NV'] });
  });
});
