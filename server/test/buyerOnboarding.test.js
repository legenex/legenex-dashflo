import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';

import submitBuyerOnboarding from '../src/functions/submitBuyerOnboarding.js';
import getOnboardingContext from '../src/functions/getOnboardingContext.js';
import sendOnboardingLink from '../src/functions/sendOnboardingLink.js';
import onboardBuyer from '../src/functions/onboardBuyer.js';

// The onboarding-complete and blocked-alert steps send mail. SMTP is never
// configured in the test environment, so the real sendMail already no-ops
// (logs and returns), but mocking it lets these tests assert the internal
// alert actually fires instead of just trusting it did not throw.
vi.mock('../src/lib/mailer.js', () => ({
  sendMail: vi.fn(async () => ({ queued: false, logged: true })),
}));
import { sendMail } from '../src/lib/mailer.js';

// W9-ONBOARDING: completion and hardening of the existing buyer onboarding
// flow (Contract v3 D9). Covers the two P0 findings from the audit (GAP-57:
// vertical never captured; GAP-59: Xero/Stripe block every real onboarding)
// plus the rest of D9's scope: the secure/expiring/revocable link, immutable
// versioned submissions, missing-information detection and its internal
// alert, and rate limiting.

const OPERATOR = { id: 'op1', role: 'admin', base_role: 'operator', permissions: '{}' };

// ── Minimal in-memory entity store, matching the db.entities.X shape
// (get/create/update/filter/list) the ported functions call against. ────────
function makeEntity(seedRows = []) {
  const rows = seedRows.map((r, i) => ({
    id: r.id || `seed${i + 1}`,
    created_date: r.created_date || new Date().toISOString(),
    ...r,
  }));
  let seq = rows.length;
  const matches = (row, query) => Object.entries(query || {}).every(([k, v]) => row[k] === v);
  return {
    rows,
    async get(id) {
      return rows.find((r) => r.id === id) || null;
    },
    async create(fields) {
      seq += 1;
      const row = { id: fields.id || `auto${seq}`, created_date: new Date().toISOString(), ...fields };
      rows.push(row);
      return { ...row };
    },
    async update(id, patch) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error(`No such record: ${id}`);
      Object.assign(row, patch);
      return { ...row };
    },
    async filter(query = {}) {
      return rows.filter((r) => matches(r, query)).map((r) => ({ ...r }));
    },
    async list() {
      return rows.map((r) => ({ ...r }));
    },
  };
}

function makeDb({
  buyerOnboarding = [],
  buyers = [],
  integrationConfigs = [],
  emailTemplates = [],
  leadByteConnectors = [],
  counters = [],
} = {}) {
  return {
    entities: {
      BuyerOnboarding: makeEntity(buyerOnboarding),
      Buyer: makeEntity(buyers),
      IntegrationConfig: makeEntity(integrationConfigs),
      OnboardingEmailTemplate: makeEntity(emailTemplates),
      LeadByteConnector: makeEntity(leadByteConnectors),
      Counter: makeEntity(counters),
      User: { get: async () => OPERATOR },
    },
  };
}

let ipSeq = 0;
function nextIp() {
  ipSeq += 1;
  return `10.10.0.${ipSeq}`;
}

function ctxFor(db, body, { user = null, ip = nextIp(), method = 'POST' } = {}) {
  return {
    user,
    db,
    body,
    req: { method, headers: { 'x-forwarded-for': ip } },
    json: (data, status = 200) => ({ __status: status, ...data }),
  };
}

const FULL_PAYLOAD = {
  company_name: 'Acme Legal',
  primary_contact_name: 'Jamie Rivera',
  primary_contact_email: 'jamie@acmelegal.com',
  primary_contact_phone: '+1 555 0100',
  target_states: ['TX', 'CA'],
  client_type: 'Law Firm',
  cpl: 45,
  billing_type: 'invoiced_weekly',
  vertical: 'MVA',
};

beforeEach(() => {
  sendMail.mockClear();
});

// ── getOnboardingContext ─────────────────────────────────────────────────

describe('getOnboardingContext', () => {
  it('resolves a valid token to the display allowlist and nothing else', async () => {
    const db = makeDb({
      buyers: [{ id: 'buyer1', company_name: 'Acme Legal', vertical: 'MVA', client_type: 'Law Firm', buyer_code: 'LF1', cpl: 999, credit_limit: 5000, buyer_api_key: 'secret-key' }],
      buyerOnboarding: [{ id: 'ob1', token: 'tok-valid', status: 'invited', buyer_id: 'buyer1', company_name: 'Acme Legal' }],
    });
    const res = await getOnboardingContext(ctxFor(db, { token: 'tok-valid' }));
    expect(res).toEqual({
      company_name: 'Acme Legal',
      vertical: 'MVA',
      client_type: 'Law Firm',
      buyer_code: 'LF1',
    });
    // Nothing beyond the documented allowlist ever renders on the public form:
    // no price, no margin, no routing detail, no credential.
    const leaked = Object.keys(res).filter((k) => !['company_name', 'vertical', 'client_type', 'buyer_code'].includes(k));
    expect(leaked).toEqual([]);
    expect(JSON.stringify(res)).not.toContain('secret-key');
    expect(JSON.stringify(res)).not.toContain('999');
    expect(JSON.stringify(res)).not.toContain('5000');
  });

  it('returns a neutral 404 for an unknown token, identical whether or not any buyer exists', async () => {
    const dbWithBuyers = makeDb({
      buyers: [{ id: 'buyer1', company_name: 'Acme Legal' }],
      buyerOnboarding: [{ id: 'ob1', token: 'tok-real', status: 'invited', buyer_id: 'buyer1' }],
    });
    const dbEmpty = makeDb({});
    const resA = await getOnboardingContext(ctxFor(dbWithBuyers, { token: 'tok-guessed' }));
    const resB = await getOnboardingContext(ctxFor(dbEmpty, { token: 'tok-guessed' }));
    expect(resA).toEqual(resB);
    expect(resA.__status).toBe(404);
    expect(resA.error).toBe('Invalid or expired link.');
  });

  it('treats a cancelled (revoked) token as dead', async () => {
    const db = makeDb({
      buyerOnboarding: [{ id: 'ob1', token: 'tok-revoked', status: 'cancelled', company_name: 'Acme Legal' }],
    });
    const res = await getOnboardingContext(ctxFor(db, { token: 'tok-revoked' }));
    expect(res.__status).toBe(410);
  });

  it('treats a link older than the expiry window as dead, same as a revoked one', async () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const db = makeDb({
      buyerOnboarding: [{ id: 'ob1', token: 'tok-old', status: 'invited', company_name: 'Acme Legal', created_date: old }],
    });
    const res = await getOnboardingContext(ctxFor(db, { token: 'tok-old' }));
    expect(res.__status).toBe(410);
  });

  it('does not expire a fresh link', async () => {
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const db = makeDb({
      buyerOnboarding: [{ id: 'ob1', token: 'tok-fresh', status: 'invited', company_name: 'Acme Legal', created_date: recent }],
    });
    const res = await getOnboardingContext(ctxFor(db, { token: 'tok-fresh' }));
    expect(res.__status).toBeUndefined();
    expect(res.company_name).toBe('Acme Legal');
  });

  it('is rate limited per IP (GAP-62)', async () => {
    const db = makeDb({
      buyerOnboarding: [{ id: 'ob1', token: 'tok-valid', status: 'invited', company_name: 'Acme Legal' }],
    });
    const ip = nextIp();
    let last;
    for (let i = 0; i < 9; i += 1) {
      last = await getOnboardingContext(ctxFor(db, { token: 'tok-valid' }, { ip }));
    }
    expect(last.__status).toBe(429);
  });
});

// ── submitBuyerOnboarding ────────────────────────────────────────────────

describe('submitBuyerOnboarding', () => {
  it('creates a new submission (no token) with version 1', async () => {
    const db = makeDb({});
    const res = await submitBuyerOnboarding(ctxFor(db, FULL_PAYLOAD));
    expect(res.status).toBe('ok');
    expect(res.submission_version).toBe(1);
    const stored = await db.entities.BuyerOnboarding.get(res.onboarding_id);
    expect(stored.submission_version).toBe(1);
    expect(JSON.parse(stored.form_payload).company_name).toBe('Acme Legal');
  });

  it('flags the exact missing fields on an incomplete submission and persists nothing', async () => {
    const db = makeDb({});
    const res = await submitBuyerOnboarding(ctxFor(db, { company_name: 'Acme Legal' }));
    expect(res.__status).toBe(400);
    expect(Object.keys(res.field_errors).sort()).toEqual([
      'billing_type', 'client_type', 'cpl', 'primary_contact_email', 'primary_contact_name',
      'primary_contact_phone', 'target_states',
    ].sort());
    expect(db.entities.BuyerOnboarding.rows).toHaveLength(0);
  });

  it('stores a token-based submission against the correct buyer and clears the invited state', async () => {
    const db = makeDb({
      buyers: [{ id: 'buyer1', company_name: 'Acme Legal' }],
      buyerOnboarding: [{ id: 'ob1', token: 'tok-1', status: 'invited', buyer_id: 'buyer1', company_name: 'Acme Legal' }],
    });
    const res = await submitBuyerOnboarding(ctxFor(db, { ...FULL_PAYLOAD, token: 'tok-1' }));
    expect(res.status).toBe('ok');
    expect(res.onboarding_id).toBe('ob1');
    expect(res.submission_version).toBe(1);
    const stored = await db.entities.BuyerOnboarding.get('ob1');
    expect(stored.buyer_id).toBe('buyer1');
    expect(stored.status).toBe('submitted');
    expect(stored.submission_history).toBeUndefined();
  });

  it('archives the prior submission on resubmission instead of silently overwriting it (GAP-58)', async () => {
    const db = makeDb({
      buyerOnboarding: [{ id: 'ob1', token: 'tok-1', status: 'invited', company_name: 'Acme Legal' }],
    });
    const first = await submitBuyerOnboarding(ctxFor(db, { ...FULL_PAYLOAD, token: 'tok-1' }));
    expect(first.submission_version).toBe(1);

    const corrected = { ...FULL_PAYLOAD, token: 'tok-1', primary_contact_phone: '+1 555 9999' };
    const second = await submitBuyerOnboarding(ctxFor(db, corrected));
    expect(second.submission_version).toBe(2);

    const stored = await db.entities.BuyerOnboarding.get('ob1');
    expect(JSON.parse(stored.form_payload).primary_contact_phone).toBe('+1 555 9999');
    const history = JSON.parse(stored.submission_history);
    expect(history).toHaveLength(1);
    expect(history[0].version).toBe(1);
    // The original submission's content survives intact in the archive.
    expect(JSON.parse(history[0].form_payload).primary_contact_phone).toBe('+1 555 0100');

    // A third resubmission keeps appending, never truncating history.
    const third = await submitBuyerOnboarding(ctxFor(db, { ...FULL_PAYLOAD, token: 'tok-1', company_name: 'Acme Legal Group' }));
    expect(third.submission_version).toBe(3);
    const storedAgain = await db.entities.BuyerOnboarding.get('ob1');
    expect(JSON.parse(storedAgain.submission_history)).toHaveLength(2);
  });

  it('rejects a cancelled (revoked) token as dead without touching the record', async () => {
    const db = makeDb({
      buyerOnboarding: [{ id: 'ob1', token: 'tok-revoked', status: 'cancelled', form_payload: JSON.stringify(FULL_PAYLOAD) }],
    });
    const res = await submitBuyerOnboarding(ctxFor(db, { ...FULL_PAYLOAD, token: 'tok-revoked' }));
    expect(res.__status).toBe(410);
    const stored = await db.entities.BuyerOnboarding.get('ob1');
    expect(stored.status).toBe('cancelled');
  });

  it('returns a neutral 404 for an unknown token', async () => {
    const db = makeDb({});
    const res = await submitBuyerOnboarding(ctxFor(db, { ...FULL_PAYLOAD, token: 'tok-does-not-exist' }));
    expect(res.__status).toBe(404);
    expect(res.error).toBe('Invalid or expired onboarding link.');
  });

  it('treats an expired link as dead, same as a revoked one', async () => {
    const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const db = makeDb({
      buyerOnboarding: [{ id: 'ob1', token: 'tok-old', status: 'invited', created_date: old }],
    });
    const res = await submitBuyerOnboarding(ctxFor(db, { ...FULL_PAYLOAD, token: 'tok-old' }));
    expect(res.__status).toBe(410);
  });

  it('is rate limited per IP', async () => {
    const db = makeDb({});
    const ip = nextIp();
    let last;
    for (let i = 0; i < 9; i += 1) {
      last = await submitBuyerOnboarding(ctxFor(db, { ...FULL_PAYLOAD, company_name: `Co ${i}` }, { ip }));
    }
    expect(last.__status).toBe(429);
  });
});

// ── sendOnboardingLink ───────────────────────────────────────────────────

describe('sendOnboardingLink', () => {
  it('emails the link and stamps link_sent_at for an active, unexpired invite', async () => {
    const db = makeDb({
      buyers: [{ id: 'buyer1', company_name: 'Acme Legal', email: 'jamie@acmelegal.com' }],
      buyerOnboarding: [{ id: 'ob1', token: 'tok-1', status: 'invited', buyer_id: 'buyer1' }],
    });
    const res = await sendOnboardingLink(ctxFor(db, { buyer_id: 'buyer1', link_base: 'https://app.dashflo.io' }, { user: OPERATOR }));
    expect(res.ok).toBe(true);
    expect(res.to).toBe('jamie@acmelegal.com');
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].body).toContain('https://app.dashflo.io/apply?token=tok-1');
    const stored = await db.entities.BuyerOnboarding.get('ob1');
    expect(stored.link_sent_at).toBeTruthy();
  });

  it('refuses to resend an expired link instead of emailing a dead one', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const db = makeDb({
      buyers: [{ id: 'buyer1', company_name: 'Acme Legal', email: 'jamie@acmelegal.com' }],
      buyerOnboarding: [{ id: 'ob1', token: 'tok-1', status: 'invited', buyer_id: 'buyer1', created_date: old }],
    });
    const res = await sendOnboardingLink(ctxFor(db, { buyer_id: 'buyer1', link_base: 'https://app.dashflo.io' }, { user: OPERATOR }));
    expect(res.__status).toBe(404);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('rejects a non-operator caller', async () => {
    const buyerUser = { id: 'u2', role: 'user', base_role: 'buyer', linked_buyer_id: 'buyer1' };
    const db = makeDb({
      buyers: [{ id: 'buyer1', company_name: 'Acme Legal', email: 'jamie@acmelegal.com' }],
      buyerOnboarding: [{ id: 'ob1', token: 'tok-1', status: 'invited', buyer_id: 'buyer1' }],
    });
    db.entities.User.get = async () => buyerUser;
    const res = await sendOnboardingLink(ctxFor(db, { buyer_id: 'buyer1', link_base: 'https://app.dashflo.io' }, { user: buyerUser }));
    expect(res.__status).toBe(403);
  });
});

// ── onboardBuyer: GAP-59 (Xero/Stripe must never block) and GAP-57 (vertical
// must survive into the created Buyer) ──────────────────────────────────────

describe('onboardBuyer', () => {
  let server;
  let leadByteBase;
  let requestLog;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requestLog.push({ url: req.url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ buyer_id: 'lb-buyer-1' }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    leadByteBase = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));
  beforeEach(() => { requestLog = []; });

  function leadByteConnector() {
    return {
      id: 'lbc1',
      kind: 'leadbyte',
      is_default: true,
      target_url: `${leadByteBase}/restapi/v1/leads`,
      headers: JSON.stringify([{ key: 'X_KEY', value: 'test-key' }]),
    };
  }

  it('completes a full onboarding run with no Xero/Stripe IntegrationConfig instead of getting stuck at blocked (GAP-59), and carries the vertical onto the created Buyer (GAP-57)', async () => {
    const db = makeDb({
      buyerOnboarding: [{
        id: 'ob1',
        status: 'submitted',
        company_name: 'Acme Legal',
        form_payload: JSON.stringify(FULL_PAYLOAD),
        steps: '[]',
        buyer_id: null,
      }],
      leadByteConnectors: [leadByteConnector()],
      // Deliberately no IntegrationConfig rows at all: Xero, Stripe, GHL are
      // all unconfigured, matching every real buyer today per docs/STATE.md.
      integrationConfigs: [],
    });

    const res = await onboardBuyer(ctxFor(db, { onboarding_id: 'ob1' }, { user: OPERATOR }));

    expect(res.status).toBe('complete');

    const byKey = Object.fromEntries(res.steps.map((s) => [s.key, s]));
    expect(byKey.xero_contact.status).toBe('skipped');
    expect(byKey.stripe_customer.status).toBe('skipped');
    expect(byKey.deposit_invoice.status).toBe('skipped'); // billing_type is invoiced_weekly, not prepay
    expect(byKey.xero_invoice.status).toBe('skipped');
    expect(byKey.payment_link.status).toBe('skipped');
    expect(byKey.delivery_buyer.status).toBe('complete');
    expect(byKey.dispo_scope.status).toBe('skipped');
    expect(byKey.onboarding_email.status).toBe('complete');
    expect(byKey.crm_contact.status).toBe('skipped');
    expect(byKey.schedule_intro_email.status).toBe('complete');

    // No step was ever left 'failed', which is what would have driven the
    // record to status: 'blocked' before the GAP-59 fix.
    expect(res.steps.some((s) => s.status === 'failed')).toBe(false);

    const stored = await db.entities.BuyerOnboarding.get('ob1');
    expect(stored.status).toBe('complete');
    expect(stored.buyer_id).toBeTruthy();

    const buyer = await db.entities.Buyer.get(stored.buyer_id);
    expect(buyer.vertical).toBe('MVA'); // GAP-57: never an empty string
    expect(buyer.company_name).toBe('Acme Legal');
    expect(buyer.status).toBe('draft'); // onboardBuyer never activates a buyer
    expect(requestLog).toHaveLength(1); // the one real delivery_buyer call

    // The completion email fired (default template, since none is configured).
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe('jamie@acmelegal.com');
  });

  it('still attempts the real Xero and Stripe calls when both are actually configured, and does not skip them (no regression to the working path)', async () => {
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const href = typeof input === 'string' ? input : (input && input.url) || String(input);
      if (href.startsWith('https://api.xero.com/api.xro/2.0/Contacts')) {
        return { ok: true, json: async () => ({ Contacts: [{ ContactID: 'xero-contact-1' }] }) };
      }
      if (href.startsWith('https://api.stripe.com/v1/customers')) {
        return { ok: true, json: async () => ({ id: 'cus_test_1' }) };
      }
      return realFetch(input, init);
    });

    try {
      const db = makeDb({
        buyerOnboarding: [{
          id: 'ob2',
          status: 'submitted',
          company_name: 'Acme Legal',
          form_payload: JSON.stringify(FULL_PAYLOAD),
          steps: '[]',
          buyer_id: null,
        }],
        leadByteConnectors: [leadByteConnector()],
        integrationConfigs: [
          { id: 'ic-xero', name: 'xero', config: JSON.stringify({ access_token: 'xero-token', tenant_id: 'tenant-1' }) },
          { id: 'ic-stripe', name: 'stripe', config: JSON.stringify({ secret_key: 'sk_test_123' }) },
        ],
      });

      const res = await onboardBuyer(ctxFor(db, { onboarding_id: 'ob2' }, { user: OPERATOR }));

      const byKey = Object.fromEntries(res.steps.map((s) => [s.key, s]));
      expect(byKey.xero_contact.status).toBe('complete');
      expect(byKey.xero_contact.external_id).toBe('xero-contact-1');
      expect(byKey.stripe_customer.status).toBe('complete');
      expect(byKey.stripe_customer.external_id).toBe('cus_test_1');
      expect(res.status).toBe('complete');

      const stored = await db.entities.BuyerOnboarding.get('ob2');
      const buyer = await db.entities.Buyer.get(stored.buyer_id);
      expect(buyer.xero_contact_id).toBe('xero-contact-1');
      expect(buyer.stripe_customer_id).toBe('cus_test_1');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('blocks and alerts on missing information, and never activates a buyer (missing-information detection + internal alert)', async () => {
    const incomplete = { ...FULL_PAYLOAD, primary_contact_email: '' };
    const db = makeDb({
      buyerOnboarding: [{
        id: 'ob3',
        status: 'submitted',
        company_name: 'Acme Legal',
        form_payload: JSON.stringify(incomplete),
        steps: '[]',
        buyer_id: null,
      }],
      emailTemplates: [{ id: 'tpl-blocked', event: 'blocked', subject: 'Onboarding blocked: {{company_name}}', body: 'Failed step: {{failed_step}}', recipients: JSON.stringify(['ops@dashflo.io']) }],
    });

    const res = await onboardBuyer(ctxFor(db, { onboarding_id: 'ob3' }, { user: OPERATOR }));

    expect(res.status).toBe('blocked');
    const validateStep = res.steps.find((s) => s.key === 'validate');
    expect(validateStep.status).toBe('failed');
    expect(validateStep.error).toContain('email');

    const stored = await db.entities.BuyerOnboarding.get('ob3');
    expect(stored.status).toBe('blocked');
    expect(stored.buyer_id).toBeFalsy(); // create_buyer never ran, so nothing to activate

    expect(sendMail).toHaveBeenCalledTimes(1);
    const [alert] = sendMail.mock.calls[0];
    expect(alert.to).toBe('ops@dashflo.io');
    expect(alert.subject).toContain('Acme Legal');
    expect(alert.text).toContain('validate');
  });
});
