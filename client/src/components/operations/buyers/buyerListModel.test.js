import { afterAll, describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { filterBuyerRows, matchesBuyerTab } from './buyerListModel.js';

globalThis.window = { self: {}, top: {} };
globalThis.window.self = globalThis.window;
globalThis.window.top = globalThis.window;
const { default: BuyerTable } = await import('./BuyerTable.jsx');
const { DEFAULT_BUYER_COLUMN_KEYS } = await import('./buyerColumns.js');

afterAll(() => { delete globalThis.window; });

const buyers = Array.from({ length: 13 }, (_, index) => ({
  id: `buyer-${index + 1}`,
  company_name: `Buyer ${index + 1}`,
  buyer_code: `B${index + 1}`,
  client_type: index < 8 ? 'Law Firm' : index < 11 ? 'Aggregator' : null,
  vertical: index % 2 === 0 ? 'MVA' : 'WC',
  status: index === 12 ? 'paused' : index === 11 ? 'draft' : 'active',
}));

describe('buyer list rows', () => {
  it('renders every populated API row on the All tab', () => {
    expect(filterBuyerRows(buyers, 'all')).toHaveLength(13);
  });

  it('keeps lifecycle and setup tabs separate', () => {
    expect(filterBuyerRows(buyers, 'Law Firm')).toHaveLength(8);
    expect(filterBuyerRows(buyers, 'disabled')).toHaveLength(1);
    expect(filterBuyerRows(buyers, 'needs_setup')).toHaveLength(2);
    expect(matchesBuyerTab(buyers[0], 'all')).toBe(true);
  });

  it('applies the vertical filter without dropping the unfiltered catalog', () => {
    expect(filterBuyerRows(buyers, 'all', ['MVA'])).toHaveLength(7);
    expect(filterBuyerRows(buyers, 'all', [])).toHaveLength(13);
  });

  it('renders all 13 populated rows in the buyer table', () => {
    const html = renderToStaticMarkup(React.createElement(BuyerTable, {
      buyers,
      config: { columns: DEFAULT_BUYER_COLUMN_KEYS.map((key) => ({ key })) },
      ctx: { cplRows: [] },
      sortKey: 'company_name',
      sortDir: 'asc',
      onSort: () => {},
      selectedIds: new Set(),
      onToggleSelect: () => {},
      onToggleSelectAll: () => {},
    }));
    for (const buyer of buyers) expect(html).toContain(buyer.company_name);
    expect((html.match(/<tr/g) || [])).toHaveLength(14);
  });
});
