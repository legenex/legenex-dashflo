// Shared, framework-agnostic builders for the W6-FIXTURES adversarial lead
// fixtures. This module holds only DATA SHAPES (synthetic lead base, member
// snapshot builder) - no vitest imports, no assertions, no HTTP server. The
// server lifecycle and every assertion live in fixtureOutcomes.test.js; the
// individual fixture files under this directory own their own scenario data.
//
// Synthetic-data convention: reused verbatim from server/scripts/native-
// delivery-dry-run.js's own SYNTHETIC_LEAD (RFC 2606 .test email domain,
// NANP 555-01XX reserved fictional phone numbers, no real name, no real PII).
// Every fixture in this directory builds on this same base and only overrides
// the fields its scenario actually needs to vary, so accidental real-looking
// data never sneaks in through a fixture-specific override.

export const SYNTHETIC_BASE_LEAD = {
  first_name: 'Synthetic', last_name: 'Fixture', email: 'synthetic.fixture@example.test',
  mobile: '5555550100', accident_state: 'CA', state: 'CA', zip: '90210', vertical: 'MVA',
  type_of_injury: 'Back injury', treatment: 'Yes', attorney: 'No',
  incident_date: '2026-07-01', accident_date: '2026-07-01', ip_address: '203.0.113.10',
  trustedform_url: 'https://cert.trustedform.com/' + '0'.repeat(40),
};

// Builds a route-member snapshot in the exact shape evaluateMember/
// distributeLead consume (member.buyer/.filters/.caps/.wallet/.health/
// .delivery - see distributeRun.test.js's own member() helper, which this
// mirrors). Every id-shaped field gets a realistic opaque value distinct from
// any human-readable code field on the same fixture (buyer_id/route_member_id/
// destination_id/sub_delivery_id are never the same literal string as a
// vertical or state CODE) - the exact class of collapse that hid the real
// campaign_id/vertical_id routing bug documented in docs/STATE.md.
export function buildMember(id, overrides = {}) {
  const {
    buyerId = `buyer_${id}`,
    priority = 1,
    price = 50,
    filters = {},
    conditions = null,
    caps = {},
    buyer = { status: 'active', active: true },
    wallet = null,
    health = { state: 'closed', blocked: false },
    withinSchedule,
    active = true,
    suppression = null,
    delivery = null,
  } = overrides;
  const member = {
    id, buyerId, active, priority, weight: 1,
    priceMode: 'fixed', fixedPrice: price, price,
    filters, conditions, caps, buyer, wallet, health, suppression,
    subDeliveryId: `sd_${id}`, destinationId: `dest_${id}`,
  };
  if (withinSchedule !== undefined) member.withinSchedule = withinSchedule;
  if (delivery) {
    member.delivery = {
      subDeliveryId: member.subDeliveryId,
      method: 'POST', encoding: 'json', headers: {}, credentialRef: null,
      fieldMap: [{ src: 'email', dest: 'email' }],
      responseMapping: {
        accept: 'accepted', reject: 'declined', duplicate: 'duplicate',
        requireAccept: true, revenuePath: 'price', leadIdPath: 'buyer_lead_id',
      },
      timeoutMs: 5000,
      ...delivery,
    };
  }
  return member;
}

export function buildGroup(id, members, overrides = {}) {
  return { id, method: 'priority', active: true, orderIndex: 0, members, ...overrides };
}

// Minimal db double: runDistribution only ever writes RouteDecisionTrace.
export function makeTraceDb() {
  const traces = [];
  return { traces, entities: { RouteDecisionTrace: { create: async (r) => { traces.push(r); return r; } } } };
}
