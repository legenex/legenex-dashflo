// Backfill Lead.buyer_record_id and Lead.buyer_code. Task R1.
//
// Usage:
//   node scripts/backfill-buyer-identity.js                 report only
//   node scripts/backfill-buyer-identity.js --apply         write the patches
//   node scripts/backfill-buyer-identity.js --out report.json
//
// Additive and restartable. It only ever sets the two new fields, never
// touches `buyer_id`, and a lead that is already normalized produces no write,
// so an interrupted run is resumed by running it again.
//
// Anything that cannot be resolved goes on the exception report rather than
// being guessed. Attaching a lead to the wrong buyer delivers to the wrong
// customer and charges the wrong account.

import fs from 'node:fs';
import { ensureSchema } from '../src/db/schema.js';
import { pool } from '../src/db/pool.js';
import { repo } from '../src/db/repo.js';
import { reconcile } from '../src/lib/buyerIdentity.js';

const APPLY = process.argv.includes('--apply');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > -1 ? process.argv[outIdx + 1] : null;

const PAGE = 500;

async function main() {
  await ensureSchema();
  const Lead = repo('Lead');
  const Buyer = repo('Buyer');

  const buyers = await Buyer.list('-created_date', 10_000);
  console.log(`[backfill-buyer-identity] ${buyers.length} buyers loaded`);

  const totals = {
    total: 0, resolved: 0, already_normalized: 0, needs_write: 0,
    unresolved: 0, ambiguous: 0, no_buyer: 0,
  };
  const methodTotals = {};
  const allExceptions = [];
  let written = 0;
  let offset = 0;

  for (;;) {
    const leads = await Lead.list('-created_date', PAGE, offset);
    if (!leads.length) break;

    const { counts, byMethod, exceptions, patches } = reconcile(leads, buyers);

    for (const k of Object.keys(totals)) totals[k] += counts[k];
    for (const [k, v] of Object.entries(byMethod)) methodTotals[k] = (methodTotals[k] || 0) + v;
    allExceptions.push(...exceptions);

    if (APPLY) {
      for (const { id, patch } of patches) {
        await Lead.update(id, patch);
        written += 1;
      }
    }

    offset += leads.length;
    if (leads.length < PAGE) break;
    if (offset % 5000 === 0) console.log(`[backfill-buyer-identity] scanned ${offset}`);
  }

  console.log('');
  console.log(`[backfill-buyer-identity] mode: ${APPLY ? 'APPLY' : 'REPORT ONLY'}`);
  console.log(`  leads scanned      ${totals.total}`);
  console.log(`  resolved           ${totals.resolved}`);
  console.log(`    already correct  ${totals.already_normalized}`);
  console.log(`    ${APPLY ? 'written' : 'to write'}         ${APPLY ? written : totals.needs_write}`);
  console.log(`  no buyer on lead   ${totals.no_buyer}`);
  console.log(`  unresolved         ${totals.unresolved}`);
  console.log(`  ambiguous          ${totals.ambiguous}`);
  console.log('');
  console.log('  resolved via:');
  for (const [method, n] of Object.entries(methodTotals).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${method.padEnd(12)} ${n}`);
  }

  // Reconciliation check. Every lead lands in exactly one bucket, and if it
  // does not, the arithmetic says so rather than the report looking complete.
  const bucketed = totals.resolved + totals.unresolved + totals.ambiguous + totals.no_buyer;
  if (bucketed !== totals.total) {
    console.log('');
    console.log(`  RECONCILIATION FAILED: ${bucketed} bucketed vs ${totals.total} scanned`);
    process.exitCode = 1;
  }

  if (allExceptions.length) {
    console.log('');
    console.log(`  ${allExceptions.length} lead(s) need a human decision.`);
    const sample = allExceptions.slice(0, 20);
    for (const e of sample) {
      console.log(`    ${e.lead_id}  ${e.reason.padEnd(11)} ${e.on}=${JSON.stringify(e.value)}`);
    }
    if (allExceptions.length > sample.length) {
      console.log(`    ... and ${allExceptions.length - sample.length} more. Use --out to write the full list.`);
    }
  }

  if (OUT) {
    // The report carries lead ids and buyer identifiers only. No contact
    // fields, so this artifact is safe to hand to a human.
    fs.writeFileSync(OUT, `${JSON.stringify({
      generated_for: 'R1 buyer identity reconciliation',
      mode: APPLY ? 'apply' : 'report',
      totals,
      resolved_via: methodTotals,
      exceptions: allExceptions,
    }, null, 2)}\n`);
    console.log('');
    console.log(`  Full exception report written to ${OUT}`);
  }

  if (!APPLY && totals.needs_write) {
    console.log('');
    console.log('  Re-run with --apply to write these patches.');
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('[backfill-buyer-identity] FAILED:', err.message);
  try { await pool.end(); } catch { /* already closed */ }
  process.exit(1);
});
