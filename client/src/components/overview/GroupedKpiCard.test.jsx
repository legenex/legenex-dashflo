import { describe, it, expect, vi, afterAll } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DollarSign } from 'lucide-react';

// CONTRACT.md section 3: a metric with no underlying data renders "no data
// for this period", never $0.00. Revenue, Profit and CPL on the Overview
// dashboard hit this exact shape when the reporting window has zero leads:
// the underlying finance-truth aggregation still produces a headline of 0,
// a gap of 0 and a delta of 0%, which look exactly like a real, reconciled,
// unchanged business result rather than "there is nothing to report".
//
// useCountUp only reaches its target inside a requestAnimationFrame loop
// driven by a useEffect, which react-dom/server never runs, so it is mocked
// to return its target immediately. Without that every assertion below would
// see the pre-animation value of 0 regardless of what was actually passed in,
// which would make this test pass for the wrong reason.
vi.mock('@/hooks/useCountUp', () => ({ default: (target) => target }));

// Rendered with react-dom/server the same way the other dashboard page tests
// in this repo are (see DistributionDashboard.test.jsx), since GroupedKpiCard
// pulls in framer-motion and that is the established pattern for rendering
// motion components under vitest's node environment.
globalThis.window = { self: {}, top: {}, addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window.self = globalThis.window;
globalThis.window.top = globalThis.window;
globalThis.SVGElement = class SVGElement {};

const { default: GroupedKpiCard } = await import('./GroupedKpiCard.jsx');

afterAll(() => {
  delete globalThis.window;
  delete globalThis.SVGElement;
});

function render(props) {
  return renderToStaticMarkup(
    <GroupedKpiCard
      label="Revenue"
      headline={0}
      subLabel="Verified"
      sub={0}
      gap={0}
      icon={DollarSign}
      delta={0}
      note="Awaiting booked events"
      {...props}
    />,
  );
}

describe('GroupedKpiCard honest empty state', () => {
  it('renders the real dollar figure and gap chip for a normal, populated period', () => {
    const html = render({ headline: 12345, sub: 9000, gap: 3345, delta: 4.2 });
    expect(html).toContain('$12,345');
    expect(html).toContain('gap $3,345');
    expect(html).not.toContain('No data for this period');
  });

  it('renders an explicit no-data message instead of a dollar figure when the period has no leads', () => {
    const html = render({ noData: true, headline: 91234, sub: 500, gap: 91234, delta: 12 });
    expect(html).toContain('No data for this period');
    // The would-be headline, sub and gap figures must not leak through.
    expect(html).not.toContain('$91,234');
    expect(html).not.toContain('$500');
    expect(html).not.toContain('12.0%');
  });

  it('drops the gap chip and delta in the no-data state so nothing implies a reconciled zero', () => {
    const html = render({ noData: true, headline: 0, sub: 0, gap: 0, delta: 0 });
    expect(html).not.toContain('gap $0');
    expect(html).not.toContain('0.0%');
    expect(html).not.toContain('$0.00');
  });

  it('honors a custom no-data label when the caller supplies one', () => {
    const html = render({ noData: true, noDataLabel: 'No spend tracked yet' });
    expect(html).toContain('No spend tracked yet');
  });

  it('still shows a real figure for a card that is not gated on lead volume (e.g. Cost)', () => {
    // Cost is ad spend plus supplier lead cost, which keeps arriving even into
    // an empty lead window (CONTRACT.md section 3), so callers simply never
    // pass noData for it. Confirms the default is "show the real number".
    const html = render({ label: 'Cost', headline: 7198, sub: 0, gap: 7198 });
    expect(html).toContain('$7,198');
    expect(html).not.toContain('No data for this period');
  });
});
