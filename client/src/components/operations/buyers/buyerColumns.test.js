import { describe, expect, it } from 'vitest';
import { BUYER_COLUMNS, DEFAULT_BUYER_COLUMN_KEYS, getBuyerColumnDef } from './buyerColumns.js';

// Pure accessor/sortValue coverage for the Deliveries column. A buyer with
// zero configured deliveries is meaningful (see buyerListModel and the
// operator brief), so the zero case is asserted explicitly rather than
// treated as an absent/blank value.

const deliveriesCol = getBuyerColumnDef('deliveries');

const buyerA = { id: 'buyer-a' }; // 0 deliveries, no map entry at all
const buyerB = { id: 'buyer-b' }; // 1 delivery
const buyerC = { id: 'buyer-c' }; // many deliveries

const ctx = { deliveryCountByBuyer: { 'buyer-b': 1, 'buyer-c': 4 } };

describe('buyer Deliveries column', () => {
  it('is registered and included in the default column set', () => {
    expect(deliveriesCol).toBeTruthy();
    expect(deliveriesCol.header).toBe('Deliveries');
    expect(DEFAULT_BUYER_COLUMN_KEYS).toContain('deliveries');
    expect(BUYER_COLUMNS.some((c) => c.key === 'deliveries')).toBe(true);
  });

  it('renders 0 for a buyer with no deliveries, not blank or a dash', () => {
    expect(deliveriesCol.accessor(buyerA, ctx)).toBe('0');
  });

  it('renders the count for buyers with one or many deliveries', () => {
    expect(deliveriesCol.accessor(buyerB, ctx)).toBe('1');
    expect(deliveriesCol.accessor(buyerC, ctx)).toBe('4');
  });

  it('tolerates a missing deliveryCountByBuyer map on ctx', () => {
    expect(deliveriesCol.accessor(buyerA, {})).toBe('0');
    expect(deliveriesCol.sortValue(buyerA, {})).toBe(0);
  });

  it('sorts numerically low to high by delivery count', () => {
    const sorted = [buyerC, buyerA, buyerB].sort(
      (a, b) => deliveriesCol.sortValue(a, ctx) - deliveriesCol.sortValue(b, ctx)
    );
    expect(sorted.map((b) => b.id)).toEqual(['buyer-a', 'buyer-b', 'buyer-c']);
  });
});
