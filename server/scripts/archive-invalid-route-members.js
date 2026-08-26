// Archive RouteMember rows that cannot back a real routing decision. Lead
// Distribution rebuild Stage 7, product/UX correction: the operator-visible
// Routing tab was rendering these as if they were configured Deliveries
// (destination_name happened to be populated, usually with the buyer's own
// name), when in fact they have no real Delivery/SubDelivery behind them at
// all, or are an exact duplicate of another RouteMember already covering the
// same route. Classification logic lives in
// server/src/lib/routeMemberArchival.js (tested, buyer-agnostic); this file
// is only the report-only/--apply I/O wrapper, matching
// wire-route-member-subdeliveries.js's own split.
//
// Usage:
//   node scripts/archive-invalid-route-members.js                         report only, full dataset
//   node scripts/archive-invalid-route-members.js --route-group <id>      report only, one RouteGroup
//   node scripts/archive-invalid-route-members.js --out report.json       also write the full report to a file
//   node scripts/archive-invalid-route-members.js --apply --route-group <id>   archive the classified rows in ONE RouteGroup
//
// Report only by default, and always safe to run across the full dataset:
// it never writes anything.
//
// --apply REQUIRES --route-group <id> and REFUSES otherwise. There is no
// "apply to everything" mode: a single --apply cannot touch RouteMembers
// across more than one RouteGroup. This is deliberate, not a missing
// feature - the EXACT_DUPLICATE classification (routeMemberArchival.js) is
// necessarily inference (two rows judged behaviorally redundant), not a
// database-referential-integrity fact like NO_DELIVERY_CONFIGURED, and this
// tool's own first real production use (docs/STATE.md Stage 7) only ever
// reviewed and applied against one RouteGroup that had actually been read
// end to end first. A one-shot, unscoped --apply against a RouteGroup
// nobody has looked at is exactly the kind of silent, unreviewed data loss
// the operator brief's cleanup-safety section warns against. --route-group
// makes "which RouteGroup did I just review" an explicit, printed fact
// instead of an implicit assumption.
//
// Classification still runs against the FULL dataset even when scoped
// (candidateSubDeliveries-style classification, in particular
// NO_DELIVERY_CONFIGURED, is only correct with full Buyer/Delivery/
// SubDelivery context - a RouteMember cannot be correctly judged in
// isolation from the rest of its own buyer's records). Only the WRITE step
// is filtered down to the selected RouteGroup's own RouteMembers; a
// candidate belonging to any other RouteGroup is left untouched and is not
// even printed in the apply-time summary, so there is nothing to
// accidentally confirm past its own scope.
//
// --apply writes ONLY `active: false` and a descriptive `destination_name`
// marker (the exact same pattern already used for Walker's Tier 3
// SubDelivery in Stage 6 - see normalize-walker-native-delivery-tiers.js).
// It NEVER deletes a RouteMember, never touches Buyer/Delivery/SubDelivery/
// BuyerStateCpl/Lead/billing/DeliveryAttempt/migration-provenance records,
// never touches RouteGroup.active/lifecycle, and never touches
// distribution_mode. History and every foreign key stay intact. Idempotent:
// an already-archived row (active:false) is skipped by the classifier
// itself (see routeMemberArchival.js), so a second --apply against the same
// RouteGroup finds nothing left to do.
//
// See routeMemberArchival.js's own header for the two classification rules
// (NO_DELIVERY_CONFIGURED, EXACT_DUPLICATE).

import fs from 'node:fs';
import { ensureSchema } from '../src/db/schema.js';
import { pool } from '../src/db/pool.js';
import { repo } from '../src/db/repo.js';
import { classifyRouteMembersForArchival, archivedDestinationName, scopeActionsToRouteGroup } from '../src/lib/routeMemberArchival.js';

const APPLY = process.argv.includes('--apply');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > -1 ? process.argv[outIdx + 1] : null;
const rgIdx = process.argv.indexOf('--route-group');
const ROUTE_GROUP_ID = rgIdx > -1 ? process.argv[rgIdx + 1] : null;

const LIMIT = 10_000;

async function main() {
  if (APPLY && !ROUTE_GROUP_ID) {
    console.error('[archive-invalid-route-members] FAILED: --apply requires --route-group <id>. There is no "apply to everything" mode - see this file\'s own header for why.');
    process.exit(1);
    return;
  }

  await ensureSchema();

  const [routeMembers, routeGroups, campaigns, buyers, deliveries, subDeliveries, verticals] = await Promise.all([
    repo('RouteMember').list('-created_date', LIMIT),
    repo('RouteGroup').list('-created_date', LIMIT),
    repo('Campaign').list('-created_date', LIMIT),
    repo('Buyer').list('-created_date', LIMIT),
    repo('Delivery').list('-created_date', LIMIT),
    repo('SubDelivery').list('-created_date', LIMIT),
    repo('Vertical').list('-created_date', LIMIT),
  ]);

  if (ROUTE_GROUP_ID && !routeGroups.some((g) => g.id === ROUTE_GROUP_ID)) {
    console.error(`[archive-invalid-route-members] FAILED: --route-group ${ROUTE_GROUP_ID} does not resolve to any RouteGroup. Refusing to guess.`);
    await pool.end();
    process.exit(1);
    return;
  }

  const buyerNameById = new Map(buyers.map((b) => [b.id, b.company_name || b.id]));
  const memberById = new Map(routeMembers.map((m) => [m.id, m]));

  // Classification always runs against the full dataset - see the header
  // note on why a RouteMember cannot be correctly judged in isolation.
  const { actions: allActions, remaining, classifications } = classifyRouteMembersForArchival({
    routeMembers, routeGroups, campaigns, buyers, deliveries, subDeliveries, verticals,
  });
  const stateById = new Map(classifications.map((r) => [r.route_member_id, r.state]));

  const scopedMembers = ROUTE_GROUP_ID ? routeMembers.filter((m) => m.route_group_id === ROUTE_GROUP_ID) : routeMembers;
  const scopedActions = ROUTE_GROUP_ID ? scopeActionsToRouteGroup(allActions, routeMembers, ROUTE_GROUP_ID) : allActions;

  console.log(`[archive-invalid-route-members] BEFORE STATE: ${routeMembers.length} RouteMember record(s) total`
    + (ROUTE_GROUP_ID ? `, ${scopedMembers.length} in scope (RouteGroup ${ROUTE_GROUP_ID})` : ' (no --route-group given, showing the full dataset)'));
  for (const m of scopedMembers) {
    console.log(
      `  ${m.id}  route_group=${m.route_group_id}  buyer=${buyerNameById.get(m.buyer_id) || m.buyer_id}  active=${m.active !== false}`
      + `  sub_delivery_id=${m.sub_delivery_id || '(none)'}  destination_name=${JSON.stringify(m.destination_name || '')}`
      + `  state=${stateById.get(m.id) || 'UNKNOWN'}`,
    );
  }

  console.log('');
  console.log(`[archive-invalid-route-members] ${scopedActions.length} of ${scopedMembers.length} in-scope RouteMember(s) classified for archival:`);
  for (const a of scopedActions) {
    console.log(`  ${a.route_member_id}  buyer=${buyerNameById.get(a.buyer_id) || a.buyer_id}  ${a.code}  ${a.reason}`);
  }
  if (!ROUTE_GROUP_ID) {
    console.log('');
    console.log(`[archive-invalid-route-members] ${remaining.length} RouteMember(s) remain active and unarchived across the full dataset.`);
  }

  const report = {
    route_group_scope: ROUTE_GROUP_ID || null,
    total: routeMembers.length,
    in_scope: scopedMembers.length,
    before: scopedMembers.map((m) => ({
      id: m.id, route_group_id: m.route_group_id, buyer_id: m.buyer_id, buyer_name: buyerNameById.get(m.buyer_id) || null,
      active: m.active !== false, sub_delivery_id: m.sub_delivery_id || null,
      destination_name: m.destination_name || null, state: stateById.get(m.id) || null,
      created_date: m.created_date,
    })),
    actions: scopedActions,
    remaining_active_full_dataset: ROUTE_GROUP_ID ? null : remaining,
  };

  if (OUT) {
    fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log('');
    console.log(`[archive-invalid-route-members] Full report written to ${OUT}`);
  }

  if (!APPLY) {
    console.log('');
    console.log(`[archive-invalid-route-members] Report only. Re-run with --apply --route-group ${ROUTE_GROUP_ID || '<id>'} to archive ${scopedActions.length} RouteMember(s) in that group.`);
    console.log('[archive-invalid-route-members] --apply only sets active:false and appends a marker to destination_name. Nothing is deleted; RouteGroup/Delivery/SubDelivery/Buyer/BuyerStateCpl/distribution_mode are untouched, and only the selected RouteGroup is ever written.');
    await pool.end();
    return;
  }

  console.log('');
  console.log(`[archive-invalid-route-members] APPLYING to RouteGroup ${ROUTE_GROUP_ID} only: ${scopedActions.length} RouteMember(s).`);
  for (const a of scopedActions) {
    const m = memberById.get(a.route_member_id);
    await repo('RouteMember').update(a.route_member_id, {
      active: false,
      destination_name: archivedDestinationName(m.destination_name, a.code),
    });
    console.log(`  archived RouteMember ${a.route_member_id} (${a.code})`);
  }
  console.log('');
  console.log(`[archive-invalid-route-members] Archived ${scopedActions.length} RouteMember(s) in RouteGroup ${ROUTE_GROUP_ID}.`);

  await pool.end();
}

main().catch(async (err) => {
  console.error('[archive-invalid-route-members] FAILED:', err.message);
  try { await pool.end(); } catch { /* already closed */ }
  process.exit(1);
});
