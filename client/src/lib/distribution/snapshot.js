// Canonical routing-snapshot builder. Converts persisted snake_case the backend
// records into the EXACT camelCase engine input model. This is the ONE mapper
// (PB-005): no other component may build engine inputs. Pure and testable; the
// backend loader fetches records and calls buildRoutingSnapshot.
//
// Enforces:
// - PB-002: join the real Buyer for lifecycle; fail closed on missing/contradictory.
// - PB-003: a group participates only when active===true AND lifecycle==='active'
//   AND it belongs to the resolved campaign (published-version gating via configVersionId).
// - PB-017: strict config parsing. Invalid JSON / unknown operators / missing
//   referenced buyer or destination / invalid schedule|caps|pricing produce
//   CONFIG_INVALID and make the member INELIGIBLE. Invalid config never broadens.

import { OPERATORS } from './conditions.js';
import { isWithinSchedule } from './schedule.js';
import { resolveSubDeliveryCfg } from './deliveryResolve.js';
import { isBlocked } from './destinationHealth.js';

const KNOWN_OPS = new Set(OPERATORS);

function strictJson(raw, onError) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { onError(); return null; }
}

// Validate a condition tree only uses known operators. Returns true if valid.
function validConditionTree(node) {
  if (!node) return true;
  if (Array.isArray(node)) return node.every(validConditionTree);
  if (node.op === 'and' || node.op === 'or') return (node.children || []).every(validConditionTree);
  if (node.field && node.operator) return KNOWN_OPS.has(node.operator);
  return false; // unknown shape
}

// Number(null) is 0 in plain JS, not NaN, so a naive Number()+isFinite() guard
// would silently turn an absent/null value (no price configured, no reserve
// configured, no cap limit configured) into a real 0 instead of "missing".
// For fixed_price specifically that is a real pricing bug, not a cosmetic
// one: a fixed-price member with no price set would resolve to price 0 (a
// free lead) instead of failing CONFIG_INVALID as PB-017 requires. Treat
// null/undefined as absent explicitly, before the numeric coercion.
function num(v) { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

// Map a caps config {daily:{limit}} merged with current counts from capCounters.
// capCountsFor(memberId, window) -> current count number.
export function buildCaps(capsCfg, memberId, capCountsFor, onError) {
  if (capsCfg == null || capsCfg === '') return {};
  const parsed = strictJson(capsCfg, onError);
  if (parsed === null) return null; // invalid
  const out = {};
  for (const w of ['total', 'hourly', 'daily', 'weekly', 'monthly']) {
    if (parsed[w] == null) continue;
    const limit = num(typeof parsed[w] === 'object' ? parsed[w].limit : parsed[w]);
    if (limit == null || limit < 0) { onError(); return null; }
    out[w] = { limit, count: Number(capCountsFor(memberId, w) || 0) };
  }
  return out;
}

// Balance enforcement is OPT-IN (approved 12 Aug 2026). A buyer is blocked on
// money ONLY when an explicit positive credit_limit is set on the Buyer record.
// With no credit_limit the lead is delivered and billed downstream, so an
// unfunded prepay balance never silently stops distribution. The ledger still
// records the movement either way; enforce controls blocking, not accounting.
export function buildWallet(buyer) {
  if (!buyer) return null;
  const mode = String(buyer.billing_type || buyer.billing_mode || '').toLowerCase().startsWith('prepay')
    ? 'prepaid' : (String(buyer.billing_type || '').toLowerCase().startsWith('invoice') ? 'postpaid' : null);
  if (!mode) return null;
  const creditLimit = num(buyer.credit_limit);
  const enforce = creditLimit != null && creditLimit > 0;
  if (mode === 'prepaid') {
    return {
      mode, enforce, creditLimit,
      balance: num(buyer.prepay_balance ?? buyer.balance) ?? 0,
      minBalance: num(buyer.min_balance) ?? 0,
    };
  }
  return { mode, enforce, outstanding: num(buyer.outstanding) ?? 0, creditLimit };
}

// Main builder. Inputs are already-fetched arrays/maps (loader does the reads).
// ctx: { campaignId, nowMs, capCountsFor(memberId, window), configVersionId }
export function buildRoutingSnapshot(records, ctx = {}) {
  const { campaignId, configVersionId, leadState } = ctx;
  const capCountsFor = ctx.capCountsFor || (() => 0);
  const stateCplFor = ctx.stateCplFor || (() => null);
  const buyersById = indexBy(records.buyers, 'id');
  const destById = indexBy(records.destinations, 'id');
  const subDeliveriesById = indexBy(records.subDeliveries, 'id');
  const deliveriesById = indexBy(records.deliveries, 'id');
  const healthByDest = indexBy(records.health, 'destination_id');
  const healthBySubDelivery = indexBy(records.health, 'sub_delivery_id');
  const configErrors = [];

  const groups = (records.groups || [])
    // PB-003: only active + lifecycle active + this campaign + published version.
    .filter((g) => g.active === true
      && String(g.lifecycle || '').toLowerCase() === 'active'
      && String(g.campaign_id) === String(campaignId)
      && (!configVersionId || String(g.config_version_id || '') === String(configVersionId)))
    .sort((a, b) => (a.order_index || 0) - (b.order_index || 0))
    .map((g) => ({
      id: g.id,
      orderIndex: g.order_index || 0,
      method: g.method || 'priority',
      configHash: g.config_hash || null,
      weights: { price: num(g.price_weight) ?? 0.5, priority: num(g.priority_weight) ?? 0.5 },
      members: (records.members || [])
        .filter((m) => String(m.route_group_id) === String(g.id))
        .sort((a, b) => (a.priority || 0) - (b.priority || 0))
        .map((m) => buildMember(m, {
          buyersById, destById, subDeliveriesById, deliveriesById, healthByDest, healthBySubDelivery,
          capCountsFor, configErrors, nowMs: ctx.nowMs, leadState, stateCplFor,
        })),
    }));

  return { groups, configVersionId: configVersionId || null, configErrors, configHash: hashConfig(records) };
}

// Resolve a member's canonical endpoint. Prefers sub_delivery_id (fail-closed);
// falls back to the DEPRECATED destination_id only for legacy members that carry
// no sub_delivery_id. Returns { subDeliveryId, delivery, healthKey } or marks invalid.
function resolveEndpoint(m, { destById, subDeliveriesById, deliveriesById, err }) {
  if (m.sub_delivery_id) {
    const sd = subDeliveriesById[m.sub_delivery_id];
    if (!sd) { err('CONFIG_INVALID', 'missing sub-delivery'); return null; }
    if (sd.active === false) { err('CONFIG_INVALID', 'inactive sub-delivery'); return null; }
    const del = deliveriesById[sd.delivery_id];
    if (!del) { err('CONFIG_INVALID', 'missing parent delivery'); return null; }
    if (String(del.status) !== 'active') { err('CONFIG_INVALID', 'parent delivery not active'); return null; }
    // Fail closed: a sub-delivery whose parent Delivery belongs to a different
    // buyer than the member must NEVER route.
    if (String(del.buyer_id) !== String(m.buyer_id)) { err('CONFIG_INVALID', 'cross-buyer sub-delivery'); return null; }
    if (!sd.target_url) { err('CONFIG_INVALID', 'sub-delivery missing target_url'); return null; }
    return { subDeliveryId: sd.id, delivery: resolveSubDeliveryCfg(sd), healthKey: sd.id, kind: 'sub_delivery' };
  }
  // Legacy deprecated path: an existing member with only destination_id.
  if (m.destination_id && destById[m.destination_id]) {
    return { subDeliveryId: null, delivery: null, healthKey: m.destination_id, kind: 'legacy' };
  }
  err('CONFIG_INVALID', m.destination_id ? 'missing destination' : 'missing sub_delivery_id');
  return null;
}

function buildMember(m, { buyersById, destById, subDeliveriesById, deliveriesById, healthByDest, healthBySubDelivery, capCountsFor, configErrors, nowMs, leadState, stateCplFor }) {
  let invalid = false;
  const err = (code, detail) => { invalid = true; configErrors.push({ member_id: m.id, code: code || 'CONFIG_INVALID', detail }); };

  const buyer = buyersById[m.buyer_id];
  if (!buyer) err('CONFIG_INVALID', 'missing buyer');
  const endpoint = resolveEndpoint(m, { destById, subDeliveriesById, deliveriesById, err });

  const filters = strictJson(m.filters, () => err('CONFIG_INVALID', 'bad filters json'));
  const conditions = strictJson(m.conditions, () => err('CONFIG_INVALID', 'bad conditions json'));
  const hasConditions = conditions && typeof conditions === 'object' && Object.keys(conditions).length > 0;
  if (hasConditions && !validConditionTree(conditions)) err('CONFIG_INVALID', 'unknown condition operator');
  const schedule = strictJson(m.schedule, () => err('CONFIG_INVALID', 'bad schedule json'));
  const caps = buildCaps(m.caps, m.id, capCountsFor, () => err('CONFIG_INVALID', 'bad caps'));

  const priceMode = ['fixed', 'rule', 'auction'].includes(m.price_mode) ? m.price_mode : 'fixed';
  const reservePrice = num(m.reserve_price);
  let fixedPrice = num(m.fixed_price);
  if (priceMode === 'fixed' && (fixedPrice == null || fixedPrice < 0)) err('CONFIG_INVALID', 'invalid price');
  // 'rule' mode resolves price from BuyerStateCpl (lead state -> buyer's
  // active per-state price), not a value stored on the member itself. Price
  // is inherently lead-dependent, so it is resolved here ONLY when a
  // specific lead's state was actually supplied (leadState !== undefined -
  // a real routing evaluation, runDistribution). A structural build with no
  // lead in view (publish validation, the simulator run without one) leaves
  // price unresolved rather than wrongly failing every rule-mode member
  // closed; validateConfigForPublish checks buyer coverage existence
  // separately instead (see configPublish.js).
  if (priceMode === 'rule' && leadState !== undefined) {
    const rulePrice = num(stateCplFor(m.buyer_id, leadState));
    if (rulePrice == null || rulePrice < 0) err('CONFIG_INVALID', 'no active BuyerStateCpl price for this buyer/state');
    fixedPrice = rulePrice;
  }

  // PB-002: real buyer lifecycle snapshot; fail closed when missing.
  const buyerSnap = buyer
    ? { active: buyer.active, status: buyer.status }
    : { active: false, status: 'missing' };

  const healthKey = endpoint ? endpoint.healthKey : m.destination_id;
  const healthRecord = healthBySubDelivery[healthKey] || healthByDest[healthKey] || null;

  return {
    id: m.id,
    buyerId: m.buyer_id,
    destinationId: m.destination_id,
    subDeliveryId: endpoint ? endpoint.subDeliveryId : null,
    // Canonical outbound cfg resolved from the SubDelivery (null for legacy members).
    delivery: endpoint ? endpoint.delivery : null,
    // PB-017: invalid config makes the member ineligible, never unrestricted.
    active: m.active !== false && !invalid,
    _configInvalid: invalid,
    priority: num(m.priority) ?? 1,
    weight: num(m.weight) ?? 1,
    reservePrice,
    priceMode,
    fixedPrice: fixedPrice ?? 0,
    price: fixedPrice ?? 0,
    filters: invalid ? {} : (filters || {}),
    conditions: invalid ? null : (hasConditions ? conditions : null),
    schedule: schedule || null,
    // Pre-resolve the schedule to the boolean the engine reads. Absent schedule
    // means always-on. nowMs must be supplied for correct dayparting.
    withinSchedule: schedule && Object.keys(schedule).length ? isWithinSchedule(nowMs ?? 0, schedule) : undefined,
    caps: caps || {},
    buyer: buyerSnap,
    wallet: buildWallet(buyer),
    // Pre-resolved the same way withinSchedule is: engine.js stays pure of
    // ambient time, reading only the boolean. `state` is retained for
    // logging/debugging, not for the eligibility decision itself.
    health: { state: healthRecord?.state || 'closed', blocked: isBlocked(healthRecord, nowMs ?? 0) },
  };
}

function indexBy(arr, key) {
  const out = {};
  for (const r of arr || []) out[String(r[key])] = r;
  return out;
}

// Minimal member shape for an ASYNC RETRY: re-sends an already-selected
// destination, so it does not repeat eligibility (filters/schedule/
// conditions/buyer-lifecycle - buildMember's job) - only the fields
// reserveAndDeliver (distributeRun.js) actually reads to reserve cap, price
// the sale, and resolve the wallet policy. Reuses buildCaps/buildWallet so
// there remains exactly one place either is computed, matching PB-005's "one
// mapper" rule for eligibility snapshots. rm: a raw RouteMember row (retry's
// caller loads it fresh by attempt.route_member_id); deliveryCfg: the
// resolveSubDeliveryCfg(sd) result for the SAME SubDelivery the original
// attempt targeted.
//
// price_mode:'rule' is deliberately NOT resolved here: a state-based price
// needs the lead's state AND the campaign's vertical, neither of which a
// bare retry attempt (keyed only by lead_id/sub_delivery_id) carries without
// a second lookup this module has no evidence is safe to guess at. Returns
// null (fail closed - the retry becomes a permanent, non-retryable error
// rather than a silent wrong price) until a real rule-mode retry case exists
// to design against. No production RouteMember uses rule mode today.
export function buildMemberForRetry(rm, buyer, deliveryCfg) {
  if (!rm) return null;
  const priceMode = ['fixed', 'rule', 'auction'].includes(rm.price_mode) ? rm.price_mode : 'fixed';
  if (priceMode === 'rule') return null;
  let capsInvalid = false;
  const caps = buildCaps(rm.caps, rm.id, () => 0, () => { capsInvalid = true; });
  if (capsInvalid) return null;
  const fixedPrice = num(rm.fixed_price);
  if (priceMode === 'fixed' && (fixedPrice == null || fixedPrice < 0)) return null;
  return {
    id: rm.id,
    buyerId: rm.buyer_id,
    destinationId: rm.destination_id || null,
    subDeliveryId: deliveryCfg ? deliveryCfg.subDeliveryId : null,
    delivery: deliveryCfg,
    priceMode,
    fixedPrice: fixedPrice ?? 0,
    price: fixedPrice ?? 0,
    caps: caps || {},
    wallet: buildWallet(buyer),
  };
}

// Stable, cheap config hash for RouteDecisionTrace referencing the exact config.
function hashConfig(records) {
  const material = JSON.stringify({
    g: (records.groups || []).map((g) => [g.id, g.method, g.order_index, g.lifecycle, g.active]),
    m: (records.members || []).map((m) => [m.id, m.route_group_id, m.buyer_id, m.destination_id, m.priority, m.filters, m.caps]),
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) { h ^= material.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
