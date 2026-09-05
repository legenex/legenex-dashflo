import { describe, it, expect } from 'vitest';
import { operationalMetrics, statusDonut, unsoldReasonBreakdown } from './distributionMetrics.js';
import { LEGACY_FINAL_STATUS } from './leadStatus.js';

const win = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-01-31T23:59:59Z') };

function lead(overrides) {
  return { created_date: '2026-01-15T00:00:00Z', ...overrides };
}

describe('operationalMetrics: seven-value vocabulary (forge-pack/CONTRACT.md D1)', () => {
  it('counts a legacy Error lead as a stuck/queued lead via processing_state, not as its own bucket', () => {
    const leads = [
      lead({ final_status: 'Sold', lead_status: 'sold' }),
      lead({ final_status: LEGACY_FINAL_STATUS.ERROR, processing_state: 'failed' }),
      lead({ final_status: 'Queued', lead_status: 'queued' }),
    ];
    const m = operationalMetrics(leads, [], win);
    expect(m.sold).toBe(1);
    // Both the legacy Error row and the Queued row resolve to `queued`.
    expect(m.queued).toBe(2);
    // Only the row whose processing_state is genuinely failed counts as stuck.
    expect(m.errors).toBe(1);
  });

  it('rejections is read straight from the canonical rejected status, including a collapsed Duplicate', () => {
    const leads = [
      lead({ final_status: 'Rejected', lead_status: 'rejected' }),
      lead({ final_status: LEGACY_FINAL_STATUS.DUPLICATE }),
    ];
    const m = operationalMetrics(leads, [], win);
    expect(m.rejections).toBe(2);
  });

  it('statusDonut never labels a slice Duplicate, Fake, Processing or Error', () => {
    const leads = [
      lead({ final_status: LEGACY_FINAL_STATUS.DUPLICATE }),
      lead({ final_status: LEGACY_FINAL_STATUS.ERROR, processing_state: 'failed' }),
    ];
    const m = operationalMetrics(leads, [], win);
    const donut = statusDonut(m);
    const names = donut.map((d) => d.name);
    for (const retired of ['Duplicate', 'Fake', 'Processing', 'Error']) {
      expect(names).not.toContain(retired);
    }
  });
});

describe('unsoldReasonBreakdown: the Distribution report dimension for the unsold status', () => {
  it('only counts leads whose canonical status is unsold', () => {
    const leads = [
      lead({ lead_status: 'unsold', buyer_feedback: 'Price too high' }),
      lead({ lead_status: 'unsold', buyer_feedback: 'Price too high' }),
      lead({ lead_status: 'sold' }),
      lead({ lead_status: 'disqualified' }),
    ];
    const { rows, total } = unsoldReasonBreakdown(leads);
    expect(total).toBe(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'Price too high', count: 2, pct: 100 });
  });

  it('prefers buyer_feedback, then queue_reason, then status_reason, then a default reason', () => {
    const leads = [
      lead({ lead_status: 'unsold', buyer_feedback: 'Buyer said no' }),
      lead({ lead_status: 'unsold', queue_reason: 'No buyer configured' }),
      lead({ lead_status: 'unsold', status_reason: 'ROUTING_EXHAUSTED' }),
      lead({ lead_status: 'unsold' }),
    ];
    const { rows } = unsoldReasonBreakdown(leads);
    const reasons = rows.map((r) => r.reason).sort();
    expect(reasons).toEqual(['Buyer said no', 'No buyer accepted', 'No buyer configured', 'ROUTING_EXHAUSTED'].sort());
  });

  it('is empty (not throwing) when there are no unsold leads', () => {
    const { rows, total } = unsoldReasonBreakdown([lead({ lead_status: 'sold' })]);
    expect(rows).toEqual([]);
    expect(total).toBe(0);
  });
});
