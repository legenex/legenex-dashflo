import { afterAll, describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

globalThis.window = {
  self: {}, top: {}, location: { origin: 'https://app.example.test', pathname: '/distribution' },
  addEventListener: () => {}, removeEventListener: () => {},
};
globalThis.SVGElement = class SVGElement {};
globalThis.window.self = globalThis.window;
globalThis.window.top = globalThis.window;
const { default: DistributionDashboard } = await import('./DistributionDashboard.jsx');

afterAll(() => {
  delete globalThis.window;
  delete globalThis.SVGElement;
});

function renderDashboard() {
  const now = new Date().toISOString();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  queryClient.setQueryData(['dist-leads'], [
    { id: 'lead-1', created_date: now, final_status: 'Sold', supplier_name: 'Supplier A', archived: false },
    { id: 'lead-2', created_date: now, final_status: 'Unsold', supplier_name: 'Supplier B', archived: false },
  ]);
  queryClient.setQueryData(['dist-errors'], []);
  queryClient.setQueryData(['hlr-settings'], [{ provider_name: 'Configured provider' }]);
  queryClient.setQueryData(['email-val-settings'], [{ enabled: true }]);
  queryClient.setQueryData(['app-settings'], [{ public_api_base_url: 'https://api.example.test' }]);
  queryClient.setQueryData(['meta-config'], null);
  queryClient.setQueryData(['integration-status'], {});

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/distribution']}>
        <DistributionDashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Distribution dashboard initial render', () => {
  it('renders production-shaped query data without a blank page', () => {
    const html = renderDashboard();
    expect(html).toContain('Distribution Dashboard');
    expect(html).toContain('Pipeline');
    expect(html).toContain('2 leads processed this period');
    expect(html).toContain('https://api.example.test/functions/leads');
  });
});
