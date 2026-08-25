import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import campaignDeliveryTest from '../src/functions/campaignDeliveryTest.js';

const OPERATOR = { id: 'u1', role: 'admin', base_role: 'operator' };

function makeDb({ distributionMode = 'new_only', sub = null, delivery = null } = {}) {
  const audits = [];
  const attempts = [];
  return {
    audits, attempts,
    entities: {
      User: { get: async () => OPERATOR },
      AppSettings: { list: async () => [{ distribution_mode: distributionMode }] },
      SubDelivery: { get: async (id) => (sub && sub.id === id ? sub : null) },
      Delivery: { get: async (id) => (delivery && delivery.id === id ? delivery : null) },
      DistributionAudit: { create: async (rec) => { audits.push(rec); return rec; } },
      DeliveryAttempt: {
        async create(rec) { const row = { ...rec, id: 'a' + (attempts.length + 1) }; attempts.push(row); return row; },
        async update(id, patch) { const a = attempts.find((x) => x.id === id); Object.assign(a, patch); return a; },
      },
      IntegrationConfig: { async filter() { return []; } },
    },
  };
}

function ctxFor(db, body) {
  return { user: OPERATOR, db, body, json: (data, status = 200) => ({ __status: status, ...data }) };
}

describe('campaignDeliveryTest: gates', () => {
  it('refuses while distribution_mode is legacy_only', async () => {
    const db = makeDb({ distributionMode: 'legacy_only' });
    const res = await campaignDeliveryTest(ctxFor(db, { sub_delivery_id: 'sd1', confirm: true }));
    expect(res.__status).toBe(409);
  });

  it('requires explicit confirm:true', async () => {
    const db = makeDb();
    const res = await campaignDeliveryTest(ctxFor(db, { sub_delivery_id: 'sd1' }));
    expect(res.__status).toBe(428);
  });

  it('403s a non-operator', async () => {
    const buyerUser = { id: 'u2', role: 'user', base_role: 'buyer', linked_buyer_id: 'b1' };
    const db = makeDb();
    db.entities.User.get = async () => buyerUser;
    const res = await campaignDeliveryTest({ user: buyerUser, db, body: { sub_delivery_id: 'sd1', confirm: true }, json: (d, s = 200) => ({ __status: s, ...d }) });
    expect(res.__status).toBe(403);
  });

  it('404s an unknown sub_delivery_id', async () => {
    const db = makeDb();
    const res = await campaignDeliveryTest(ctxFor(db, { sub_delivery_id: 'missing', confirm: true }));
    expect(res.__status).toBe(404);
  });
});

describe('campaignDeliveryTest: real send path', () => {
  let server; let base; let requestLog;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requestLog.push({ url: req.url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'accepted' }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  beforeEach(() => { requestLog = []; });

  // Regression: engine.makeDbAttemptStore does not exist anywhere in the
  // generated engine bundle (the real export is makeEntityAttemptStore).
  // Since db.entities.DeliveryAttempt always exists in a real deployment,
  // this made every live delivery test throw and return a 500 - completely
  // untested until this file, which is exactly how it went unnoticed.
  it('does not throw when DeliveryAttempt exists on the db (the store-name regression)', async () => {
    // target_url is a real local server, but 127.0.0.1 is loopback and
    // correctly SSRF-blocked for this real (non-test-mode) send - that part
    // is proven by the dedicated SSRF test below. What THIS test proves is
    // narrower and was the actual bug: does constructing and using the
    // attempt store throw at all? failClosed() (the SSRF-refusal path)
    // still calls ctx.store.createAttempt(...), so if the store were
    // undefined (the makeDbAttemptStore regression), this would throw
    // regardless of the SSRF outcome.
    const sub = { id: 'sd1', delivery_id: 'del1', target_url: `${base}/post`, method: 'POST', encoding: 'json', response_mapping: JSON.stringify({ accepted: 'accepted' }) };
    const delivery = { id: 'del1', buyer_id: 'buyer1', status: 'active' };
    const db = makeDb({ sub, delivery });
    const res = await campaignDeliveryTest(ctxFor(db, { sub_delivery_id: 'sd1', confirm: true, sample_lead: { email: 'a@b.com' } }));
    expect(res.ok).toBe(true); // did not crash/500
    expect(db.attempts).toHaveLength(1); // persisted through the real (correct) store, not silently dropped
  });

  it('writes the audit record before sending', async () => {
    const sub = { id: 'sd1', delivery_id: 'del1', target_url: `${base}/post`, method: 'POST', encoding: 'json', response_mapping: JSON.stringify({ accepted: 'accepted' }) };
    const delivery = { id: 'del1', buyer_id: 'buyer1', status: 'active' };
    const db = makeDb({ sub, delivery });
    await campaignDeliveryTest(ctxFor(db, { sub_delivery_id: 'sd1', confirm: true }));
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0].action).toBe('delivery_live_test');
  });

  // Regression: an adversarial review found this was the one real send path
  // with NO SSRF guard at all - an operator-editable target_url could be
  // pointed at an internal host or the cloud metadata endpoint and reached
  // through this confirmed-test function with zero validation.
  it('refuses a real send to a private-network target_url via the SSRF guard', async () => {
    const sub = { id: 'sd1', delivery_id: 'del1', target_url: 'http://169.254.169.254/latest/meta-data', method: 'POST', encoding: 'json' };
    const delivery = { id: 'del1', buyer_id: 'buyer1', status: 'active' };
    const db = makeDb({ sub, delivery });
    const res = await campaignDeliveryTest(ctxFor(db, { sub_delivery_id: 'sd1', confirm: true }));
    expect(res.ok).toBe(true); // the function itself succeeds; the SEND is refused
    expect(res.result.status).toBe('error');
    expect(requestLog).toHaveLength(0); // never actually contacted the metadata endpoint
  });
});
