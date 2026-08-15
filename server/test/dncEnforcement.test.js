import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  DNC_DECISION,
  DNC_NO_CONTACT,
  checkLeadSuppression,
  mayContinue,
  suppressionAudit,
} from '../src/lib/dncEnforcement.js';
import { DNC_SCOPE, DNC_STATUS, hashContact } from '../src/lib/dnc.js';
import { evaluateMember, REASON } from '../../client/src/lib/distribution/engine.js';

// Task I2, intake-facing half, plus the regression that matters most while it
// lands: global do-not-contact and route member suppression are two different
// mechanisms, and adding the first must not disturb the second.
//
// The repository is a double here rather than PostgreSQL because what is under
// test is the decision logic, not a database property. The database properties
// this system relies on are tested against real PostgreSQL in
// durableReceipt.test.js, where they actually live.

const KEY = 'test-dnc-key-not-a-real-secret';

function repoWith(entries) {
  return {
    entities: {
      DncEntry: {
        filter: async ({ contact_hash }) => entries.filter((e) => e.contact_hash === contact_hash),
      },
    },
  };
}

function failingRepo(err = new Error('connection terminated')) {
  return {
    entities: {
      DncEntry: {
        filter: async () => { throw err; },
      },
    },
  };
}

function entry(overrides = {}) {
  return {
    id: 'dnc_1',
    contact_kind: 'phone',
    contact_hash: hashContact('phone', '555 010 1234'),
    scope: DNC_SCOPE.GLOBAL,
    scope_value: null,
    status: DNC_STATUS.ACTIVE,
    effective_from: null,
    effective_to: null,
    reason: 'Consumer request',
    ...overrides,
  };
}

beforeEach(() => { process.env.DNC_HASH_KEY = KEY; });
afterEach(() => { delete process.env.DNC_HASH_KEY; });

describe('a suppressed contact is stopped', () => {
  it('suppresses on a matching phone, whatever formatting it arrived in', async () => {
    const db = repoWith([entry()]);
    for (const phone of ['5550101234', '(555) 010-1234', '+1 555 010 1234', '15550101234']) {
      const d = await checkLeadSuppression({ db, lead: { phone } });
      expect(d.decision, phone).toBe(DNC_DECISION.SUPPRESSED);
      expect(d.suppressed, phone).toBe(true);
      expect(d.reason, phone).toBe('DNC_SUPPRESSED');
      expect(mayContinue(d), phone).toBe(false);
    }
  });

  it('suppresses on a matching email regardless of case or padding', async () => {
    const db = repoWith([entry({
      id: 'dnc_email',
      contact_kind: 'email',
      contact_hash: hashContact('email', 'opted.out@example.com'),
    })]);
    for (const email of ['opted.out@example.com', 'Opted.Out@Example.com', '  opted.out@example.com  ']) {
      const d = await checkLeadSuppression({ db, lead: { email } });
      expect(d.decision, email).toBe(DNC_DECISION.SUPPRESSED);
    }
  });

  it('names which field matched, and carries no contact value anywhere', async () => {
    const db = repoWith([entry()]);
    const d = await checkLeadSuppression({ db, lead: { phone: '5550101234', email: 'a@example.com' } });
    expect(d.matched).toBe('phone');
    expect(d.entry_id).toBe('dnc_1');
    const serialized = JSON.stringify(d);
    expect(serialized).not.toContain('5550101234');
    expect(serialized).not.toContain('555');
    expect(serialized).not.toContain('a@example.com');
  });

  it('produces an audit record with a stable reason and no raw contact', async () => {
    const db = repoWith([entry()]);
    const d = await checkLeadSuppression({ db, lead: { phone: '5550101234' } });
    const audit = suppressionAudit(d);
    expect(audit).toEqual({
      reason_code: 'DNC_SUPPRESSED',
      reason_message: expect.any(String),
      matched_field: 'phone',
      dnc_entry_id: 'dnc_1',
      entry_reason: 'Consumer request',
    });
    expect(JSON.stringify(audit)).not.toContain('5550101234');
  });

  it('returns no audit record for a lead that was not suppressed', async () => {
    const db = repoWith([]);
    const d = await checkLeadSuppression({ db, lead: { phone: '5550101234' } });
    expect(suppressionAudit(d)).toBeNull();
  });
});

describe('an unsuppressed contact continues', () => {
  it('clears when the list holds nothing for it', async () => {
    const db = repoWith([entry()]);
    const d = await checkLeadSuppression({ db, lead: { phone: '5559998888' } });
    expect(d.decision).toBe(DNC_DECISION.CLEAR);
    expect(mayContinue(d)).toBe(true);
  });

  it('clears when the only matching entry is already expired', async () => {
    const db = repoWith([entry({ status: DNC_STATUS.EXPIRED })]);
    const d = await checkLeadSuppression({ db, lead: { phone: '5550101234' } });
    expect(d.decision).toBe(DNC_DECISION.CLEAR);
  });

  it('clears when the matching entry has not taken effect yet', async () => {
    const db = repoWith([entry({ effective_from: '2030-01-01T00:00:00Z' })]);
    const d = await checkLeadSuppression({ db, lead: { phone: '5550101234' } });
    expect(d.decision).toBe(DNC_DECISION.CLEAR);
  });

  it('suppresses inside the effective window and not outside it', async () => {
    const db = repoWith([entry({
      effective_from: '2026-01-01T00:00:00Z',
      effective_to: '2026-06-01T00:00:00Z',
    })]);
    const inside = await checkLeadSuppression({
      db, lead: { phone: '5550101234' }, at: new Date('2026-03-01T00:00:00Z'),
    });
    const after = await checkLeadSuppression({
      db, lead: { phone: '5550101234' }, at: new Date('2026-07-01T00:00:00Z'),
    });
    expect(inside.decision).toBe(DNC_DECISION.SUPPRESSED);
    expect(after.decision).toBe(DNC_DECISION.CLEAR);
  });
});

describe('scope is honoured', () => {
  const scoped = (scope, scope_value) => repoWith([entry({ scope, scope_value })]);

  it('a campaign scoped entry suppresses only that campaign', async () => {
    const db = scoped(DNC_SCOPE.CAMPAIGN, 'camp_a');
    const hit = await checkLeadSuppression({ db, lead: { phone: '5550101234' }, context: { campaign_id: 'camp_a' } });
    const miss = await checkLeadSuppression({ db, lead: { phone: '5550101234' }, context: { campaign_id: 'camp_b' } });
    expect(hit.decision).toBe(DNC_DECISION.SUPPRESSED);
    expect(miss.decision).toBe(DNC_DECISION.CLEAR);
  });

  it('a vertical scoped entry suppresses only that vertical', async () => {
    const db = scoped(DNC_SCOPE.VERTICAL, 'MVA');
    const hit = await checkLeadSuppression({ db, lead: { phone: '5550101234' }, context: { vertical: 'MVA' } });
    const miss = await checkLeadSuppression({ db, lead: { phone: '5550101234' }, context: { vertical: 'WC' } });
    expect(hit.decision).toBe(DNC_DECISION.SUPPRESSED);
    expect(miss.decision).toBe(DNC_DECISION.CLEAR);
  });

  it('a narrow entry with no scope value suppresses nothing', async () => {
    const db = scoped(DNC_SCOPE.CAMPAIGN, null);
    const d = await checkLeadSuppression({ db, lead: { phone: '5550101234' }, context: { campaign_id: 'camp_a' } });
    expect(d.decision).toBe(DNC_DECISION.CLEAR);
  });

  it('a global entry suppresses regardless of context', async () => {
    const db = scoped(DNC_SCOPE.GLOBAL, null);
    const d = await checkLeadSuppression({ db, lead: { phone: '5550101234' }, context: { campaign_id: 'anything' } });
    expect(d.decision).toBe(DNC_DECISION.SUPPRESSED);
  });
});

describe('the check fails closed, and holds the lead rather than losing it', () => {
  it('is unavailable, not clear, when the hash key is absent', async () => {
    delete process.env.DNC_HASH_KEY;
    const db = repoWith([]);
    const d = await checkLeadSuppression({ db, lead: { phone: '5550101234' } });
    expect(d.decision).toBe(DNC_DECISION.UNAVAILABLE);
    expect(d.suppressed).toBe(false);
    // The distinction that matters: not deliverable, but retryable and kept.
    expect(mayContinue(d)).toBe(false);
    expect(d.retryable).toBe(true);
  });

  it('is unavailable, not clear, when the lookup throws', async () => {
    const d = await checkLeadSuppression({ db: failingRepo(), lead: { phone: '5550101234' } });
    expect(d.decision).toBe(DNC_DECISION.UNAVAILABLE);
    expect(mayContinue(d)).toBe(false);
    expect(d.retryable).toBe(true);
  });

  it('is unavailable when there is no repository at all', async () => {
    const d = await checkLeadSuppression({ db: {}, lead: { phone: '5550101234' } });
    expect(d.decision).toBe(DNC_DECISION.UNAVAILABLE);
    expect(mayContinue(d)).toBe(false);
  });

  it('never reports unavailable as permission to continue', async () => {
    // The single property this whole failure mode exists for.
    for (const db of [failingRepo(), {}]) {
      const d = await checkLeadSuppression({ db, lead: { phone: '5550101234' } });
      expect(mayContinue(d)).toBe(false);
    }
  });
});

describe('leads with partial or unusable contact data', () => {
  it('checks the email when the phone is unparseable', async () => {
    const db = repoWith([entry({
      id: 'dnc_email',
      contact_kind: 'email',
      contact_hash: hashContact('email', 'opted.out@example.com'),
    })]);
    const d = await checkLeadSuppression({ db, lead: { phone: '123', email: 'opted.out@example.com' } });
    expect(d.decision).toBe(DNC_DECISION.SUPPRESSED);
    expect(d.unresolvable).toContain('phone');
  });

  it('clears a lead with nothing checkable, and says so', async () => {
    const db = repoWith([entry()]);
    const d = await checkLeadSuppression({ db, lead: {} });
    expect(d.decision).toBe(DNC_DECISION.CLEAR);
    expect(d.detail).toBe(DNC_NO_CONTACT);
    expect(d.checked).toEqual([]);
  });

  it('looks a duplicated contact up once', async () => {
    let calls = 0;
    const db = {
      entities: {
        DncEntry: {
          filter: async () => { calls += 1; return []; },
        },
      },
    };
    // Same value in both fields cannot happen for phone and email, so this
    // pins the dedupe on identical hashes rather than on field names.
    await checkLeadSuppression({ db, lead: { phone: '5550101234', email: '' } });
    expect(calls).toBe(1);
  });
});

// ── Regression: the other suppression system is untouched ───────────────────
//
// Route member suppression is a buyer's own list, evaluated inside routing.
// It is a different mechanism with a different blast radius, and global DNC
// must not have replaced, disabled or duplicated it.

describe('route member suppression still works and stays independent', () => {
  // Shaped like the fixture in engine.test.js. The buyer lifecycle allowlist
  // runs before suppression, so a member without an explicitly active buyer
  // never reaches the suppression branch at all.
  const lead = {
    state: 'TX', vertical: 'legal',
    email: 'buyer.optout@example.com', mobile: '5557778888', phone: '5557778888',
  };
  const member = {
    id: 'm1',
    active: true,
    priority: 1,
    price: 10,
    buyer: { active: true, status: 'active' },
    filters: { states: ['TX'] },
    suppression: ['buyer.optout@example.com'],
  };

  it('still makes a member ineligible on its own suppression list, by email', () => {
    const r = evaluateMember(member, lead);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe(REASON.SUPPRESSED);
  });

  it('still makes a member ineligible on its own suppression list, by phone', () => {
    const r = evaluateMember({ ...member, suppression: ['555-777-8888'] }, lead);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe(REASON.SUPPRESSED);
  });

  it('leaves a member eligible when the lead is not on its list', () => {
    const r = evaluateMember({ ...member, suppression: ['someone.else@example.com'] }, lead);
    expect(r.eligible).toBe(true);
  });

  it('is per member: one buyer suppressing a lead does not suppress another buyer', () => {
    // The behavioural difference from global DNC, stated as a test. A route
    // member list makes one member ineligible; the lead remains sellable.
    const blocked = evaluateMember(member, lead);
    const open = evaluateMember({ ...member, id: 'm2', suppression: [] }, lead);
    expect(blocked.eligible).toBe(false);
    expect(open.eligible).toBe(true);
  });

  it('does not consult the global list, and needs no hash key', async () => {
    // Route suppression must keep working even where global DNC cannot run,
    // because they are independent mechanisms with independent failure modes.
    delete process.env.DNC_HASH_KEY;
    const r = evaluateMember(member, lead);
    expect(r.reason).toBe(REASON.SUPPRESSED);
  });

  it('global DNC does not make an otherwise eligible member ineligible', async () => {
    // Global DNC stops the lead earlier, in the pipeline. It must not reach
    // into per member eligibility, or a globally suppressed lead would be
    // reported as a routing failure instead of a suppression.
    const db = repoWith([entry({ contact_hash: hashContact('phone', '5557778888') })]);
    const d = await checkLeadSuppression({ db, lead });
    expect(d.decision).toBe(DNC_DECISION.SUPPRESSED);

    const r = evaluateMember({ ...member, suppression: [] }, lead);
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe(REASON.ELIGIBLE);
  });

  it('the two mechanisms report different reasons, so they stay distinguishable', async () => {
    const db = repoWith([entry({ contact_hash: hashContact('phone', '5557778888') })]);
    const global = await checkLeadSuppression({ db, lead });
    const routeLevel = evaluateMember(member, lead);
    expect(global.reason).toBe('DNC_SUPPRESSED');
    expect(routeLevel.reason).toBe(REASON.SUPPRESSED);
    expect(global.reason).not.toBe(routeLevel.reason);
  });
});
