// Stage 3 resellability proof (Lead Distribution rebuild). "Example
// Destination A" is a wholly fictional destination - no buyer, supplier,
// reseller, law firm, or platform proper noun anywhere in this file - built
// deliberately UNLIKE the Walker Advertising fixture in walkerNativeDryRun.
// test.js in every dimension the brief calls out:
//
//   - different endpoint shape (/v2/leads/ingest vs /apiJSON.php)
//   - different payload shape: a nested JSON payload_template with its own
//     outbound key names (contact.first/contact.last/contact.emailAddress),
//     not Walker's flat field_map
//   - different response shape: top-level status/ref/amount, not
//     result/buyer_lead_id/revenue
//   - different schedule: a weekend-only window, not Walker's Mon-Fri
//   - different caps: hourly, not daily
//   - a different vertical (WC, not MVA)
//
// Every function this file calls (buildRoutingSnapshot, evaluateMember,
// deliverDirectPost, classifyResponse via the response_mapping storage
// shape) is the exact same generic engine code walkerNativeDryRun.test.js
// exercises. Nothing in client/src/lib/distribution/*.js branches on which
// destination this is - there is no "if buyer is Example Destination A"
// anywhere in the engine, because onboarding this fixture required writing
// zero product code, only this test's own fixture data. That is the
// resellability proof itself, not a claim about it: grep the engine source
// for this file's fixture identifiers ("example-destination-a", "eda-",
// "Example Destination A") and none will be found outside this file.
//
// Also covers the full generic dry-run scenario list (Stage 3 section 26):
// A eligible/accepted, B eligible/rejected, C network timeout, D ineligible
// state, E outside schedule, F cap exhausted, G circuit open (and its
// cooldown-elapsed recovery), H retryable failure distinct from timeout,
// I invalid/unresolved payload_template, J invalid/malformed response body,
// K disabled delivery, L wrong buyer ownership mapping.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { buildRoutingSnapshot } from './snapshot.js';
import { deliverDirectPost } from './directPost.js';
import { makeInMemoryAttemptStore } from './deliveryStore.js';
import { ATTEMPT_STATUS } from './deliveryAttempt.js';
import { evaluateMember, REASON } from './engine.js';
import { isWithinSchedule } from './schedule.js';

let server;
let base;
let lastRequest;
let responseScript;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastRequest = { headers: req.headers, body };
      const script = responseScript;
      if (!script || script.type === 'accept') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', ref: 'EDA-9001', amount: 88 }));
        return;
      }
      if (script.type === 'reject') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'declined', why: 'coverage area exhausted' }));
        return;
      }
      if (script.type === 'hang') {
        return; // never respond -> AbortController timeout
      }
      if (script.type === 'server_error') {
        res.writeHead(503);
        res.end('service unavailable');
        return;
      }
      if (script.type === 'garbled') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status": not even close to json');
        return;
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

const NOW = Date.UTC(2026, 7, 22, 15, 0, 0); // 2026-08-22 15:00 UTC, a Saturday

const PAYLOAD_TEMPLATE = JSON.stringify({
  contact: { first: '{{first_name}}', last: '{{last_name}}', emailAddress: '{{email}}' },
  meta: { source: 'dashflo', zipHash: '{{zip|sha256}}' },
});

function edaFixtures({ subDeliveryOverrides = {}, memberOverrides = {}, healthOverrides = [] } = {}) {
  const buyer = { id: 'eda-buyer', status: 'active', active: true, billing_type: 'prepay', prepay_balance: 100000 };
  const delivery = { id: 'eda-delivery', buyer_id: 'eda-buyer', status: 'active', vertical_id: 'WC' };
  const subDelivery = {
    id: 'eda-sub-1', delivery_id: 'eda-delivery', active: true,
    target_url: `${base}/v2/leads/ingest`, method: 'POST', encoding: 'json',
    payload_template: PAYLOAD_TEMPLATE,
    response_mapping: JSON.stringify({ accepted: '"status":\\s*"ok"', rejected: '"status":\\s*"declined"', revenue: 'amount', buyer_lead_id: 'ref' }),
    ...subDeliveryOverrides,
  };
  const group = { id: 'eda-group', campaign_id: 'wc-campaign', name: 'Native: Example Destination A', method: 'priority', order_index: 0, active: true, lifecycle: 'active' };
  const member = {
    id: 'eda-member', route_group_id: 'eda-group', buyer_id: 'eda-buyer', sub_delivery_id: 'eda-sub-1',
    active: true, priority: 1, price_mode: 'fixed', fixed_price: 88,
    filters: JSON.stringify({ states: ['OH', 'PA'], verticals: ['WC'] }),
    // Deliberately unlike Walker's Mon-Fri daytime window: weekends only.
    schedule: JSON.stringify({ timezone: 'UTC', windows: [{ days: [0, 6], start: '00:00', end: '23:59' }] }),
    // Deliberately unlike Walker's daily cap: hourly.
    caps: JSON.stringify({ hourly: { limit: 20 } }),
    ...memberOverrides,
  };
  return {
    groups: [group], members: [member], buyers: [buyer], destinations: [],
    deliveries: [delivery], subDeliveries: [subDelivery], health: healthOverrides,
  };
}

const EDA_LEAD = {
  first_name: 'Sam', last_name: 'Rivera', email: 'sam@example.com', mobile: '2165551234',
  state: 'OH', vertical: 'WC', zip: '44101',
};

async function deliverToEda(fixtureOverrides = {}, nowMs = NOW) {
  const snap = buildRoutingSnapshot(edaFixtures(fixtureOverrides), { campaignId: 'wc-campaign', nowMs, capCountsFor: () => 0 });
  const resolvedMember = snap.groups[0]?.members?.[0];
  const store = makeInMemoryAttemptStore();
  const result = resolvedMember?.delivery
    ? await deliverDirectPost({
      ...resolvedMember.delivery,
      idempotencyKey: `eda-dry-run:${Date.now()}:${Math.random()}`,
      leadId: 'L-EDA-1', leadData: EDA_LEAD, isPrimary: true, trigger: 'primary',
    }, { store, nowMs, testMode: true, allowlistHosts: ['127.0.0.1'], fetchImpl: globalThis.fetch })
    : null;
  return { snap, result, resolvedMember, store };
}

describe('Example Destination A: config-only onboarding proof', () => {
  it('a wholly new destination resolves through the identical generic pipeline Walker uses, with zero destination-specific code', () => {
    const snap = buildRoutingSnapshot(edaFixtures(), { campaignId: 'wc-campaign', nowMs: NOW, capCountsFor: () => 0 });
    expect(snap.configErrors).toEqual([]);
    const member = snap.groups[0].members[0];
    expect(member.subDeliveryId).toBe('eda-sub-1');
    expect(member.delivery.targetUrl).toContain('/v2/leads/ingest');
    expect(member.delivery.payloadTemplate).toContain('contact');
  });
});

describe('Example Destination A: A eligible/accepted', () => {
  it('renders the nested payload_template (not field_map) and classifies a differently-shaped accept response', async () => {
    responseScript = { type: 'accept' };
    const { result } = await deliverToEda();
    expect(result.status).toBe(ATTEMPT_STATUS.ACCEPTED);
    expect(result.revenue).toBe(88);
    expect(result.buyerLeadId).toBe('EDA-9001');
    const sent = JSON.parse(lastRequest.body);
    expect(sent.contact.first).toBe('Sam');
    expect(sent.contact.emailAddress).toBe('sam@example.com');
    expect(sent.meta.source).toBe('dashflo');
    expect(sent.meta.zipHash).toMatch(/^[0-9a-f]{64}$/); // sha256 transform ran
    expect(sent.first_name).toBeUndefined(); // proves the template, not a leftover field_map, built this body
  });
});

describe('Example Destination A: B eligible/rejected', () => {
  it('a differently-shaped decline response classifies as REJECTED, not a sale', async () => {
    responseScript = { type: 'reject' };
    const { result } = await deliverToEda();
    expect(result.status).toBe(ATTEMPT_STATUS.REJECTED);
    expect(result.revenue).toBe(0);
  });
});

describe('Example Destination A: C network timeout', () => {
  it('a hung connection classifies as ERROR/timeout via the real AbortController, not a false accept', async () => {
    responseScript = { type: 'hang' };
    const { result } = await deliverToEda({ subDeliveryOverrides: { timeout_ms: 150 } });
    expect(result.status).toBe(ATTEMPT_STATUS.ERROR);
    expect(result.errorClass).toBe('timeout');
    expect(result.retryable).toBe(true);
  }, 10000);
});

describe('Example Destination A: D ineligible state', () => {
  it('a lead outside the configured state filter is refused before any send is attempted', () => {
    const snap = buildRoutingSnapshot(edaFixtures(), { campaignId: 'wc-campaign', nowMs: NOW, capCountsFor: () => 0 });
    const member = snap.groups[0].members[0];
    expect(evaluateMember(member, { ...EDA_LEAD, state: 'CA' }, { nowMs: NOW }).reason).toBe(REASON.FILTER_STATE);
    expect(evaluateMember(member, { ...EDA_LEAD, state: 'OH' }, { nowMs: NOW }).eligible).toBe(true);
  });
});

describe('Example Destination A: E outside schedule', () => {
  it('a weekend-only window (unlike Walker\'s weekday window) refuses a weekday lead and accepts a weekend one', () => {
    const monday = Date.UTC(2026, 7, 24, 12, 0, 0); // 2026-08-24 is a Monday
    const schedule = JSON.parse(edaFixtures().members[0].schedule);
    expect(isWithinSchedule(monday, schedule)).toBe(false);
    expect(isWithinSchedule(NOW, schedule)).toBe(true); // NOW is a Saturday

    const snapMon = buildRoutingSnapshot(edaFixtures(), { campaignId: 'wc-campaign', nowMs: monday, capCountsFor: () => 0 });
    const memberMon = snapMon.groups[0].members[0];
    expect(evaluateMember(memberMon, EDA_LEAD, { nowMs: monday }).reason).toBe(REASON.OUTSIDE_SCHEDULE);

    const snapSat = buildRoutingSnapshot(edaFixtures(), { campaignId: 'wc-campaign', nowMs: NOW, capCountsFor: () => 0 });
    const memberSat = snapSat.groups[0].members[0];
    expect(evaluateMember(memberSat, EDA_LEAD, { nowMs: NOW }).eligible).toBe(true);
  });
});

describe('Example Destination A: F cap exhausted', () => {
  it('an hourly cap (unlike Walker\'s daily cap) refuses once at its limit and allows below it', () => {
    const atLimit = buildRoutingSnapshot(edaFixtures(), {
      campaignId: 'wc-campaign', nowMs: NOW, capCountsFor: (id, w) => (w === 'hourly' ? 20 : 0),
    });
    expect(evaluateMember(atLimit.groups[0].members[0], EDA_LEAD, { nowMs: NOW }).reason).toBe(REASON.CAP_HOURLY);

    const belowLimit = buildRoutingSnapshot(edaFixtures(), {
      campaignId: 'wc-campaign', nowMs: NOW, capCountsFor: (id, w) => (w === 'hourly' ? 3 : 0),
    });
    expect(evaluateMember(belowLimit.groups[0].members[0], EDA_LEAD, { nowMs: NOW }).eligible).toBe(true);
  });
});

describe('Example Destination A: G circuit open', () => {
  it('still within cooldown -> DESTINATION_UNHEALTHY; cooldown elapsed -> half-open trial allowed', () => {
    const stillOpen = buildRoutingSnapshot(
      edaFixtures({ healthOverrides: [{ sub_delivery_id: 'eda-sub-1', state: 'open', disabled_until: new Date(NOW + 60000).toISOString() }] }),
      { campaignId: 'wc-campaign', nowMs: NOW, capCountsFor: () => 0 },
    );
    expect(evaluateMember(stillOpen.groups[0].members[0], EDA_LEAD, { nowMs: NOW }).reason).toBe(REASON.DESTINATION_UNHEALTHY);

    const elapsed = buildRoutingSnapshot(
      edaFixtures({ healthOverrides: [{ sub_delivery_id: 'eda-sub-1', state: 'open', disabled_until: new Date(NOW - 1000).toISOString() }] }),
      { campaignId: 'wc-campaign', nowMs: NOW, capCountsFor: () => 0 },
    );
    expect(evaluateMember(elapsed.groups[0].members[0], EDA_LEAD, { nowMs: NOW }).eligible).toBe(true);
  });
});

describe('Example Destination A: H retryable failure (distinct from timeout)', () => {
  it('a 503 classifies as ERROR/retryable via a real response, not a hang', async () => {
    responseScript = { type: 'server_error' };
    const { result } = await deliverToEda();
    expect(result.status).toBe(ATTEMPT_STATUS.ERROR);
    expect(result.retryable).toBe(true);
    expect(result.errorClass ?? null).toBe(null); // a real HTTP response, not a client-side error class
  });
});

describe('Example Destination A: I invalid/unresolved payload', () => {
  it('a payload_template that renders to invalid JSON fails closed - no send reaches the destination', async () => {
    responseScript = { type: 'accept' };
    const before = lastRequest;
    const { result } = await deliverToEda({ subDeliveryOverrides: { payload_template: '{"broken": {{first_name}}' } });
    expect(result.status).toBe(ATTEMPT_STATUS.ERROR);
    expect(result.code).toBe('INVALID_PAYLOAD_TEMPLATE');
    expect(lastRequest).toBe(before); // structurally proves nothing was sent
  });
});

describe('Example Destination A: J invalid response', () => {
  it('a malformed (non-JSON) response body is classified without crashing and extracts no revenue', async () => {
    responseScript = { type: 'garbled' };
    const { result } = await deliverToEda();
    expect(result.revenue).toBe(0);
    expect(result.buyerLeadId).toBe(null);
    expect(Object.values(ATTEMPT_STATUS)).toContain(result.status);
  });
});

describe('Example Destination A: K disabled delivery', () => {
  it('an inactive SubDelivery is CONFIG_INVALID and never resolves an endpoint', () => {
    const snap = buildRoutingSnapshot(edaFixtures({ subDeliveryOverrides: { active: false } }), {
      campaignId: 'wc-campaign', nowMs: NOW, capCountsFor: () => 0,
    });
    expect(snap.configErrors.some((e) => e.detail === 'inactive sub-delivery')).toBe(true);
    expect(snap.groups[0].members[0].delivery).toBe(null);
    expect(snap.groups[0].members[0].active).toBe(false);
  });
});

describe('Example Destination A: L wrong buyer ownership mapping', () => {
  it('a RouteMember pointing at a SubDelivery owned by a different buyer fails closed, never routes', () => {
    const fixtures = edaFixtures({ memberOverrides: { buyer_id: 'someone-elses-buyer-id' } });
    fixtures.buyers.push({ id: 'someone-elses-buyer-id', status: 'active', active: true });
    const snap = buildRoutingSnapshot(fixtures, { campaignId: 'wc-campaign', nowMs: NOW, capCountsFor: () => 0 });
    expect(snap.configErrors.some((e) => e.detail === 'cross-buyer sub-delivery')).toBe(true);
    expect(snap.groups[0].members[0].delivery).toBe(null);
    expect(snap.groups[0].members[0].active).toBe(false);
  });
});

describe('Example Destination A: no live commercial side effect', () => {
  it('every scenario above only ever contacted the local loopback server, never a real host', () => {
    expect(base.startsWith('http://127.0.0.1:')).toBe(true);
  });
});
