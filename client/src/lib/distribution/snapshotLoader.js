// Backend snapshot loader: fetches persisted records with BOUNDED, FILTERED,
// PAGINATED reads (never an unfiltered full-table list) and hands them to the
// canonical buildRoutingSnapshot mapper. `db` is api.asServiceRole.
//
// A short-TTL module-scope cache answers "does any active RouteGroup exist for
// this campaign" so the hot path can skip the full load entirely when there is no
// config.

import { buildRoutingSnapshot } from './snapshot.js';
import { capWindowStart, capScopeKey } from './engine.js';

const PAGE = 200;
const CAP_WINDOWS = ['total', 'hourly', 'daily', 'weekly', 'monthly'];

function parseCapsJson(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}
const activeGroupCache = new Map(); // campaignId -> { has, expires }

// Paginated filtered read. Always passes a query; caps total pages.
async function loadAllFiltered(entity, query, { sort = 'created_date', maxPages = 25 } = {}) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const rows = await entity.filter(query, sort, PAGE, page * PAGE);
    if (!rows || !rows.length) break;
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// Cheap existence check (limit 1), cached for ttlMs.
export async function hasActiveRouteGroup(db, campaignId, nowMs, ttlMs = 5000) {
  const cached = activeGroupCache.get(campaignId);
  if (cached && cached.expires > nowMs) return cached.has;
  const rows = await db.entities.RouteGroup.filter({ campaign_id: campaignId, active: true, lifecycle: 'active' }, 'order_index', 1, 0);
  const has = !!(rows && rows.length);
  activeGroupCache.set(campaignId, { has, expires: nowMs + ttlMs });
  return has;
}

export function _clearActiveGroupCache() { activeGroupCache.clear(); }

// Load a full snapshot for a campaign via bounded paginated reads. Cap counts are
// pre-loaded here (async) and exposed to the pure mapper as a SYNC lookup.
// leadState: the posting lead's state (2-letter code), used only to resolve
// price_mode:'rule' members against BuyerStateCpl. Omit (undefined) for a
// structural, no-specific-lead load (e.g. publish validation); an actual
// routing evaluation always supplies it, even if empty, so a rule-mode
// member without a matching active state price fails closed rather than
// silently pricing at 0.
export async function loadRoutingSnapshot(db, { campaignId, nowMs, configVersionId, leadState }) {
  const groups = await loadAllFiltered(db.entities.RouteGroup, { campaign_id: campaignId, active: true, lifecycle: 'active' }, { sort: 'order_index' });
  const groupIds = groups.map((g) => g.id);
  // Members for these groups only (filtered, never a full list).
  let members = [];
  for (const gid of groupIds) {
    members = members.concat(await loadAllFiltered(db.entities.RouteMember, { route_group_id: gid }, { sort: 'priority' }));
  }
  const buyerIds = [...new Set(members.map((m) => m.buyer_id).filter(Boolean))];
  const destIds = [...new Set(members.map((m) => m.destination_id).filter(Boolean))];
  const subDeliveryIds = [...new Set(members.map((m) => m.sub_delivery_id).filter(Boolean))];
  const buyers = [];
  for (const id of buyerIds) { const r = await db.entities.Buyer.filter({ id }); if (r && r[0]) buyers.push(r[0]); }
  const destinations = [];
  for (const id of destIds) { const r = await db.entities.LeadByteConnector.filter({ id }); if (r && r[0]) destinations.push(r[0]); }

  // Canonical SubDelivery endpoints + their parent Delivery (for buyer/status checks).
  const subDeliveries = [];
  if (db.entities.SubDelivery) {
    for (const id of subDeliveryIds) { const r = await db.entities.SubDelivery.filter({ id }); if (r && r[0]) subDeliveries.push(r[0]); }
  }
  const deliveryIds = [...new Set(subDeliveries.map((sd) => sd.delivery_id).filter(Boolean))];
  const deliveries = [];
  if (db.entities.Delivery) {
    for (const id of deliveryIds) { const r = await db.entities.Delivery.filter({ id }); if (r && r[0]) deliveries.push(r[0]); }
  }

  // Health is per endpoint. Load by sub_delivery_id (canonical) and by legacy destination_id.
  const health = [];
  for (const id of subDeliveryIds) { const r = await db.entities.DestinationHealth.filter({ sub_delivery_id: id }); if (r && r[0]) health.push(r[0]); }
  for (const id of destIds) { const r = await db.entities.DestinationHealth.filter({ destination_id: id }); if (r && r[0]) health.push(r[0]); }

  // Pre-load cap counters for these members (async), then hand the mapper a
  // sync lookup. Queries by scope_key - the SAME canonical key
  // capScopesFor/reservation.js write under (engine.js's capScopeKey) - so
  // this eligibility pre-check can never disagree with what the atomic
  // reserve() step actually enforces. Each member's OWN configured windows
  // are read directly off its raw caps JSON, since a window's bucket
  // (capWindowStart) must match exactly what the write side computed.
  const capMap = {};
  if (db.entities.CapCounter) {
    for (const m of members) {
      const parsedCaps = parseCapsJson(m.caps);
      for (const w of CAP_WINDOWS) {
        if (parsedCaps[w] == null) continue;
        const bucket = w === 'total' ? 'all' : capWindowStart(nowMs, w);
        const key = capScopeKey(m.id, w, bucket);
        try {
          const rows = await db.entities.CapCounter.filter({ scope_key: key });
          if (rows && rows[0]) capMap[`${m.id}:${w}`] = Number(rows[0].count || 0);
        } catch { /* no counter yet */ }
      }
    }
  }
  const capCountsFor = (memberId, window) => capMap[`${memberId}:${window}`] || 0;

  // price_mode:'rule' resolution. Resolve the campaign's vertical once, then
  // pre-load active BuyerStateCpl rows for exactly the buyers referenced by
  // this snapshot's members (never a full-table read).
  let vertical = null;
  if (campaignId && db.entities.Campaign) {
    try {
      const rows = await db.entities.Campaign.filter({ id: campaignId });
      vertical = (rows && rows[0] && rows[0].vertical) || null;
    } catch { /* no campaign resolved */ }
  }
  const stateCplMap = {};
  if (db.entities.BuyerStateCpl && vertical) {
    for (const buyerId of buyerIds) {
      try {
        const rows = await db.entities.BuyerStateCpl.filter({ buyer_id: buyerId, vertical, active: true });
        for (const r of rows || []) stateCplMap[`${buyerId}:${String(r.state || '').toUpperCase()}`] = Number(r.cpl);
      } catch { /* no coverage rows for this buyer */ }
    }
  }
  const stateCplFor = (buyerId, state) => {
    const v = stateCplMap[`${buyerId}:${String(state || '').toUpperCase()}`];
    return v == null ? null : v;
  };

  return buildRoutingSnapshot(
    { groups, members, buyers, destinations, subDeliveries, deliveries, health },
    { campaignId, nowMs, configVersionId, capCountsFor, leadState, stateCplFor },
  );
}
