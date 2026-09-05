import { describe, it, expect, afterAll } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// client/src/lib/utils.js reads window.self/window.top at import time (see
// StatCard.test.jsx for the same shim and why it is needed under
// react-dom/server, which never provides a window).
globalThis.window = { self: {}, top: {}, addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window.self = globalThis.window;
globalThis.window.top = globalThis.window;
globalThis.SVGElement = class SVGElement {};

const { default: LeadsFilterBar } = await import('./LeadsFilterBar.jsx');

afterAll(() => {
  delete globalThis.window;
  delete globalThis.SVGElement;
});

// WORK-UNITS.yaml W3-UI-STATUS acceptance criterion: "Sold, Unsold,
// Disqualified and Rejected tabs render no Status filter." LeadsTable.jsx
// wires showStatusFilter={view === 'all'}, so this proves the control itself
// actually honors that flag rather than always rendering (which is the part
// a purely visual/manual check could miss).
const baseProps = {
  search: '', setSearch: () => {},
  period: 'this_month', setPeriod: () => {},
  customPeriod: { from: '', to: '' }, setCustomPeriod: () => {},
  customFilters: [], setCustomFilters: () => {},
  savedSets: [], onSaveSet: () => {}, onDeleteSet: () => {}, onApplySet: () => {},
  filterFields: [],
  resultCount: 0,
  statusFilter: [], setStatusFilter: () => {},
  statusOptions: [{ value: 'sold', label: 'Sold' }, { value: 'unsold', label: 'Unsold' }],
  supplierFilter: [], setSupplierFilter: () => {}, supplierOptions: [],
  buyerFilter: [], setBuyerFilter: () => {}, buyerOptions: [],
  sourceFilter: [], setSourceFilter: () => {}, sourceOptions: [],
  verticalFilter: [], setVerticalFilter: () => {}, verticalOptions: [],
};

describe('LeadsFilterBar: Status filter restricted to All Leads', () => {
  it('renders the Status filter (defaults to visible) when showStatusFilter is not passed', () => {
    const html = renderToStaticMarkup(<LeadsFilterBar {...baseProps} />);
    expect(html).toContain('All Status');
  });

  it('renders the Status filter when showStatusFilter is explicitly true (the All Leads tab)', () => {
    const html = renderToStaticMarkup(<LeadsFilterBar {...baseProps} showStatusFilter />);
    expect(html).toContain('All Status');
  });

  it('renders no Status filter when showStatusFilter is false (Sold, Unsold, Disqualified, Rejected, Queued, Converted tabs)', () => {
    const html = renderToStaticMarkup(<LeadsFilterBar {...baseProps} showStatusFilter={false} />);
    expect(html).not.toContain('All Status');
  });

  it('still renders the other filters (suppliers, buyers, sources) when the Status filter is hidden', () => {
    const html = renderToStaticMarkup(<LeadsFilterBar {...baseProps} showStatusFilter={false} />);
    expect(html).toContain('All Suppliers');
    expect(html).toContain('All Buyers');
    expect(html).toContain('All Sources');
  });
});
