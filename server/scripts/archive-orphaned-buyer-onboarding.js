// Archive BuyerOnboarding rows whose buyer_id no longer resolves to any
// current Buyer record. Final engineering cleanup pass, task 4.
//
// Found during the 28 August 2026 production acceptance audit (docs/STATE.md,
// "Full production acceptance, part 2"): 2 of 8 BuyerOnboarding rows carry a
// buyer_id that does not exist in the current 13-buyer set. Re-audited here:
// both are dated July 2026, both have company_name literally "test" /
// "testjames" with no contact_email, and neither has been touched since the
// day it was created - textbook abandoned test submissions, not a real
// prospect's onboarding history. See docs/STATE.md for the exact ids.
//
// Usage:
//   node scripts/archive-orphaned-buyer-onboarding.js            report only
//   node scripts/archive-orphaned-buyer-onboarding.js --apply    archive the classified rows
//
// Report only by default. --apply writes ONLY status: 'cancelled' (an
// existing, terminal value in BuyerOnboarding.status's own enum) on rows
// classified as orphaned. It never deletes a row, never touches buyer_id or
// any other field, and never invents a buyer association for an ambiguous
// row - a row is only ever classified if its buyer_id is both present and
// unresolvable against the current Buyer set. Idempotent: a row already
// status:'cancelled' is not reported as a candidate a second time.

import { ensureSchema } from '../src/db/schema.js';
import { pool } from '../src/db/pool.js';
import { repo } from '../src/db/repo.js';

const APPLY = process.argv.includes('--apply');

// Unpaginated read. repo.list()'s default limit (100) would silently truncate
// once either table passes that count; both are well under it today, but the
// classification below must see every row, not a page of them.
async function loadAll(entityRepo) {
  const pageSize = 500;
  const out = [];
  let skip = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await entityRepo.list('-created_date', pageSize, skip);
    out.push(...batch);
    if (batch.length < pageSize) break;
    skip += pageSize;
  }
  return out;
}

async function main() {
  await ensureSchema();

  const onboardingRepo = repo('BuyerOnboarding');
  const buyerRepo = repo('Buyer');

  const [onboardingRows, buyers] = await Promise.all([
    loadAll(onboardingRepo),
    loadAll(buyerRepo),
  ]);
  const buyerIds = new Set(buyers.map((b) => b.id));

  const candidates = onboardingRows.filter((row) => (
    row.buyer_id && !buyerIds.has(row.buyer_id) && row.status !== 'cancelled'
  ));

  if (candidates.length === 0) {
    console.log('No orphaned BuyerOnboarding rows found.');
    await pool.end();
    return;
  }

  console.log(`${candidates.length} orphaned BuyerOnboarding row(s) (buyer_id set, resolves to no current Buyer):\n`);
  for (const row of candidates) {
    console.log(`  ${row.id}  status=${row.status}  company_name=${JSON.stringify(row.company_name || '')}  buyer_id=${row.buyer_id}  created_date=${row.created_date}`);
  }

  if (!APPLY) {
    console.log('\nReport only. Re-run with --apply to set status: "cancelled" on the rows above.');
    await pool.end();
    return;
  }

  console.log('\nApplying...');
  for (const row of candidates) {
    // eslint-disable-next-line no-await-in-loop
    await onboardingRepo.update(row.id, { status: 'cancelled' });
    console.log(`  archived ${row.id}`);
  }
  console.log('Done.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
