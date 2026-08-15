import { describe, it, expect } from 'vitest';

import {
  SEVERITY,
  checkBuyers,
  checkSuppliers,
  checkCampaigns,
  checkCredentialReferences,
  recoverConfiguration,
} from '../src/lib/configRecovery.js';

// Task C1. The value of this module is the exception list, not the recovery:
// Gate B is supposed to contain only questions that code could not answer, so
// anything derivable has to be derived and anything genuinely ambiguous has to
// be surfaced rather than assumed.

const codesOf = (findings) => findings.map((f) => f.code);

describe('buyer checks', () => {
  it('flags a buyer with no code as a blocker', () => {
    const out = checkBuyers([{ id: 'b1', company_name: 'Alpha' }]);
    expect(codesOf(out)).toContain('BUYER_NO_CODE');
    expect(out.find((f) => f.code === 'BUYER_NO_CODE').severity).toBe(SEVERITY.BLOCKER);
  });

  it('flags a duplicated buyer code and names the other holder', () => {
    const out = checkBuyers([
      { id: 'b1', buyer_code: 'DUP', payment_provider: 'stripe' },
      { id: 'b2', buyer_code: 'dup', payment_provider: 'stripe' },
    ]);
    const dupe = out.find((f) => f.code === 'BUYER_CODE_DUPLICATE');
    expect(dupe).toBeTruthy();
    expect(dupe.severity).toBe(SEVERITY.BLOCKER);
    expect(dupe.message).toContain('b1');
  });

  it('asks about an active buyer with no payment terms', () => {
    const out = checkBuyers([{ id: 'b1', buyer_code: 'A', active: true }]);
    const q = out.find((f) => f.code === 'BUYER_NO_PAYMENT_TERMS');
    expect(q.severity).toBe(SEVERITY.QUESTION);
  });

  it('does not ask about an inactive buyer', () => {
    const out = checkBuyers([{ id: 'b1', buyer_code: 'A', active: false }]);
    expect(codesOf(out)).not.toContain('BUYER_NO_PAYMENT_TERMS');
  });

  it('says nothing about a fully configured buyer', () => {
    expect(checkBuyers([{ id: 'b1', buyer_code: 'A', active: true, payment_provider: 'stripe' }])).toEqual([]);
  });
});

describe('supplier checks', () => {
  it('flags an active supplier that has no API key, because it cannot post', () => {
    const out = checkSuppliers([{ id: 's1', name: 'Acme', sid: 'acme', active: true }], []);
    const f = out.find((x) => x.code === 'SUPPLIER_NO_API_KEY');
    expect(f.severity).toBe(SEVERITY.BLOCKER);
  });

  it('accepts a key linked by supplier id or by supplier name', () => {
    const byId = checkSuppliers([{ id: 's1', name: 'Acme', sid: 'a', active: true }], [{ supplier_id: 's1' }]);
    const byName = checkSuppliers([{ id: 's1', name: 'Acme', sid: 'a', active: true }], [{ supplier_name: 'Acme' }]);
    expect(codesOf(byId)).not.toContain('SUPPLIER_NO_API_KEY');
    expect(codesOf(byName)).not.toContain('SUPPLIER_NO_API_KEY');
  });

  it('ignores an inactive supplier with no key', () => {
    const out = checkSuppliers([{ id: 's1', name: 'Acme', sid: 'a', active: false }], []);
    expect(codesOf(out)).not.toContain('SUPPLIER_NO_API_KEY');
  });

  it('flags a duplicated sid as a blocker', () => {
    const out = checkSuppliers([
      { id: 's1', name: 'A', sid: 'same', active: false },
      { id: 's2', name: 'B', sid: 'SAME', active: false },
    ], []);
    expect(codesOf(out)).toContain('SUPPLIER_SID_DUPLICATE');
  });
});

describe('campaign checks', () => {
  const buyers = [{ id: 'b1', buyer_code: 'A' }];

  it('flags a campaign routing to a buyer that does not exist', () => {
    const out = checkCampaigns([{ id: 'c1', buyer_ids: ['b1', 'ghost'], price: 10 }], buyers);
    const f = out.find((x) => x.code === 'CAMPAIGN_DANGLING_BUYER');
    expect(f.severity).toBe(SEVERITY.BLOCKER);
    expect(f.value).toBe('ghost');
  });

  it('flags an active campaign with no buyers, because its leads are unsellable', () => {
    const out = checkCampaigns([{ id: 'c1', buyer_ids: [], price: 10, active: true }], buyers);
    expect(codesOf(out)).toContain('CAMPAIGN_NO_BUYERS');
  });

  it('asks about an active campaign with no price', () => {
    const out = checkCampaigns([{ id: 'c1', buyer_ids: ['b1'], active: true }], buyers);
    expect(out.find((f) => f.code === 'CAMPAIGN_NO_PRICE').severity).toBe(SEVERITY.QUESTION);
  });

  it('treats a zero price as configured, not as missing', () => {
    // Zero is a real, deliberate price. Treating it as absent would generate a
    // question that has already been answered.
    const out = checkCampaigns([{ id: 'c1', buyer_ids: ['b1'], price: 0, active: true }], buyers);
    expect(codesOf(out)).not.toContain('CAMPAIGN_NO_PRICE');
  });

  it('only checks the vertical when a vertical list is available', () => {
    const withNone = checkCampaigns([{ id: 'c1', buyer_ids: ['b1'], price: 1, vertical: 'mva' }], buyers, []);
    expect(codesOf(withNone)).not.toContain('CAMPAIGN_UNKNOWN_VERTICAL');

    const withList = checkCampaigns(
      [{ id: 'c1', buyer_ids: ['b1'], price: 1, vertical: 'mva' }], buyers, [{ code: 'workers_comp' }],
    );
    expect(codesOf(withList)).toContain('CAMPAIGN_UNKNOWN_VERTICAL');
  });
});

// Regression guard for a trap this module already fell into once.
//
// The liveness test was originally `active !== false`. Buyer.active defaults to
// false in the schema while Supplier.active and Campaign.active default to
// true, so every buyer rule was dead: the report came back clean because the
// check never ran, not because the configuration was good. A silently dead
// rule in a Gate B artifact is worse than no rule, because it reads as a pass.
describe('liveness is active === true, not active !== false', () => {
  it('does not treat a record with no active field as live', () => {
    expect(codesOf(checkBuyers([{ id: 'b1', buyer_code: 'A' }])))
      .not.toContain('BUYER_NO_PAYMENT_TERMS');
    expect(codesOf(checkSuppliers([{ id: 's1', name: 'A', sid: 'a' }], [])))
      .not.toContain('SUPPLIER_NO_API_KEY');
    expect(codesOf(checkCampaigns([{ id: 'c1', buyer_ids: [] }], [])))
      .not.toContain('CAMPAIGN_NO_BUYERS');
  });

  it('fires for every entity once it is explicitly active', () => {
    expect(codesOf(checkBuyers([{ id: 'b1', buyer_code: 'A', active: true }])))
      .toContain('BUYER_NO_PAYMENT_TERMS');
    expect(codesOf(checkSuppliers([{ id: 's1', name: 'A', sid: 'a', active: true }], [])))
      .toContain('SUPPLIER_NO_API_KEY');
    expect(codesOf(checkCampaigns([{ id: 'c1', buyer_ids: [], active: true }], [])))
      .toContain('CAMPAIGN_NO_BUYERS');
  });
});

describe('credential references', () => {
  it('names references without ever carrying a value', () => {
    const out = checkCredentialReferences({});
    expect(codesOf(out)).toContain('CREDENTIAL_REFERENCE_MISSING');
    for (const f of out) expect(f.value).toBeNull();
    expect(out.map((f) => f.subject)).toEqual(
      expect.arrayContaining(['JWT_SECRET', 'MIGRATE_SOURCE_SECRET', 'PUBLIC_BASE_URL']),
    );
  });

  it('says nothing when the references are populated', () => {
    const out = checkCredentialReferences({
      JWT_SECRET: 'x', MIGRATE_SOURCE_SECRET: 'y', PUBLIC_BASE_URL: 'https://example.com',
    });
    expect(out).toEqual([]);
  });

  it('escalates a missing DNC key to a blocker once suppressions exist', () => {
    const none = checkCredentialReferences({ JWT_SECRET: 'x', MIGRATE_SOURCE_SECRET: 'y', PUBLIC_BASE_URL: 'z' }, { dncConfigured: false });
    expect(codesOf(none)).not.toContain('CREDENTIAL_REFERENCE_MISSING');

    const some = checkCredentialReferences({ JWT_SECRET: 'x', MIGRATE_SOURCE_SECRET: 'y', PUBLIC_BASE_URL: 'z' }, { dncConfigured: true });
    const f = some.find((x) => x.subject === 'DNC_HASH_KEY');
    expect(f.severity).toBe(SEVERITY.BLOCKER);
  });
});

describe('recoverConfiguration', () => {
  const clean = {
    buyers: [{ id: 'b1', buyer_code: 'A', active: true, payment_provider: 'stripe' }],
    suppliers: [{ id: 's1', name: 'Acme', sid: 'acme', active: true }],
    apiKeys: [{ supplier_id: 's1' }],
    campaigns: [{ id: 'c1', buyer_ids: ['b1'], price: 10, active: true }],
    verticals: [],
    dncEntries: [],
    env: { JWT_SECRET: 'x', MIGRATE_SOURCE_SECRET: 'y', PUBLIC_BASE_URL: 'z' },
  };

  it('reports a clean configuration as ready for Gate B', () => {
    const r = recoverConfiguration(clean);
    expect(r.findings).toEqual([]);
    expect(r.bySeverity.blocker).toBe(0);
    expect(r.ready_for_gate_b).toBe(true);
    expect(r.recovered).toEqual({
      buyers: 1, suppliers: 1, api_keys: 1, campaigns: 1, verticals: 0, dnc_entries: 0,
    });
  });

  it('is not ready for Gate B while a blocker stands', () => {
    const r = recoverConfiguration({ ...clean, apiKeys: [] });
    expect(r.bySeverity.blocker).toBeGreaterThan(0);
    expect(r.ready_for_gate_b).toBe(false);
  });

  it('counts an empty system without inventing findings about it', () => {
    const r = recoverConfiguration({ env: clean.env });
    expect(r.findings).toEqual([]);
    expect(r.recovered.buyers).toBe(0);
  });

  it('produces a report with no contact data in it', () => {
    const r = recoverConfiguration({
      ...clean,
      buyers: [{ id: 'b1', company_name: 'Alpha', email: 'ada@example.com', phone: '5125551234' }],
    });
    expect(JSON.stringify(r)).not.toContain('ada@example.com');
    expect(JSON.stringify(r)).not.toContain('5125551234');
  });
});
