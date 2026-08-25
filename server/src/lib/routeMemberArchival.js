// Pure classification for server/scripts/archive-invalid-route-members.js.
// Decides which currently-active RouteMember rows have no real Delivery
// behind them, or are an exact duplicate of another RouteMember already
// covering the same route. Never writes to a database - the script wraps
// this with the report-only/--apply I/O, matching routeMemberMapping.js's
// own decide-vs-write split.
//
// Two independent, buyer-agnostic classifications, either one alone is
// sufficient reason to archive a row:
//
// 1. NO_BACKING: planRouteMemberMapping reports MISSING_DELIVERY,
//    MISSING_SUBDELIVERY, OWNERSHIP_MISMATCH, or UNKNOWN_BUYER - there is no
//    active Delivery/SubDelivery this member could ever route to today, an
//    admission it always resolves to a valid destination but under the
//    wrong buyer, or the member's own buyer_id does not exist at all. All
//    four states share the same real-world consequence this cleanup exists
//    for: the row can look wired up (OWNERSHIP_MISMATCH in particular has a
//    real, non-null sub_delivery_id) while the real send-time resolver
//    (client/src/lib/distribution/snapshot.js) refuses it as CONFIG_INVALID
//    regardless - it can never deliver a real lead.
//
// 2. EXACT_DUPLICATE: two or more active RouteMembers in the SAME RouteGroup,
//    for the SAME buyer, agree on every routing-meaningful field. Two
//    distinct members legitimately resolving to the same SubDelivery is not
//    itself a bug (planRouteMemberMapping's own design note); only
//    byte-identical rows, which can have no behavioral difference from one
//    another, are collapsed. The earliest-created row is kept.
import { planRouteMemberMapping, MAPPING_STATE } from './routeMemberMapping.js';

const NO_BACKING_STATES = new Set([
  MAPPING_STATE.MISSING_DELIVERY, MAPPING_STATE.MISSING_SUBDELIVERY,
  MAPPING_STATE.OWNERSHIP_MISMATCH, MAPPING_STATE.UNKNOWN_BUYER,
]);
const NO_BACKING_CODE = {
  [MAPPING_STATE.MISSING_DELIVERY]: 'NO_DELIVERY_CONFIGURED',
  [MAPPING_STATE.MISSING_SUBDELIVERY]: 'NO_DELIVERY_CONFIGURED',
  [MAPPING_STATE.OWNERSHIP_MISMATCH]: 'OWNERSHIP_MISMATCH',
  [MAPPING_STATE.UNKNOWN_BUYER]: 'UNKNOWN_BUYER',
};

// Deliberately excludes id, route_group_id (grouped on), created_date,
// updated_date, created_by, and destination_name/alias (display-only -
// destination_name is exactly the field this cleanup exists because of, so
// two rows differing only in display text but identical in every functional
// field are still functionally duplicate).
const IDENTITY_FIELDS = [
  'buyer_id', 'sub_delivery_id', 'destination_id', 'active', 'priority', 'weight',
  'reserve_price', 'price_mode', 'fixed_price', 'payout_type', 'conditional_pricing_enabled',
  'filters', 'conditions', 'caps', 'budget_caps', 'kpi_metrics', 'transforms', 'ping_config',
  'delivery_config', 'schedule', 'suppression_list_id',
];

function fingerprint(m) {
  return IDENTITY_FIELDS.map((f) => JSON.stringify(m[f] ?? null)).join('|');
}

export function classifyRouteMembersForArchival({
  routeMembers = [], routeGroups = [], campaigns = [], buyers = [], deliveries = [], subDeliveries = [], verticals = [],
} = {}) {
  const plan = planRouteMemberMapping({ routeMembers, routeGroups, campaigns, buyers, deliveries, subDeliveries, verticals });
  const stateByMemberId = new Map(plan.rows.map((r) => [r.route_member_id, r]));

  const actions = [];

  for (const m of routeMembers) {
    if (m.active === false) continue;
    const cls = stateByMemberId.get(m.id);
    if (cls && NO_BACKING_STATES.has(cls.state)) {
      actions.push({ route_member_id: m.id, buyer_id: m.buyer_id, code: NO_BACKING_CODE[cls.state], reason: cls.detail });
    }
  }
  const archivedSoFar = new Set(actions.map((a) => a.route_member_id));

  const groups = new Map();
  for (const m of routeMembers) {
    if (m.active === false || archivedSoFar.has(m.id)) continue;
    const key = `${m.route_group_id}::${m.buyer_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const byFingerprint = new Map();
    for (const m of members) {
      const fp = fingerprint(m);
      if (!byFingerprint.has(fp)) byFingerprint.set(fp, []);
      byFingerprint.get(fp).push(m);
    }
    for (const dupes of byFingerprint.values()) {
      if (dupes.length < 2) continue;
      const sorted = [...dupes].sort((a, b) => new Date(a.created_date) - new Date(b.created_date));
      const keep = sorted[0];
      for (const dup of sorted.slice(1)) {
        actions.push({
          route_member_id: dup.id, buyer_id: dup.buyer_id, code: 'EXACT_DUPLICATE',
          reason: `Byte-identical routing configuration to earlier RouteMember ${keep.id} (created ${keep.created_date}), same RouteGroup and buyer. Kept ${keep.id}, archiving this one.`,
          kept_route_member_id: keep.id,
        });
      }
    }
  }

  const archivedIds = new Set(actions.map((a) => a.route_member_id));
  const remaining = routeMembers.filter((m) => m.active !== false && !archivedIds.has(m.id)).map((m) => m.id);

  return { actions, remaining, classifications: plan.rows };
}

export function archivedDestinationName(current, code) {
  const base = (current || '').trim();
  const marker = `(ARCHIVED: ${code} - see docs/STATE.md Stage 7)`;
  return base ? `${base} ${marker}` : marker;
}
