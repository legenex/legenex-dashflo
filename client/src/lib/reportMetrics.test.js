import { describe, it, expect } from 'vitest';
import { spendRows, spendInWindow } from '@/lib/reportMetrics';

// spendRows is the cost basis for every spend total in the app, so both of its
// failure modes are pinned here with the real shape of the data.
//
// Double counting: the account row is a rollup of that day's campaign rows.
// Under-reporting: account rows only exist for days the sync has covered at
// account level, so account-only silently drops the rest.

const ACC = 'act_630657151370020';
const sum = (rows) => rows.reduce((a, r) => a + Number(r.spend || 0), 0);

// 22 July, verified against production: the two campaign rows sum to exactly
// the account rollup.
const jul22 = [
  { ad_account_id: ACC, date: '2026-07-22', level: 'campaign', spend: 1294.69 },
  { ad_account_id: ACC, date: '2026-07-22', level: 'campaign', spend: 522.57 },
  { ad_account_id: ACC, date: '2026-07-22', level: 'account', spend: 1817.26 },
];

// 15 July: campaign rows only, no account rollup written yet.
const jul15 = [
  { ad_account_id: ACC, date: '2026-07-15', level: 'campaign', spend: 900.00 },
  { ad_account_id: ACC, date: '2026-07-15', level: 'campaign', spend: 350.00 },
];

describe('spendRows', () => {
  it('does not double count a day that has both levels', () => {
    expect(sum(spendRows(jul22))).toBeCloseTo(1817.26, 2);
  });

  it('falls back to campaign rows for a day with no account rollup', () => {
    expect(sum(spendRows(jul15))).toBeCloseTo(1250.00, 2);
  });

  it('handles a partial backfill without dropping or duplicating', () => {
    // The state that made Overview read 6,078 instead of the real month total.
    expect(sum(spendRows([...jul22, ...jul15]))).toBeCloseTo(3067.26, 2);
  });

  it('ignores ad-level rows entirely', () => {
    const withAds = [
      ...jul22,
      { ad_account_id: ACC, date: '2026-07-22', level: 'ad', spend: 1294.69 },
    ];
    expect(sum(spendRows(withAds))).toBeCloseTo(1817.26, 2);
  });

  it('does not let one account\'s rollup mask another account\'s campaign rows', () => {
    const twoAccounts = [
      { ad_account_id: ACC, date: '2026-07-22', level: 'account', spend: 1817.26 },
      { ad_account_id: 'act_other', date: '2026-07-22', level: 'campaign', spend: 500.00 },
    ];
    expect(sum(spendRows(twoAccounts))).toBeCloseTo(2317.26, 2);
  });

  it('treats legacy rows with no level as account rows', () => {
    const legacy = [{ ad_account_id: ACC, date: '2026-06-01', spend: 42.5 }];
    expect(sum(spendRows(legacy))).toBeCloseTo(42.5, 2);
  });

  it('returns nothing for empty input', () => {
    expect(spendRows([])).toEqual([]);
    expect(spendRows()).toEqual([]);
  });
});

describe('spendInWindow filters', () => {
  const rows = [
    { ad_account_id: 'a1', date: '2026-07-05', level: 'account', vertical: 'MVA', supplier_name: 'LeadFlow', spend: 1000 },
    { ad_account_id: 'a2', date: '2026-07-05', level: 'account', vertical: 'WC', supplier_name: 'LeadFlow', spend: 250 },
    { ad_account_id: 'a3', date: '2026-07-05', level: 'account', vertical: 'MVA', supplier_name: 'Legenex', spend: 400 },
    { ad_account_id: 'a1', date: '2026-08-01', level: 'account', vertical: 'MVA', supplier_name: 'LeadFlow', spend: 9999 },
  ];
  const total = (f) => spendInWindow(rows, f).reduce((a, r) => a + r.spend, 0);

  it('narrows spend by vertical, instead of leaving it at the full month', () => {
    // The WC bug: 3 leads were shown against the entire month of spend.
    expect(total({ date_from: '2026-07-01', date_to: '2026-07-31', vertical: 'WC' })).toBe(250);
  });

  it('narrows spend by supplier, case-insensitively', () => {
    expect(total({ date_from: '2026-07-01', date_to: '2026-07-31', supplier: 'LEADFLOW' })).toBe(1250);
  });

  it('combines a vertical and a supplier filter', () => {
    expect(total({ date_from: '2026-07-01', date_to: '2026-07-31', vertical: 'MVA', supplier: 'LeadFlow' })).toBe(1000);
  });

  it('still respects the date window', () => {
    expect(total({ date_from: '2026-07-01', date_to: '2026-07-31' })).toBe(1650);
  });

  it('treats "all" and empty as no filter', () => {
    expect(total({ date_from: '2026-07-01', date_to: '2026-07-31', vertical: 'all', supplier: '' })).toBe(1650);
  });

  it('ignores filters spend has no dimension for, rather than zeroing cost', () => {
    // Ad spend is incurred before a lead is sold to any buyer.
    expect(total({ date_from: '2026-07-01', date_to: '2026-07-31', buyer: 'Walker Advertising' })).toBe(1650);
  });
});
