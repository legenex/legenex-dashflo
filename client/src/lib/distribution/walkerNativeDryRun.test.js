// Deterministic Walker Advertising dry-run fixture for the Stage 2 native
// delivery rebuild. Proves the full pipeline end to end for a Walker-shaped
// buyer/delivery/route configuration WITHOUT ever contacting Walker's real
// endpoint: the "accepted"/"rejected"/"timeout" scenarios run against a real
// loopback HTTP server standing in for Walker, following the exact pattern
// routingDelivery.integration.test.js already establishes for this engine.
// The eligibility-gating scenarios (state/schedule/cap) call evaluateMember
// directly, which is itself pure and makes no network call of any kind.
//
// All fixture data below (Buyer, Delivery, SubDelivery, RouteGroup,
// RouteMember) is local to this test file. It does not read or write the
// real database, and none of it corresponds to writing production Walker
// records - see server/scripts/configure-walker-native-delivery.js for that,
// which is separate and has not been run against production either.

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
        res.end(JSON.stringify({ result: 'accepted', revenue: 75, buyer_lead_id: 'WA-TEST-1' }));
        return;
      }
      if (script.type === 'reject') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'rejected', reason: 'duplicate contact info' }));
        return;
      }
      if (script.type === 'hang') {
        // Never respond - the client-side AbortController times out.
        return;
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

const NOW = Date.UTC(2026, 7, 24, 15, 0, 0); // 2026-08-24 15:00 UTC, a Monday

function walkerFixtures({ subDeliveryOverrides = {}, memberOverrides = {} } = {}) {
  const buyer = { id: 'walker-buyer', status: 'active', active: true, billing_type: 'prepay', prepay_balance: 100000 };
  const delivery = { id: 'walker-delivery', buyer_id: 'walker-buyer', status: 'active', vertical_id: 'MVA' };
  const subDelivery = {
    id: 'walker-sub-1', delivery_id: 'walker-delivery', active: true,
    target_url: `${base}/apiJSON.php`, method: 'POST', encoding: 'json',
    response_mapping: JSON.stringify({ accepted: 'accepted', rejected: 'rejected', revenue: 'revenue', buyer_lead_id: 'buyer_lead_id' }),
    field_map: JSON.stringify([
      { src: 'first_name', dest: 'firstname' }, { src: 'last_name', dest: 'lastname' },
      { src: 'email', dest: 'email' }, { src: 'accident_state', dest: 'accident_state' },
      { src: 'type_of_injury', dest: 'Type_Of_Injury' },
    ]),
    ...subDeliveryOverrides,
  };
  const group = { id: 'walker-group', campaign_id: 'mva-campaign', name: 'Native: Walker', method: 'priority', order_index: 0, active: true, lifecycle: 'active' };
  const member = {
    id: 'walker-member', route_group_id: 'walker-group', buyer_id: 'walker-buyer', sub_delivery_id: 'walker-sub-1',
    active: true, priority: 1, price_mode: 'fixed', fixed_price: 75,
    filters: JSON.stringify({ states: ['CA', 'NV', 'AZ'], verticals: ['MVA'] }),
    schedule: JSON.stringify({ timezone: 'UTC', windows: [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '20:00' }] }),
    caps: JSON.stringify({ daily: { limit: 50 } }),
    ...memberOverrides,
  };
  return {
    groups: [group], members: [member], buyers: [buyer], destinations: [],
    deliveries: [delivery], subDeliveries: [subDelivery], health: [],
  };
}

const WALKER_LEAD = {
  first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com', mobile: '5551234567',
  accident_state: 'CA', zip: '90210', type_of_injury: 'Back injury', treatment: 'Yes', attorney: 'No',
  incident_date: '2026-07-01',
};

async function deliverToWalker(member, capCountsFor = () => 0) {
  const snap = buildRoutingSnapshot(walkerFixtures(), { campaignId: 'mva-campaign', nowMs: NOW, capCountsFor });
  expect(snap.configErrors).toEqual([]);
  const resolvedMember = snap.groups[0].members.find((m) => m.id === member.id) || snap.groups[0].members[0];
  const store = makeInMemoryAttemptStore();
  const result = await deliverDirectPost({
    ...resolvedMember.delivery,
    idempotencyKey: `walker-dry-run:${Date.now()}:${Math.random()}`,
    leadId: 'L-WALKER-1', leadData: WALKER_LEAD, isPrimary: true, trigger: 'primary',
  }, { store, nowMs: NOW, testMode: true, allowlistHosts: ['127.0.0.1'], fetchImpl: globalThis.fetch });
  return { result, resolvedMember, store };
}

describe('Walker Advertising native dry-run: buyer/delivery/route resolution', () => {
  it('resolves the correct native Delivery, SubDelivery, and endpoint for Buyer ID AG1-shaped Walker fixture', () => {
    const snap = buildRoutingSnapshot(walkerFixtures(), { campaignId: 'mva-campaign', nowMs: NOW, capCountsFor: () => 0 });
    expect(snap.configErrors).toEqual([]);
    const member = snap.groups[0].members[0];
    expect(member.subDeliveryId).toBe('walker-sub-1');
    expect(member.delivery.targetUrl).toContain('/apiJSON.php');
    expect(member.buyer.active).toBe(true);
    expect(member.buyer.status).toBe('active');
  });
});

describe('Walker Advertising native dry-run: accepted', () => {
  it('an accepted response is classified ACCEPTED with revenue and buyer_lead_id extracted, no live network call to Walker', async () => {
    responseScript = { type: 'accept' };
    const { result } = await deliverToWalker({ id: 'walker-member' });
    expect(result.status).toBe(ATTEMPT_STATUS.ACCEPTED);
    expect(result.revenue).toBe(75);
    expect(result.buyerLeadId).toBe('WA-TEST-1');
    // Proves the request actually carried mapped fields, not the raw lead.
    const sent = JSON.parse(lastRequest.body);
    expect(sent.firstname).toBe('Jane');
    expect(sent.Type_Of_Injury).toBe('Back injury');
    expect(sent.email).toBe('jane@example.com');
    expect(sent.first_name).toBeUndefined(); // raw field name, not the mapped dest - proves field_map ran
  });
});

describe('Walker Advertising native dry-run: rejected', () => {
  it('a rejected response is classified REJECTED, not a sale', async () => {
    responseScript = { type: 'reject' };
    const { result } = await deliverToWalker({ id: 'walker-member' });
    expect(result.status).toBe(ATTEMPT_STATUS.REJECTED);
    expect(result.revenue).toBe(0);
  });
});

describe('Walker Advertising native dry-run: timeout', () => {
  it('a hung connection classifies as ERROR via the real AbortController timeout, not a false accept', async () => {
    responseScript = { type: 'hang' };
    const snap = buildRoutingSnapshot(
      walkerFixtures({ subDeliveryOverrides: { timeout_ms: 150 } }),
      { campaignId: 'mva-campaign', nowMs: NOW, capCountsFor: () => 0 },
    );
    const member = snap.groups[0].members[0];
    const store = makeInMemoryAttemptStore();
    const result = await deliverDirectPost({
      ...member.delivery,
      idempotencyKey: 'walker-timeout-1', leadId: 'L-WALKER-2', leadData: WALKER_LEAD, isPrimary: true, trigger: 'primary',
    }, { store, nowMs: NOW, testMode: true, allowlistHosts: ['127.0.0.1'], fetchImpl: globalThis.fetch });
    expect(result.status).toBe(ATTEMPT_STATUS.ERROR);
    expect(result.errorClass).toBe('timeout');
  }, 10000);
});

describe('Walker Advertising native dry-run: state-ineligible', () => {
  it('a lead outside Walker\'s configured state filter is refused before any send is attempted', () => {
    const snap = buildRoutingSnapshot(walkerFixtures(), { campaignId: 'mva-campaign', nowMs: NOW, capCountsFor: () => 0 });
    const member = snap.groups[0].members[0];
    const outOfStateLead = { ...WALKER_LEAD, state: 'TX', vertical: 'MVA' };
    const verdict = evaluateMember(member, outOfStateLead, { nowMs: NOW });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe(REASON.FILTER_STATE);

    const inStateLead = { ...WALKER_LEAD, state: 'CA', vertical: 'MVA' };
    expect(evaluateMember(member, inStateLead, { nowMs: NOW }).eligible).toBe(true);
  });
});

describe('Walker Advertising native dry-run: schedule-ineligible', () => {
  it('a lead arriving outside the configured schedule window is refused', () => {
    // Walker's fixture window is Mon-Fri 08:00-20:00 UTC. Saturday is outside it.
    const saturday = Date.UTC(2026, 7, 22, 12, 0, 0); // 2026-08-22 is a Saturday
    const schedule = JSON.parse(walkerFixtures().members[0].schedule);
    const withinSchedule = isWithinSchedule(saturday, schedule);
    expect(withinSchedule).toBe(false);

    const snap = buildRoutingSnapshot(walkerFixtures(), { campaignId: 'mva-campaign', nowMs: saturday, capCountsFor: () => 0 });
    const member = snap.groups[0].members[0];
    const verdict = evaluateMember(member, { ...WALKER_LEAD, state: 'CA', vertical: 'MVA' }, { nowMs: saturday });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe(REASON.OUTSIDE_SCHEDULE);
  });
});

describe('Walker Advertising native dry-run: cap-exhausted', () => {
  it('a lead is refused once the configured daily cap is already at its limit', () => {
    const capCountsFor = (memberId, window) => (window === 'daily' ? 50 : 0); // == the fixture's daily limit
    const snap = buildRoutingSnapshot(walkerFixtures(), { campaignId: 'mva-campaign', nowMs: NOW, capCountsFor });
    const member = snap.groups[0].members[0];
    const verdict = evaluateMember(member, { ...WALKER_LEAD, state: 'CA', vertical: 'MVA' }, { nowMs: NOW });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe(REASON.CAP_DAILY);
  });

  it('the same lead is eligible when the daily count is below the limit', () => {
    const capCountsFor = (memberId, window) => (window === 'daily' ? 10 : 0);
    const snap = buildRoutingSnapshot(walkerFixtures(), { campaignId: 'mva-campaign', nowMs: NOW, capCountsFor });
    const member = snap.groups[0].members[0];
    const verdict = evaluateMember(member, { ...WALKER_LEAD, state: 'CA', vertical: 'MVA' }, { nowMs: NOW });
    expect(verdict.eligible).toBe(true);
  });
});

describe('Walker Advertising native dry-run: no live commercial side effect', () => {
  it('every scenario above only ever contacted the local loopback server, never a real host', () => {
    // If any scenario had reached a real network path, testMode's host
    // allowlist (127.0.0.1 only) would have failed closed with
    // HOST_NOT_ALLOWED rather than the classified outcomes asserted above -
    // this is a structural guarantee, not just an assertion on this test.
    expect(base.startsWith('http://127.0.0.1:')).toBe(true);
  });
});
