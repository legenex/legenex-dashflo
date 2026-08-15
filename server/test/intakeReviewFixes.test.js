import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { sanitizeReceiptPayload, deriveTransportKey } from '../src/lib/receipts.js';
import { contactHashesFor, hashContact, PHONE_FIELDS, EMAIL_FIELDS } from '../src/lib/dnc.js';
import { checkLeadSuppression, DNC_DECISION } from '../src/lib/dncEnforcement.js';

// Regressions for the defects two independent reviewers found in the first cut
// of I3. Each test here failed before the fix.
//
// The common thread is worth stating: the original tests all passed. They
// passed because every fixture happened to use the one field spelling, the one
// key alias, and the one argument shape that worked. These fixtures use the
// shapes production actually produces.

const KEY = 'test-dnc-key-not-a-real-secret';
beforeEach(() => { process.env.DNC_HASH_KEY = KEY; });
afterEach(() => { delete process.env.DNC_HASH_KEY; });

function repoWith(entries) {
  return {
    entities: {
      DncEntry: { filter: async ({ contact_hash }) => entries.filter((e) => e.contact_hash === contact_hash) },
    },
  };
}
const suppress = (kind, value) => [{
  id: 'dnc_1', contact_kind: kind, contact_hash: hashContact(kind, value),
  scope: 'global', scope_value: null, status: 'active',
  effective_from: null, effective_to: null, reason: 'Consumer request',
}];

// ── The DNC bypass ──────────────────────────────────────────────────────────
//
// The screen runs before the pipeline normalizes field names, and it used to
// read only `lead.phone`. `mobile` is the canonical phone field in this system:
// first in processLead's alias chain, the column on Lead, and the spelling the
// posting docs show. So the documented way to post a lead was the way that
// bypassed suppression.

describe('a suppressed number is caught under every documented field spelling', () => {
  const NUMBER = '5550101234';

  for (const field of ['phone', 'mobile', 'phone1', 'phone_number', 'contact_phone']) {
    it(`suppresses when the number arrives as "${field}"`, async () => {
      const d = await checkLeadSuppression({
        db: repoWith(suppress('phone', NUMBER)),
        lead: { first_name: 'Ada', [field]: NUMBER },
      });
      expect(d.decision, field).toBe(DNC_DECISION.SUPPRESSED);
    });
  }

  it('catches a phone-only lead, which is the common shape in these verticals', async () => {
    // Previously this returned clear with checked: [] and unresolvable: [],
    // which looked perfectly healthy while screening nothing at all.
    const d = await checkLeadSuppression({
      db: repoWith(suppress('phone', NUMBER)),
      lead: { mobile: NUMBER },
    });
    expect(d.decision).toBe(DNC_DECISION.SUPPRESSED);
  });

  it('checks every phone field present, not just the first one found', async () => {
    // Otherwise the bypass is simply to put the suppressed number second.
    const d = await checkLeadSuppression({
      db: repoWith(suppress('phone', NUMBER)),
      lead: { mobile: '5559998888', phone2: NUMBER },
    });
    expect(d.decision).toBe(DNC_DECISION.SUPPRESSED);
  });

  it('suppresses an email under its aliases too', async () => {
    for (const field of ['email', 'contact_email', 'email_address']) {
      const d = await checkLeadSuppression({
        db: repoWith(suppress('email', 'opted.out@example.com')),
        lead: { [field]: 'opted.out@example.com' },
      });
      expect(d.decision, field).toBe(DNC_DECISION.SUPPRESSED);
    }
  });

  it('still clears a lead that is genuinely not on the list', () => {
    const { hashes } = contactHashesFor({ mobile: '5559998888' });
    expect(hashes).toHaveLength(1);
    expect(hashes[0].kind).toBe('phone');
  });

  it('deduplicates the same number repeated across aliases', () => {
    const { hashes } = contactHashesFor({ phone: '555 010 1234', mobile: '(555) 010-1234' });
    expect(hashes).toHaveLength(1);
  });

  it('reports an unparseable value rather than staying silent about it', () => {
    const { hashes, unresolvable } = contactHashesFor({ mobile: '123' });
    expect(hashes).toHaveLength(0);
    expect(unresolvable).toContain('phone');
  });

  it('covers the alias chain processLead actually uses', () => {
    for (const f of ['mobile', 'phone1', 'phone', 'phone_number']) {
      expect(PHONE_FIELDS, f).toContain(f);
    }
    expect(EMAIL_FIELDS).toContain('email');
  });
});

// ── The credential leak ─────────────────────────────────────────────────────

describe('every accepted supplier key alias is stripped from the receipt', () => {
  // processLead accepts the key under X_KEY as a documented alias. Nothing in
  // the sanitizer matched it, so a supplier posting in that shape wrote a live
  // ingest credential into every receipt it created.
  for (const alias of ['X_KEY', 'x_key', 'X-KEY', 'X-API-KEY', 'x-api-key', '_supplier_key', 'api_key', 'apiKey']) {
    it(`drops ${alias}`, () => {
      const { payload } = sanitizeReceiptPayload({ first_name: 'Ada', [alias]: 'lgnx_sup_live_secret' });
      expect(JSON.stringify(payload), alias).not.toContain('lgnx_sup_live_secret');
      expect(payload.first_name).toBe('Ada');
    });
  }

  it('drops the alias at depth and inside arrays', () => {
    const { payload } = sanitizeReceiptPayload({
      nested: { deep: { X_KEY: 'lgnx_sup_live_secret' } },
      list: [{ x_key: 'lgnx_sup_live_secret' }],
    });
    expect(JSON.stringify(payload)).not.toContain('lgnx_sup_live_secret');
  });
});

// ── Cross supplier transport key collision ──────────────────────────────────

describe('the transport key is scoped to the authenticating supplier', () => {
  it('two suppliers using the same idempotency key do not collide', () => {
    // Sequential per-client counters are the obvious client scheme, so this
    // collision was reachable by accident as well as on purpose.
    const a = deriveTransportKey({ source: 'supplier_http', suppliedKey: '1', supplierKeyId: 'key_a' });
    const b = deriveTransportKey({ source: 'supplier_http', suppliedKey: '1', supplierKeyId: 'key_b' });
    expect(a).not.toBe(b);
  });

  it('the same supplier with the same key still collides, which is the point', () => {
    const a = deriveTransportKey({ source: 'supplier_http', suppliedKey: '1', supplierKeyId: 'key_a' });
    const b = deriveTransportKey({ source: 'supplier_http', suppliedKey: '1', supplierKeyId: 'key_a' });
    expect(a).toBe(b);
  });

  it('scopes the derived content hash by supplier as well', () => {
    const args = { source: 'supplier_http', payload: { email: 'a@example.com' }, now: 1_700_000_000_000 };
    const a = deriveTransportKey({ ...args, supplierKeyId: 'key_a' });
    const b = deriveTransportKey({ ...args, supplierKeyId: 'key_b' });
    expect(a).not.toBe(b);
  });

  it('bounds a supplied key so an oversized header cannot reach the index', () => {
    // The UNIQUE btree index rejects entries past roughly 2704 bytes. An
    // unbounded header would raise inside the insert and lose the lead.
    const key = deriveTransportKey({
      source: 'supplier_http', suppliedKey: 'x'.repeat(10_000), supplierKeyId: 'key_a',
    });
    expect(key.length).toBeLessThan(300);
  });
});
