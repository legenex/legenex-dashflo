// One-time data-integrity fix for Walker Advertising's native delivery
// configuration. Stage 4/5 (docs/STATE.md) exhausted repository, migration,
// historical and production evidence and found NO recoverable functional
// distinction between the existing "Tier 1" (6a5a8d8c0557a6ea67e70d24) and
// "Tier 3" (6a5a8d94c20b54ee6ecb660c) SubDelivery rows under Walker's one
// Delivery ("Walker - 30 Days", 6a5a8d809fe2a933ca284252): byte-identical
// target_url/headers/payload_template, created 8 seconds apart. This is a
// one-time historical duplicate, not a reusable capability, so unlike
// set-buyer-rule-pricing.js this script is intentionally Walker-specific
// rather than generic - see the Stage 4 finding about NOT defaulting generic
// tooling to one buyer's name, which does not apply here because this tool
// has no reason to ever run against a different buyer.
//
// Does exactly two things, both operator-decided, neither a live-traffic
// action on its own (RouteGroup stays inactive/draft throughout - see
// snapshot.js's own group-activation gate, unaffected by either change):
//   1. Archives the duplicate (Tier 3): active=false, name marked archived.
//      Kept, not deleted - historical/auditability, per instruction.
//   2. Moves the parent Delivery.status from draft to active. Necessary
//      (not sufficient) for routeMemberMapping.js's candidateSubDeliveries
//      to consider ANY SubDelivery here at all (it requires Delivery.status
//      === 'active'); Stage 4 section 7 documents this exact step as
//      reversible and non-live because the containing RouteGroup remains
//      inactive/draft regardless.
//
// Does NOT touch RouteMember.sub_delivery_id (see the existing, generic
// server/scripts/wire-route-member-subdeliveries.js for that - run it after
// this script), RouteGroup.active/lifecycle, or distribution_mode.
//
// Usage:
//   node scripts/normalize-walker-native-delivery-tiers.js            report only
//   node scripts/normalize-walker-native-delivery-tiers.js --apply    write it

import { ensureSchema } from '../src/db/schema.js';
import { repo } from '../src/db/repo.js';
import { pool } from '../src/db/pool.js';

const APPLY = process.argv.includes('--apply');

const CANONICAL_SUBDELIVERY_ID = '6a5a8d8c0557a6ea67e70d24'; // Tier 1 - created first, kept active
const DUPLICATE_SUBDELIVERY_ID = '6a5a8d94c20b54ee6ecb660c'; // Tier 3 - archived, never deleted
const DELIVERY_ID = '6a5a8d809fe2a933ca284252'; // "Walker - 30 Days"
const ARCHIVE_SUFFIX = ' (ARCHIVED: duplicate of Tier 1, no functional distinction found - see docs/STATE.md Stage 5)';

async function main() {
  await ensureSchema();
  const Delivery = repo('Delivery');
  const SubDelivery = repo('SubDelivery');

  const delivery = await Delivery.get(DELIVERY_ID);
  if (!delivery) { console.log(`[normalize-walker-tiers] Delivery ${DELIVERY_ID} not found. Nothing to do.`); await pool.end(); return; }
  const canonical = await SubDelivery.get(CANONICAL_SUBDELIVERY_ID);
  const duplicate = await SubDelivery.get(DUPLICATE_SUBDELIVERY_ID);
  if (!canonical || !duplicate) { console.log('[normalize-walker-tiers] One or both SubDelivery rows not found. Refusing to guess.'); await pool.end(); return; }
  if (String(duplicate.delivery_id) !== DELIVERY_ID || String(canonical.delivery_id) !== DELIVERY_ID) {
    console.log('[normalize-walker-tiers] SubDelivery parent Delivery mismatch. Refusing.'); await pool.end(); return;
  }

  console.log(`[normalize-walker-tiers] Delivery "${delivery.name}" (${delivery.id}): status ${delivery.status}`);
  console.log(`[normalize-walker-tiers] Canonical SubDelivery: "${canonical.name}" (${canonical.id}), active=${canonical.active}`);
  console.log(`[normalize-walker-tiers] Duplicate SubDelivery:  "${duplicate.name}" (${duplicate.id}), active=${duplicate.active}`);

  const willArchive = duplicate.active !== false;
  const willActivateDelivery = String(delivery.status) !== 'active';

  console.log('');
  console.log(willArchive
    ? `  -> archive duplicate: active true -> false, name -> "${duplicate.name}${ARCHIVE_SUFFIX}"`
    : '  -> duplicate already inactive, no change');
  console.log(willActivateDelivery
    ? '  -> Delivery.status: draft -> active (RouteGroup stays inactive/draft; not a live-traffic change)'
    : '  -> Delivery.status already active, no change');

  if (APPLY) {
    if (willArchive) {
      await SubDelivery.update(duplicate.id, { active: false, name: `${duplicate.name}${ARCHIVE_SUFFIX}` });
      console.log('  APPLIED: duplicate archived.');
    }
    if (willActivateDelivery) {
      await Delivery.update(delivery.id, { status: 'active' });
      console.log('  APPLIED: Delivery activated.');
    }
  } else {
    console.log('\n[normalize-walker-tiers] Report only. Re-run with --apply to write the above.');
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('[normalize-walker-tiers] FAILED:', err.message);
  try { await pool.end(); } catch { /* already closed */ }
  process.exit(1);
});
