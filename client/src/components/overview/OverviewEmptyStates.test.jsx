import { describe, it, expect, vi, afterAll } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Integration coverage for W5-EMPTY-STATES / CONTRACT.md section 3, exercised
// against the real Overview page (client/src/pages/Overview.jsx) rather than
// only the presentational components it composes, so the actual wiring
// (financialTruth -> periodHasNoLeads/dataQualityUnavailable -> the cards) is
// what gets proven, not a hand-built stand-in for it.
//
// Lives under client/src/components/overview per this work unit's test
// location, even though the page under test is client/src/pages/Overview.jsx.
//
// Rendered with react-dom/server the same way DistributionDashboard.test.jsx
// and ToolsDashboard.test.jsx render their pages: a real QueryClient with
// queries disabled and pre-seeded via setQueryData, so no network call is
// ever attempted (react-effects, including useAiBriefing's fetch, never run
// under a static server render either way).
vi.mock('@/hooks/useCountUp', () => ({ default: (target) => target }));

globalThis.window = {
  self: {}, top: {}, location: { origin: 'https://app.example.test', pathname: '/' },
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {},
};
globalThis.window.self = globalThis.window;
globalThis.window.top = globalThis.window;
globalThis.SVGElement = class SVGElement {};

const { default: Overview } = await import('../../pages/Overview.jsx');

afterAll(() => {
  delete globalThis.window;
  delete globalThis.SVGElement;
});

// A believable near-real lead so the "healthy" comparison render below is not
// itself an empty-table case.
function makeLead(overrides = {}) {
  return {
    id: 'lead-1',
    created_date: new Date().toISOString(),
    final_status: 'Sold',
    supplier_name: 'Supplier A',
    revenue: 250,
    mapped_fields: JSON.stringify({ buyer_id: 'buyer-1', cpl: 40 }),
    archived: false,
    ...overrides,
  };
}

function renderOverview({ leads = [], adSpend = [] } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  queryClient.setQueryData(['ov-leads'], leads);
  queryClient.setQueryData(['adspend'], adSpend);
  // Everything else (buyers, suppliers, invoices, payments, payouts, bank
  // transactions, error log, integration configs, ad-spend mappings, lead
  // sources) defaults to [] in Overview.jsx's own destructuring when the
  // query cache has nothing for that key, which is exactly the production
  // shape for a fresh instance with only leads and ad spend flowing.
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Overview />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Overview dashboard: empty lead table renders honest no-data states', () => {
  it('Revenue, Profit and CPL all render "No data for this period" with zero leads', () => {
    const html = renderOverview({ leads: [] });
    const occurrences = html.split('No data for this period').length - 1;
    // Revenue, Profit, CPL: three cards gated on the empty lead window. Cost
    // is deliberately excluded (see GroupedKpiCard.test.jsx).
    expect(occurrences).toBe(3);
  });

  it('Cost still renders a real figure, not a no-data state, when ad spend exists with zero leads', () => {
    // This is the exact reported shape: ad spend keeps landing through its
    // connector into a dormant lead table (CONTRACT.md section 3), so Cost
    // must stay a real number even while Revenue/Profit/CPL go to no-data.
    const html = renderOverview({ leads: [], adSpend: [{ date: new Date().toISOString().slice(0, 10), spend: 7198, level: 'account' }] });
    expect(html).toContain('$7,198');
  });

  it('Data Quality never renders a numeric score with zero leads, even though the raw stat defaults to a false 100', () => {
    const html = renderOverview({ leads: [] });
    expect(html).not.toContain('100/100');
    expect(html).toContain('Unavailable');
    expect(html).toContain('View Data Sources');
    expect(html).toContain('href="/settings?tab=data-sources"');
  });

  it('a populated period renders real KPI figures rather than the no-data message', () => {
    const html = renderOverview({ leads: [makeLead(), makeLead({ id: 'lead-2', revenue: 300 })] });
    expect(html).not.toContain('No data for this period');
  });
});
