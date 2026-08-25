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
//   node scripts/archive-invalid-route-members.js                report only
//   node scripts/archive-invalid-route-members.js --out report.json  also write the full report to a file
//   node scripts/archive-invalid-route-members.js --apply         archive the classified rows
//
// Report only by default. --apply writes ONLY `active: false` and a
// descriptive `destination_name` marker (the exact same pattern already used
// for Walker's Tier 3 SubDelivery in Stage 6 - see
// normalize-walker-native-delivery-tiers.js) on the rows classified below. It
// NEVER deletes a RouteMember, never touches Buyer/Delivery/SubDelivery/Lead/
// billing records, never touches RouteGroup.active/lifecycle, and never
// touches distribution_mode. History and every foreign key stay intact.
//
// See routeMemberArchival.js's own header for the two classification rules
// (NO_DELIVERY_CONFIGURED, EXACT_DUPLICATE).

import fs from 'node:fs';
import { ensureSchema } from '../src/db/schema.js';
import { pool } from '../src/db/pool.js';
import { repo } from '../src/db/repo.js';
import { classifyRouteMembersForArchival, archivedDestinationName } from '../src/lib/routeMemberArchival.js';

const APPLY = process.argv.includes('--apply');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > -1 ? process.argv[outIdx + 1] : null;

const LIMIT = 10_000;

async function main() {
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

  const buyerNameById = new Map(buyers.map((b) => [b.id, b.company_name || b.id]));
  const memberById = new Map(routeMembers.map((m) => [m.id, m]));

  console.log(`[archive-invalid-route-members] BEFORE STATE: ${routeMembers.length} RouteMember record(s)`);
  const { actions, remaining, classifications } = classifyRouteMembersForArchival({
    routeMembers, routeGroups, campaigns, buyers, deliveries, subDeliveries, verticals,
  });
  const stateById = new Map(classifications.map((r) => [r.route_member_id, r.state]));
  for (const m of routeMembers) {
    console.log(
      `  ${m.id}  buyer=${buyerNameById.get(m.buyer_id) || m.buyer_id}  active=${m.active !== false}`
      + `  sub_delivery_id=${m.sub_delivery_id || '(none)'}  destination_name=${JSON.stringify(m.destination_name || '')}`
      + `  state=${stateById.get(m.id) || 'UNKNOWN'}`,
    );
  }

  console.log('');
  console.log(`[archive-invalid-route-members] ${actions.length} of ${routeMembers.length} RouteMember(s) classified for archival:`);
  for (const a of actions) {
    console.log(`  ${a.route_member_id}  buyer=${buyerNameById.get(a.buyer_id) || a.buyer_id}  ${a.code}  ${a.reason}`);
  }
  console.log('');
  console.log(`[archive-invalid-route-members] ${remaining.length} RouteMember(s) remain active and unarchived:`);
  for (const id of remaining) {
    const m = memberById.get(id);
    console.log(`  ${id}  buyer=${buyerNameById.get(m.buyer_id) || m.buyer_id}  sub_delivery_id=${m.sub_delivery_id}`);
  }

  const report = {
    total: routeMembers.length,
    before: routeMembers.map((m) => ({
      id: m.id, buyer_id: m.buyer_id, buyer_name: buyerNameById.get(m.buyer_id) || null,
      active: m.active !== false, sub_delivery_id: m.sub_delivery_id || null,
      destination_name: m.destination_name || null, state: stateById.get(m.id) || null,
      created_date: m.created_date,
    })),
    actions,
    remaining_active: remaining,
  };

  if (OUT) {
    fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log('');
    console.log(`[archive-invalid-route-members] Full report written to ${OUT}`);
  }

  if (!APPLY) {
    console.log('');
    console.log(`[archive-invalid-route-members] Report only. Re-run with --apply to archive ${actions.length} RouteMember(s).`);
    console.log('[archive-invalid-route-members] --apply only sets active:false and appends a marker to destination_name. Nothing is deleted; RouteGroup/Delivery/SubDelivery/Buyer/distribution_mode are untouched.');
    await pool.end();
    return;
  }

  for (const a of actions) {
    const m = memberById.get(a.route_member_id);
    await repo('RouteMember').update(a.route_member_id, {
      active: false,
      destination_name: archivedDestinationName(m.destination_name, a.code),
    });
    console.log(`  archived RouteMember ${a.route_member_id} (${a.code})`);
  }
  console.log('');
  console.log(`[archive-invalid-route-members] Archived ${actions.length} RouteMember(s). ${remaining.length} remain active.`);

  await pool.end();
}

main().catch(async (err) => {
  console.error('[archive-invalid-route-members] FAILED:', err.message);
  try { await pool.end(); } catch { /* already closed */ }
  process.exit(1);
});
