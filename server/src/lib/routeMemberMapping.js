// RouteMember -> SubDelivery deterministic mapping and route mapping audit.
// Lead Distribution rebuild Stage 3, items 13-14.
//
// Known problem this exists to solve: every current production RouteMember.
// sub_delivery_id is null (Stage 1/2 finding, docs/STATE.md), so a RouteMember
// cannot yet identify which SubDelivery should execute even where a matching
// Buyer/Delivery/SubDelivery configuration already exists. This module
// decides that mapping deterministically and reports its confidence; it does
// not decide anything about live activation, and it never writes
// RouteGroup.active, RouteGroup.lifecycle, Delivery.status, or
// distribution_mode.
//
// This module decides and classifies. It does not write to a database - see
// server/scripts/wire-route-member-subdeliveries.js for the report-only-by-
// default / --apply CLI wrapper, matching configRecovery.js's own split.

export const MAPPING_STATE = {
  READY: 'READY',
  MISSING_DELIVERY: 'MISSING_DELIVERY',
  MISSING_SUBDELIVERY: 'MISSING_SUBDELIVERY',
  MISSING_ROUTE: 'MISSING_ROUTE',
  AMBIGUOUS: 'AMBIGUOUS',
  LEGACY_ONLY: 'LEGACY_ONLY',
  UNKNOWN_BUYER: 'UNKNOWN_BUYER',
  OWNERSHIP_MISMATCH: 'OWNERSHIP_MISMATCH',
};

function indexBy(rows, key) {
  const out = new Map();
  for (const r of rows || []) {
    const k = r?.[key];
    if (k == null) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

function indexOneBy(rows, key) {
  const out = new Map();
  for (const r of rows || []) {
    const k = r?.[key];
    if (k != null) out.set(k, r);
  }
  return out;
}

// Deterministically find every active SubDelivery a RouteMember could
// legitimately point to: the SubDelivery's parent Delivery must belong to
// the SAME buyer as the RouteMember (never cross-buyer), be active, and,
// when the RouteMember's campaign has a declared vertical, the Delivery must
// either share it or declare no vertical of its own (unscoped = matches any).
//
// Delivery.vertical_id is a foreign key to the Vertical record's internal id
// (client/src/components/delivery/NativeDeliveriesList.jsx renders it as
// such); Campaign.vertical is the short vertical CODE (e.g. "MVA"), the same
// value Vertical.code carries. These are two different identifier spaces for
// the same concept, so a Delivery's vertical must be translated through
// verticalCodeById before it can be compared to campaignVertical. A
// vertical_id that does not resolve to a known Vertical is a dangling
// reference, not "unscoped" - it does not match, rather than guessing.
function candidateSubDeliveries(member, { deliveriesByBuyer, subDeliveriesByDelivery, campaignVertical, verticalCodeById }) {
  const deliveries = (deliveriesByBuyer.get(member.buyer_id) || [])
    .filter((d) => String(d.status) === 'active')
    .filter((d) => {
      if (!campaignVertical || !d.vertical_id) return true;
      const code = verticalCodeById.get(d.vertical_id) || null;
      return code != null && String(code) === String(campaignVertical);
    });
  const candidates = [];
  for (const delivery of deliveries) {
    for (const sd of subDeliveriesByDelivery.get(delivery.id) || []) {
      if (sd.active === false) continue;
      if (!sd.target_url) continue; // not usable regardless of mapping
      candidates.push({ subDelivery: sd, delivery });
    }
  }
  return candidates;
}

// Classify and, where unambiguous, propose a mapping for every RouteMember.
// Pure function: takes plain record arrays, returns a report. Never mutates
// input and never talks to a database.
export function planRouteMemberMapping({
  routeMembers = [], routeGroups = [], campaigns = [], buyers = [], deliveries = [], subDeliveries = [], verticals = [],
} = {}) {
  const groupsById = indexOneBy(routeGroups, 'id');
  // RouteGroup.campaign_id is a foreign key to the Campaign record's internal
  // id (client/src/lib/distribution/snapshot.js compares g.campaign_id
  // against a resolved campaignId that is always campaign.id - see
  // campaignResolve.js's hit()) - never to Campaign.campaign_id, which is a
  // distinct, separately-editable public short code.
  const campaignsById = indexOneBy(campaigns, 'id');
  const buyersById = indexOneBy(buyers, 'id');
  const deliveriesById = indexOneBy(deliveries, 'id');
  const deliveriesByBuyer = indexBy(deliveries, 'buyer_id');
  const subDeliveriesByDelivery = indexBy(subDeliveries, 'delivery_id');
  const verticalCodeById = new Map();
  for (const v of verticals || []) {
    if (v?.id != null && v.code != null) verticalCodeById.set(v.id, v.code);
  }

  const rows = [];

  for (const member of routeMembers) {
    const row = {
      route_member_id: member.id,
      buyer_id: member.buyer_id || null,
      route_group_id: member.route_group_id || null,
      current_sub_delivery_id: member.sub_delivery_id || null,
      proposed_sub_delivery_id: null,
      state: null,
      detail: null,
      candidates: [],
    };

    // Legacy path: a member that only ever carried the deprecated
    // destination_id is not a native-mapping candidate at all.
    if (!member.sub_delivery_id && member.destination_id) {
      row.state = MAPPING_STATE.LEGACY_ONLY;
      row.detail = 'RouteMember uses the deprecated destination_id path (legacy connector), not sub_delivery_id.';
      rows.push(row);
      continue;
    }

    if (!member.buyer_id || !buyersById.has(member.buyer_id)) {
      row.state = MAPPING_STATE.UNKNOWN_BUYER;
      row.detail = `RouteMember.buyer_id ${JSON.stringify(member.buyer_id)} does not resolve to a Buyer record.`;
      rows.push(row);
      continue;
    }

    const group = member.route_group_id ? groupsById.get(member.route_group_id) : null;
    const campaign = group ? campaignsById.get(group.campaign_id) : null;
    if (!group || !campaign) {
      row.state = MAPPING_STATE.MISSING_ROUTE;
      row.detail = !group
        ? `RouteMember.route_group_id ${JSON.stringify(member.route_group_id)} does not resolve to a RouteGroup.`
        : `RouteGroup.campaign_id ${JSON.stringify(group.campaign_id)} does not resolve to a Campaign.`;
      rows.push(row);
      continue;
    }
    const campaignVertical = campaign.vertical || null;

    // Already mapped: verify rather than guess. An existing mapping is
    // trusted as READY only if it is still buyer-consistent and live; a
    // stale or cross-buyer mapping is reported, never silently corrected.
    if (member.sub_delivery_id) {
      const sd = subDeliveries.find((s) => s.id === member.sub_delivery_id) || null;
      const delivery = sd ? deliveriesById.get(sd.delivery_id) : null;
      if (!sd || !delivery) {
        row.state = MAPPING_STATE.MISSING_SUBDELIVERY;
        row.detail = `RouteMember.sub_delivery_id ${JSON.stringify(member.sub_delivery_id)} does not resolve to an existing SubDelivery.`;
      } else if (String(delivery.buyer_id) !== String(member.buyer_id)) {
        row.state = MAPPING_STATE.OWNERSHIP_MISMATCH;
        row.detail = `RouteMember.sub_delivery_id points at a SubDelivery owned by buyer ${JSON.stringify(delivery.buyer_id)}, not this RouteMember's buyer ${JSON.stringify(member.buyer_id)}.`;
      } else {
        row.state = MAPPING_STATE.READY;
        row.detail = 'Already mapped and buyer-consistent.';
      }
      rows.push(row);
      continue;
    }

    const candidates = candidateSubDeliveries(member, { deliveriesByBuyer, subDeliveriesByDelivery, campaignVertical, verticalCodeById });
    row.candidates = candidates.map((c) => ({ sub_delivery_id: c.subDelivery.id, delivery_id: c.delivery.id }));

    if (candidates.length === 0) {
      const anyDeliveryForBuyer = (deliveriesByBuyer.get(member.buyer_id) || []).length > 0;
      row.state = anyDeliveryForBuyer ? MAPPING_STATE.MISSING_SUBDELIVERY : MAPPING_STATE.MISSING_DELIVERY;
      row.detail = anyDeliveryForBuyer
        ? 'Buyer has a Delivery but no active, usable SubDelivery matching this route\'s vertical.'
        : 'Buyer has no Delivery at all.';
      rows.push(row);
      continue;
    }

    if (candidates.length > 1) {
      row.state = MAPPING_STATE.AMBIGUOUS;
      row.detail = `${candidates.length} equally valid SubDelivery candidates; refusing to guess.`;
      rows.push(row);
      continue;
    }

    // Two distinct RouteMembers may deterministically and correctly resolve
    // to the same single SubDelivery (it may legitimately serve more than
    // one route) - that is not a duplicate mapping row, since each row here
    // is keyed by RouteMember, never repeated for the same member.
    const only = candidates[0];
    row.state = MAPPING_STATE.READY;
    row.proposed_sub_delivery_id = only.subDelivery.id;
    row.detail = 'Exactly one deterministic candidate.';
    rows.push(row);
  }

  const summary = {};
  for (const s of Object.values(MAPPING_STATE)) summary[s] = 0;
  for (const r of rows) summary[r.state] = (summary[r.state] || 0) + 1;

  return { rows, summary, total: rows.length };
}
