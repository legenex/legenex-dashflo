// One-time data-integrity fix for Walker Advertising's duplicate RouteMember.
// Lead Distribution rebuild Stage 7. Not a reusable capability - see the note
// below and normalize-walker-native-delivery-tiers.js's own header for the
// identical precedent (Tier 1 vs Tier 3 SubDelivery duplication) this
// mirrors exactly.
//
// server/scripts/archive-invalid-route-members.js (generic, buyer-agnostic)
// already archives the 10 RouteMembers with no real Delivery at all. It
// deliberately does NOT collapse Walker's two RouteMembers
// (6a5ceabe90e288d32b53717f, created 2026-07-19T15:18:22Z, priority 2; and
// 6a5d036865c28196402bdd17, created 2026-07-19T17:03:36Z, priority 1), both
// already correctly mapped to the same real SubDelivery
// (6a5a8d8c0557a6ea67e70d24, "Tier 1"), because they differ in one field:
// priority. That classifier is right to refuse a guess when fields differ -
// a real priority difference could be a deliberate operator choice for some
// other buyer, some other time.
//
// For THIS pair, priority is not a deliberate choice. Direct production
// query across all 12 original RouteMembers (docs/STATE.md Stage 7) shows
// the full set 1-12 assigned, batch 1 (15:18:22Z) getting the even numbers
// 2/4/6/8/10/12 and batch 2 (17:03:36Z) getting the odd numbers 1/3/5/7/9/11,
// one per buyer per batch - a single global counter interleaved across two
// duplicate-creation runs, not a per-buyer or per-route decision. Every
// other field (sub_delivery_id, active, weight, reserve_price, price_mode,
// fixed_price, payout_type, conditional_pricing_enabled, filters,
// conditions, caps, budget_caps, kpi_metrics, transforms, ping_config,
// delivery_config, schedule, suppression_list_id, destination_id) is
// identical between the two. This is the same "byte-identical, no
// recoverable functional distinction" finding Stage 5 made for Tier 1/Tier
// 3, applied to the RouteMember that points at them.
//
// Archives the later-created duplicate (active=false, destination_name
// marked). Kept, not deleted - historical/auditability. Does not touch
// RouteGroup.active/lifecycle or distribution_mode - the containing
// RouteGroup remains inactive/draft throughout regardless of this change.
//
// Usage:
//   node scripts/normalize-walker-route-member-duplicate.js            report only
//   node scripts/normalize-walker-route-member-duplicate.js --apply    write it

import { ensureSchema } from '../src/db/schema.js';
import { repo } from '../src/db/repo.js';
import { pool } from '../src/db/pool.js';
import { archivedDestinationName } from '../src/lib/routeMemberArchival.js';

const APPLY = process.argv.includes('--apply');

const KEEP_ID = '6a5ceabe90e288d32b53717f'; // created first, priority 2
const ARCHIVE_ID = '6a5d036865c28196402bdd17'; // created second, priority 1

const IDENTITY_FIELDS_EXCEPT_PRIORITY = [
  'buyer_id', 'sub_delivery_id', 'destination_id', 'active', 'weight',
  'reserve_price', 'price_mode', 'fixed_price', 'payout_type', 'conditional_pricing_enabled',
  'filters', 'conditions', 'caps', 'budget_caps', 'kpi_metrics', 'transforms', 'ping_config',
  'delivery_config', 'schedule', 'suppression_list_id',
];

async function main() {
  await ensureSchema();

  const keep = await repo('RouteMember').get(KEEP_ID);
  const dup = await repo('RouteMember').get(ARCHIVE_ID);

  if (!keep || !dup) {
    console.error(`[normalize-walker-route-member-duplicate] Expected RouteMember record(s) not found (keep=${!!keep}, dup=${!!dup}). Refusing to guess at different ids.`);
    await pool.end();
    process.exit(1);
  }

  console.log('[normalize-walker-route-member-duplicate] Verifying every field except priority still matches before touching anything...');
  const mismatches = IDENTITY_FIELDS_EXCEPT_PRIORITY.filter((f) => JSON.stringify(keep[f] ?? null) !== JSON.stringify(dup[f] ?? null));
  if (mismatches.length > 0) {
    console.error(`[normalize-walker-route-member-duplicate] REFUSING: field(s) ${mismatches.join(', ')} now differ between ${KEEP_ID} and ${ARCHIVE_ID}. Production data has changed since this script was written - do not proceed without re-investigating.`);
    await pool.end();
    process.exit(1);
  }
  console.log(`[normalize-walker-route-member-duplicate] Confirmed: identical on every field except priority (${keep.priority} vs ${dup.priority}).`);
  console.log(`[normalize-walker-route-member-duplicate] Keep ${KEEP_ID} (priority ${keep.priority}), archive ${ARCHIVE_ID} (priority ${dup.priority}).`);

  if (!APPLY) {
    console.log('');
    console.log('[normalize-walker-route-member-duplicate] Report only. Re-run with --apply to archive the duplicate.');
    await pool.end();
    return;
  }

  await repo('RouteMember').update(ARCHIVE_ID, {
    active: false,
    destination_name: archivedDestinationName(dup.destination_name, 'EXACT_DUPLICATE_EXCEPT_PRIORITY'),
  });
  console.log(`[normalize-walker-route-member-duplicate] Archived ${ARCHIVE_ID}. ${KEEP_ID} remains the one active Walker RouteMember.`);

  await pool.end();
}

main().catch(async (err) => {
  console.error('[normalize-walker-route-member-duplicate] FAILED:', err.message);
  try { await pool.end(); } catch { /* already closed */ }
  process.exit(1);
});
