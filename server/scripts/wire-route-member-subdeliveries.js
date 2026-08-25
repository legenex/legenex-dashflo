// RouteMember -> SubDelivery deterministic mapping. Lead Distribution
// rebuild Stage 3, items 13-14.
//
// Usage:
//   node scripts/wire-route-member-subdeliveries.js                report only
//   node scripts/wire-route-member-subdeliveries.js --out report.json  also write the full report to a file
//   node scripts/wire-route-member-subdeliveries.js --apply         write proposed sub_delivery_id values
//
// Report only by default. --apply writes ONLY the RouteMember.sub_delivery_id
// column, and only for rows this session classified READY with a proposal
// (i.e. currently null, resolved to exactly one unambiguous candidate). It
// never touches RouteGroup.active, RouteGroup.lifecycle, Delivery.status,
// Buyer fields, or AppSettings.distribution_mode - wiring a mapping is not
// the same as activating it, and this script does neither of the latter.
//
// Safe to run against whatever DATABASE_URL / PG* the environment it is
// invoked with points at - see server/test/routeMemberMapping.test.js for
// the plain-fixture coverage and docs/STATE.md for the production run
// history and results.

import fs from 'node:fs';
import { ensureSchema } from '../src/db/schema.js';
import { pool } from '../src/db/pool.js';
import { repo } from '../src/db/repo.js';
import { planRouteMemberMapping, MAPPING_STATE } from '../src/lib/routeMemberMapping.js';

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

  const plan = planRouteMemberMapping({ routeMembers, routeGroups, campaigns, buyers, deliveries, subDeliveries, verticals });

  console.log(`[wire-route-member-subdeliveries] ${plan.total} RouteMember record(s) classified:`);
  for (const state of Object.values(MAPPING_STATE)) {
    if (plan.summary[state]) console.log(`  ${state.padEnd(20)} ${plan.summary[state]}`);
  }

  const toApply = plan.rows.filter((r) => r.state === MAPPING_STATE.READY && r.proposed_sub_delivery_id);
  console.log('');
  console.log(`[wire-route-member-subdeliveries] ${toApply.length} unambiguous mapping(s) proposed (currently unmapped, exactly one candidate).`);

  const needsAttention = plan.rows.filter((r) => [
    MAPPING_STATE.AMBIGUOUS, MAPPING_STATE.OWNERSHIP_MISMATCH, MAPPING_STATE.MISSING_ROUTE, MAPPING_STATE.UNKNOWN_BUYER,
  ].includes(r.state));
  if (needsAttention.length) {
    console.log('');
    console.log(`[wire-route-member-subdeliveries] ${needsAttention.length} record(s) need a human decision, not guessed:`);
    for (const r of needsAttention) {
      console.log(`  ${r.route_member_id}  ${r.state}  ${r.detail}`);
    }
  }

  if (OUT) {
    fs.writeFileSync(OUT, `${JSON.stringify(plan, null, 2)}\n`);
    console.log('');
    console.log(`[wire-route-member-subdeliveries] Full report written to ${OUT}`);
  }

  if (!APPLY) {
    console.log('');
    console.log(`[wire-route-member-subdeliveries] Report only. Re-run with --apply to write ${toApply.length} RouteMember.sub_delivery_id value(s).`);
    console.log('[wire-route-member-subdeliveries] --apply never activates a RouteGroup, changes distribution_mode, or touches anything beyond sub_delivery_id.');
    await pool.end();
    return;
  }

  for (const r of toApply) {
    await repo('RouteMember').update(r.route_member_id, { sub_delivery_id: r.proposed_sub_delivery_id });
    console.log(`  wrote RouteMember ${r.route_member_id} -> SubDelivery ${r.proposed_sub_delivery_id}`);
  }
  console.log('');
  console.log(`[wire-route-member-subdeliveries] Applied ${toApply.length} mapping(s). distribution_mode and RouteGroup activation are unchanged.`);

  await pool.end();
}

main().catch(async (err) => {
  console.error('[wire-route-member-subdeliveries] FAILED:', err.message);
  try { await pool.end(); } catch { /* already closed */ }
  process.exit(1);
});
