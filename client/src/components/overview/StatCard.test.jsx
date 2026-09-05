import { describe, it, expect, vi, afterAll } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';

// See GroupedKpiCard.test.jsx for why useCountUp is mocked: react-dom/server
// never runs the effect that animates it, so without this every count would
// render as its pre-animation value of 0 regardless of what was passed in.
vi.mock('@/hooks/useCountUp', () => ({ default: (target) => target }));

globalThis.window = { self: {}, top: {}, addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window.self = globalThis.window;
globalThis.window.top = globalThis.window;
globalThis.SVGElement = class SVGElement {};

const { default: StatCard } = await import('./StatCard.jsx');

afterAll(() => {
  delete globalThis.window;
  delete globalThis.SVGElement;
});

function render(props) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/']}>
      <StatCard label="Data Quality" count={100} render={(n) => `${Math.round(n)}/100`} icon={ShieldCheck} {...props} />
    </MemoryRouter>,
  );
}

describe('StatCard honest empty state', () => {
  it('renders the numeric score and its dot tone for a healthy, verified metric', () => {
    const html = render({ count: 92, render: (n) => `${Math.round(n)}/100`, note: 'verified against synced feeds', dotTone: 'good' });
    expect(html).toContain('92/100');
    expect(html).toContain('verified against synced feeds');
    expect(html).not.toContain('Unavailable');
  });

  it('never renders a numeric score while the metric is unavailable, even if one was computed', () => {
    // This is the exact shape of the reported bug: stats.dataQuality can come
    // back as a perfect 100 with nothing behind it (no leads to score), so the
    // fix must win on the `unavailable` flag regardless of what count/render
    // would otherwise have produced.
    const html = render({ count: 100, render: (n) => `${Math.round(n)}/100`, unavailable: true, note: 'no leads this period' });
    expect(html).toContain('Unavailable');
    expect(html).not.toContain('100/100');
  });

  it('does not contradict itself: the caption matches the unavailable state, not a stale "verified" claim', () => {
    const html = render({ unavailable: true, note: 'feeds stale' });
    expect(html).toContain('Unavailable');
    expect(html).toContain('feeds stale');
    expect(html).not.toContain('verified against synced feeds');
  });

  it('links to the relevant Data Source when unavailable and a link is supplied', () => {
    const html = render({ unavailable: true, link: { to: '/settings?tab=data-sources', label: 'View Data Sources' } });
    expect(html).toContain('href="/settings?tab=data-sources"');
    expect(html).toContain('View Data Sources');
  });

  it('renders no link when the metric is available, even if a link prop were passed', () => {
    const html = render({ unavailable: false, link: { to: '/settings?tab=data-sources', label: 'View Data Sources' } });
    expect(html).not.toContain('View Data Sources');
  });
});
