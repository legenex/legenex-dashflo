import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LEAD_STATUS } from '@/lib/leadStatus';
import OverviewRejectionReasons from './OverviewRejectionReasons.jsx';

// forge-pack/CONTRACT.md D1 / WORK-UNITS.yaml W3-UI-STATUS: the single "Top
// Rejection Reasons" card (queued/disqualified/error leads, mixing a transit
// state and a business disqualification in with real rejections) is split
// into two real D1 statuses. This proves both halves of the split render the
// correct, distinct leads and never bleed into each other.
const leads = [
  { lead_status: 'rejected', queue_reason: 'Invalid phone number' },
  { lead_status: 'rejected', queue_reason: 'Invalid phone number' },
  { lead_status: 'rejected', status_reason: 'REJECTED_DUPLICATE' },
  { lead_status: 'unsold', buyer_feedback: 'Buyer at cap' },
  { lead_status: 'unsold', buyer_feedback: 'Buyer at cap' },
  { lead_status: 'disqualified', queue_reason: 'Wrong state' },
  { lead_status: 'sold' },
];

describe('OverviewRejectionReasons: Top Rejection Reasons vs Top Unsold Reasons', () => {
  it('the rejected card only counts rejected leads, never unsold or disqualified ones', () => {
    const html = renderToStaticMarkup(<OverviewRejectionReasons leads={leads} status={LEAD_STATUS.REJECTED} />);
    expect(html).toContain('Invalid phone number');
    expect(html).toContain('3 rejected leads total');
    expect(html).not.toContain('Buyer at cap');
    expect(html).not.toContain('Wrong state');
  });

  it('the unsold card only counts unsold leads and prefers buyer_feedback as the reason', () => {
    const html = renderToStaticMarkup(<OverviewRejectionReasons leads={leads} status={LEAD_STATUS.UNSOLD} />);
    expect(html).toContain('Buyer at cap');
    expect(html).toContain('2 unsold leads total');
    expect(html).not.toContain('Invalid phone number');
  });

  it('renders the correct empty state per status rather than a shared generic message', () => {
    const rejectedEmpty = renderToStaticMarkup(<OverviewRejectionReasons leads={[]} status={LEAD_STATUS.REJECTED} />);
    const unsoldEmpty = renderToStaticMarkup(<OverviewRejectionReasons leads={[]} status={LEAD_STATUS.UNSOLD} />);
    expect(rejectedEmpty).toContain('No rejected leads in this period');
    expect(unsoldEmpty).toContain('No unsold leads in this period');
  });

  it('defaults to the rejected status when none is given', () => {
    const html = renderToStaticMarkup(<OverviewRejectionReasons leads={leads} />);
    expect(html).toContain('3 rejected leads total');
  });
});
