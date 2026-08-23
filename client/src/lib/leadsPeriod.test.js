import { describe, it, expect } from 'vitest';
import { defaultLeadsPeriod, LEADS_PERIODS, resolvePeriod } from './periodRange.js';

// The leads period default regressed three times. Each time the initial state
// was correct and something downstream knocked it back to 'custom', so pin the
// resolver itself rather than the component.
//
// This is the exact shape of the bug that shipped: clearing the custom range by
// passing two empty strings must NOT be read as "the user chose a custom range".

function resolvePeriodState(view = 'all') {
  const initial = defaultLeadsPeriod(view);
  let period = initial;
  let custom = { from: '', to: '' };

  return {
    get period() { return period; },
    get custom() { return custom; },
    setPeriod(p) {
      period = p;
      if (p !== 'custom') custom = { from: '', to: '' };
    },
    setCustomPeriod(c) {
      const from = c?.from || '';
      const to = c?.to || '';
      custom = { from, to };
      if (from || to) period = 'custom';
    },
    resetForView(nextView = view) {
      period = defaultLeadsPeriod(nextView);
      custom = { from: '', to: '' };
    },
  };
}

describe('leads period default', () => {
  it('opens All Leads on the complete inventory', () => {
    expect(resolvePeriodState('all').period).toBe('all');
    expect(resolvePeriod('all')).toEqual({ start: null, end: null });
    expect(LEADS_PERIODS[0]).toEqual({ value: 'all', label: 'All Time' });
  });

  it('keeps status-specific views on This Month', () => {
    expect(resolvePeriodState('sold').period).toBe('this_month');
  });

  it('clearing the custom range does not select Custom', () => {
    // The regression: setCustomPeriod({from:'',to:''}) used to force 'custom'.
    const s = resolvePeriodState('sold');
    s.setCustomPeriod({ from: '', to: '' });
    expect(s.period).toBe('this_month');
  });

  it('supplying dates does select Custom', () => {
    const s = resolvePeriodState();
    s.setCustomPeriod({ from: '2026-07-01', to: '2026-07-15' });
    expect(s.period).toBe('custom');
    expect(s.custom).toEqual({ from: '2026-07-01', to: '2026-07-15' });
  });

  it('switching to a named period clears any custom dates', () => {
    const s = resolvePeriodState();
    s.setCustomPeriod({ from: '2026-07-01', to: '2026-07-15' });
    s.setPeriod('last_month');
    expect(s.period).toBe('last_month');
    expect(s.custom).toEqual({ from: '', to: '' });
  });

  it('changing to All Leads resets to All Time even from a custom range', () => {
    const s = resolvePeriodState();
    s.setCustomPeriod({ from: '2026-07-01', to: '2026-07-15' });
    s.resetForView('all');
    expect(s.period).toBe('all');
    expect(s.custom).toEqual({ from: '', to: '' });
  });

  it('a partial custom range still counts as custom', () => {
    const s = resolvePeriodState();
    s.setCustomPeriod({ from: '2026-07-01', to: '' });
    expect(s.period).toBe('custom');
  });
});
