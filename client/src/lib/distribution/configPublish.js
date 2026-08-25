// Pure configuration-publishing logic: fail-closed publish validation, a stable
// per-group config hash, an immutable version snapshot, a config diff for the
// operator confirmation, and resolution of a historical trace to its exact
// published version. No I/O; the backend function supplies records.

import { buildRoutingSnapshot } from './snapshot.js';

// Stable hash of a group + its members (non-secret fields that affect routing).
export function computeConfigHash(group, members) {
  const material = JSON.stringify({
    g: [group.id, group.method, group.order_index, group.price_weight, group.priority_weight],
    m: (members || []).map((m) => [
      // sub_delivery_id is the CANONICAL destination pointer; destination_id
      // is deprecated compatibility only (see RouteMember.json). Omitting it
      // meant repointing a member from one SubDelivery to another under the
      // same buyer produced no diff and an unchanged hash - a real gap
      // against RouteConfigVersion's own explainability guarantee.
      m.id, m.buyer_id, m.destination_id, m.sub_delivery_id, m.active, m.priority, m.weight, m.reserve_price,
      m.price_mode, m.fixed_price, m.filters, m.conditions, m.caps, m.schedule,
    ]),
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) { h ^= material.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Fail-closed publish validation. Returns { valid, errors }. A publish is refused
// unless the whole group is routable: config parses, every member has an existing
// eligible buyer and an existing destination, caps/pricing/schedule are valid.
// Reuses buildRoutingSnapshot so validation matches routing exactly.
// buyerStateCpls: optional, active BuyerStateCpl rows for this campaign's
// vertical (any buyer). Only used to validate price_mode:'rule' members -
// see below. Omitting it (existing callers) simply skips that one check,
// same as before this parameter existed.
export function validateConfigForPublish({ group, members, buyers, destinations, subDeliveries, deliveries, buyerStateCpls }, nowMs) {
  const errors = [];
  if (!group || !group.campaign_id) errors.push({ code: 'CONFIG_INVALID', detail: 'group missing campaign' });
  if (!members || members.length === 0) errors.push({ code: 'CONFIG_INVALID', detail: 'group has no members' });

  // Force the group active so the mapper evaluates it, then read configErrors.
  // leadState is deliberately NOT supplied: publish validates STRUCTURE, not
  // one specific lead, and price_mode:'rule' price resolution is inherently
  // lead-dependent (see snapshot.js's buildMember) - the rule-mode coverage
  // check just below covers this case instead.
  const snap = buildRoutingSnapshot(
    { groups: [{ ...group, active: true, lifecycle: 'active' }], members, buyers, destinations, subDeliveries, deliveries, health: [] },
    { campaignId: group && group.campaign_id, nowMs: nowMs ?? 0 },
  );
  for (const e of snap.configErrors) errors.push(e);

  // Every member must map to an eligible (allowlisted-active) buyer.
  const buyerById = index(buyers, 'id');
  const destById = index(destinations, 'id');
  const subById = index(subDeliveries, 'id');
  const delById = index(deliveries, 'id');
  for (const m of members || []) {
    const b = buyerById[m.buyer_id];
    if (!b) errors.push({ member_id: m.id, code: 'CONFIG_INVALID', detail: 'buyer not found' });
    else if (!(String(b.status).toLowerCase() === 'active' && b.active === true)) {
      errors.push({ member_id: m.id, code: 'BUYER_INELIGIBLE', detail: 'buyer not active' });
    }
    // price_mode:'rule' resolves its price from BuyerStateCpl at routing
    // time (lead state -> this buyer's active per-state price), not from a
    // value stored on the member. Publish cannot check a specific state, but
    // it CAN and must check that the buyer has any active state pricing
    // configured at all - a rule-mode member for a buyer with zero
    // BuyerStateCpl coverage would otherwise publish successfully and then
    // fail CONFIG_INVALID for every real lead with no warning beforehand.
    if (m.price_mode === 'rule' && Array.isArray(buyerStateCpls)) {
      const hasCoverage = buyerStateCpls.some((r) => String(r.buyer_id) === String(m.buyer_id) && r.active !== false);
      if (!hasCoverage) errors.push({ member_id: m.id, code: 'CONFIG_INVALID', detail: 'rule-mode member: buyer has no active BuyerStateCpl coverage' });
    }
    // Canonical destination: publish fails closed unless the member's sub-delivery
    // exists, is active, belongs to the member's buyer, and has a target_url and
    // a response mapping. Legacy destination_id-only members keep the old check.
    if (m.sub_delivery_id) {
      const sd = subById[m.sub_delivery_id];
      if (!sd) errors.push({ member_id: m.id, code: 'CONFIG_INVALID', detail: 'sub-delivery not found' });
      else {
        if (sd.active === false) errors.push({ member_id: m.id, code: 'CONFIG_INVALID', detail: 'sub-delivery inactive' });
        const del = delById[sd.delivery_id];
        if (!del) errors.push({ member_id: m.id, code: 'CONFIG_INVALID', detail: 'parent delivery not found' });
        else {
          if (String(del.status) !== 'active') errors.push({ member_id: m.id, code: 'CONFIG_INVALID', detail: 'parent delivery not active' });
          if (String(del.buyer_id) !== String(m.buyer_id)) errors.push({ member_id: m.id, code: 'CONFIG_INVALID', detail: 'sub-delivery belongs to a different buyer' });
        }
        if (!sd.target_url) errors.push({ member_id: m.id, code: 'CONFIG_INVALID', detail: 'sub-delivery missing target_url' });
        if (!sd.response_mapping || String(sd.response_mapping).trim() === '') errors.push({ member_id: m.id, code: 'CONFIG_INVALID', detail: 'sub-delivery missing response mapping' });
      }
    } else if (!destById[m.destination_id]) {
      errors.push({ member_id: m.id, code: 'CONFIG_INVALID', detail: 'destination not found' });
    }
    if (m.price_mode === 'fixed' && !(Number(m.fixed_price) >= 0)) errors.push({ member_id: m.id, code: 'CONFIG_INVALID', detail: 'invalid price' });
  }
  return { valid: errors.length === 0, errors, configHash: group ? computeConfigHash(group, members) : null };
}

// Immutable snapshot payload stored in RouteConfigVersion.
export function buildVersionSnapshot(group, members) {
  return JSON.stringify({ group: sanitizeGroup(group), members: (members || []).map(sanitizeMember) });
}

// Field-level diff between the current published config and a candidate, for the
// operator confirmation dialog.
export function diffConfig(oldCfg, newCfg) {
  const changes = [];
  const g0 = oldCfg && oldCfg.group || {}; const g1 = newCfg && newCfg.group || {};
  for (const k of ['method', 'order_index', 'price_weight', 'priority_weight']) {
    if (String(g0[k]) !== String(g1[k])) changes.push({ scope: 'group', field: k, from: g0[k] ?? null, to: g1[k] ?? null });
  }
  const m0 = index(oldCfg && oldCfg.members, 'id'); const m1 = index(newCfg && newCfg.members, 'id');
  for (const id of new Set([...Object.keys(m0), ...Object.keys(m1)])) {
    if (!m0[id]) changes.push({ scope: 'member', id, change: 'added' });
    else if (!m1[id]) changes.push({ scope: 'member', id, change: 'removed' });
    else for (const k of ['buyer_id', 'destination_id', 'sub_delivery_id', 'active', 'priority', 'weight', 'price_mode', 'fixed_price', 'reserve_price', 'conditions', 'filters', 'caps', 'schedule']) {
      if (JSON.stringify(m0[id][k]) !== JSON.stringify(m1[id][k])) changes.push({ scope: 'member', id, field: k, from: m0[id][k] ?? null, to: m1[id][k] ?? null });
    }
  }
  return changes;
}

// Resolve a historical trace to the exact immutable version by config hash.
export function resolveTraceVersion(configHash, versions) {
  return (versions || []).find((v) => String(v.config_hash) === String(configHash)) || null;
}

function index(arr, key) { const o = {}; for (const r of arr || []) o[String(r[key])] = r; return o; }
function sanitizeGroup(g) { const { published_by, ...rest } = g || {}; void published_by; return rest; }
function sanitizeMember(m) { return m; }
