import { describe, it, expect } from 'vitest';

import {
  RESOLUTION,
  buildBuyerIndex,
  resolveBuyer,
  normalizationPatch,
  reconcile,
} from '../src/lib/buyerIdentity.js';

// Task R1. Lead.buyer_id is overloaded: it holds a Buyer record id, a
// buyer_code, or a legacy LeadByte bid depending on which code path wrote it.
// Attaching a lead to the wrong buyer delivers to the wrong customer and
// charges the wrong account, so anything ambiguous has to become an exception
// rather than a guess.

const BUYERS = [
  { id: 'rec_alpha', buyer_code: 'ALPHA', leadbyte_bid: '1001', company_name: 'Alpha Legal' },
  { id: 'rec_beta', buyer_code: 'BETA', leadbyte_bid: '1002', company_name: 'Beta Law' },
];

const index = buildBuyerIndex(BUYERS);

describe('resolveBuyer', () => {
  it('resolves a record id', () => {
    const r = resolveBuyer({ buyer_id: 'rec_alpha' }, index);
    expect(r.resolved).toBe(true);
    expect(r.via).toBe(RESOLUTION.RECORD_ID);
    expect(r.buyer.id).toBe('rec_alpha');
  });

  it('resolves a buyer code, case and space insensitively', () => {
    for (const v of ['ALPHA', 'alpha', '  Alpha  ']) {
      const r = resolveBuyer({ buyer_id: v }, index);
      expect(r.resolved).toBe(true);
      expect(r.via).toBe(RESOLUTION.BUYER_CODE);
      expect(r.buyer.id).toBe('rec_alpha');
    }
  });

  it('resolves a legacy LeadByte bid', () => {
    const r = resolveBuyer({ buyer_id: '1002' }, index);
    expect(r.resolved).toBe(true);
    expect(r.via).toBe(RESOLUTION.LEGACY_BID);
    expect(r.buyer.id).toBe('rec_beta');
  });

  it('falls back to buyer_name only when buyer_id is empty', () => {
    const r = resolveBuyer({ buyer_id: '', buyer_name: 'Beta Law' }, index);
    expect(r.resolved).toBe(true);
    expect(r.via).toBe(RESOLUTION.NAME);
    expect(r.buyer.id).toBe('rec_beta');
  });

  it('reports an empty lead as having no buyer, not as a failure', () => {
    // A lead that was never sold has no buyer. That is normal, and counting it
    // as an unresolved exception would bury the real exceptions.
    const r = resolveBuyer({ buyer_id: '' }, index);
    expect(r.resolved).toBe(false);
    expect(r.via).toBe(RESOLUTION.EMPTY);
  });

  it('reports an unknown identifier rather than guessing', () => {
    const r = resolveBuyer({ buyer_id: 'who_is_this' }, index);
    expect(r.resolved).toBe(false);
    expect(r.via).toBe(RESOLUTION.UNRESOLVED);
    expect(r.buyer).toBeNull();
  });

  it('prefers a record id over a code that collides with it', () => {
    // A buyer whose code happens to equal another buyer's record id must not
    // hijack it. The record id is checked first and exactly.
    const tricky = buildBuyerIndex([
      { id: 'rec_alpha', buyer_code: 'ALPHA' },
      { id: 'rec_gamma', buyer_code: 'rec_alpha' },
    ]);
    const r = resolveBuyer({ buyer_id: 'rec_alpha' }, tricky);
    expect(r.via).toBe(RESOLUTION.RECORD_ID);
    expect(r.buyer.id).toBe('rec_alpha');
  });
});

describe('ambiguity is an exception, never a guess', () => {
  const dupes = buildBuyerIndex([
    { id: 'rec_1', buyer_code: 'DUP', company_name: 'Same Name' },
    { id: 'rec_2', buyer_code: 'DUP', company_name: 'Same Name' },
  ]);

  it('refuses a duplicated buyer code', () => {
    const r = resolveBuyer({ buyer_id: 'DUP' }, dupes);
    expect(r.resolved).toBe(false);
    expect(r.via).toBe(RESOLUTION.AMBIGUOUS);
    expect(r.on).toBe('buyer_code');
  });

  it('refuses a duplicated company name', () => {
    const r = resolveBuyer({ buyer_id: '', buyer_name: 'Same Name' }, dupes);
    expect(r.resolved).toBe(false);
    expect(r.via).toBe(RESOLUTION.AMBIGUOUS);
    expect(r.on).toBe('buyer_name');
  });

  it('still resolves the unambiguous buyers alongside the duplicated ones', () => {
    const mixed = buildBuyerIndex([
      { id: 'rec_1', buyer_code: 'DUP' },
      { id: 'rec_2', buyer_code: 'DUP' },
      { id: 'rec_3', buyer_code: 'CLEAN' },
    ]);
    expect(resolveBuyer({ buyer_id: 'CLEAN' }, mixed).buyer.id).toBe('rec_3');
  });
});

describe('normalizationPatch is additive and idempotent', () => {
  it('writes the two new fields and never touches buyer_id', () => {
    const lead = { id: 'l1', buyer_id: 'ALPHA' };
    const patch = normalizationPatch(lead, resolveBuyer(lead, index));
    expect(patch).toEqual({ buyer_record_id: 'rec_alpha', buyer_code: 'ALPHA' });
    expect(patch).not.toHaveProperty('buyer_id');
  });

  it('returns null for a lead that is already normalized, which makes a rerun a no-op', () => {
    const lead = { id: 'l1', buyer_id: 'ALPHA', buyer_record_id: 'rec_alpha', buyer_code: 'ALPHA' };
    expect(normalizationPatch(lead, resolveBuyer(lead, index))).toBeNull();
  });

  it('writes nothing for an unresolved lead', () => {
    const lead = { id: 'l1', buyer_id: 'unknown' };
    expect(normalizationPatch(lead, resolveBuyer(lead, index))).toBeNull();
  });
});

describe('reconcile', () => {
  const leads = [
    { id: 'l1', buyer_id: 'rec_alpha' },
    { id: 'l2', buyer_id: 'BETA' },
    { id: 'l3', buyer_id: '1001' },
    { id: 'l4', buyer_id: 'ghost_buyer' },
    { id: 'l5', buyer_id: '' },
    { id: 'l6', buyer_id: 'ALPHA', buyer_record_id: 'rec_alpha', buyer_code: 'ALPHA' },
  ];

  it('counts every lead into exactly one bucket', () => {
    const { counts } = reconcile(leads, BUYERS);
    expect(counts.total).toBe(6);
    expect(counts.resolved).toBe(4);
    expect(counts.needs_write).toBe(3);
    expect(counts.already_normalized).toBe(1);
    expect(counts.unresolved).toBe(1);
    expect(counts.no_buyer).toBe(1);
    expect(counts.resolved + counts.unresolved + counts.ambiguous + counts.no_buyer).toBe(counts.total);
  });

  it('reports how each lead was resolved, so a surprising method is visible', () => {
    const { byMethod } = reconcile(leads, BUYERS);
    expect(byMethod[RESOLUTION.RECORD_ID]).toBe(1);
    expect(byMethod[RESOLUTION.BUYER_CODE]).toBe(2);
    expect(byMethod[RESOLUTION.LEGACY_BID]).toBe(1);
  });

  it('produces an exception list that names leads but carries no contact data', () => {
    const withPii = [{ id: 'l9', buyer_id: 'ghost', email: 'ada@example.com', phone: '5125551234' }];
    const { exceptions } = reconcile(withPii, BUYERS);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].lead_id).toBe('l9');
    expect(exceptions[0].reason).toBe(RESOLUTION.UNRESOLVED);
    expect(JSON.stringify(exceptions)).not.toContain('ada@example.com');
    expect(JSON.stringify(exceptions)).not.toContain('5125551234');
  });

  it('is idempotent: applying the patches makes a second run write nothing', () => {
    const first = reconcile(leads, BUYERS);
    const applied = leads.map((l) => {
      const p = first.patches.find((x) => x.id === l.id);
      return p ? { ...l, ...p.patch } : l;
    });
    const second = reconcile(applied, BUYERS);
    expect(second.patches).toHaveLength(0);
    expect(second.counts.needs_write).toBe(0);
    // The exceptions do not change, because nothing about them was resolved.
    expect(second.exceptions).toEqual(first.exceptions);
  });

  it('handles an empty buyer table without resolving anything to a wrong buyer', () => {
    const { counts, exceptions } = reconcile(leads, []);
    expect(counts.resolved).toBe(0);
    expect(exceptions.every((e) => e.reason === RESOLUTION.UNRESOLVED)).toBe(true);
  });
});
