// Switch a buyer's RouteMember(s) from price_mode:'fixed' to price_mode:'rule'.
// Generic, buyer-agnostic tooling (per the Stage 4 lesson: no buyer name is
// ever a default - see native-delivery-dry-run.js's own --buyer requirement).
//
// 'rule' mode prices a real routing evaluation from the buyer's own active
// BuyerStateCpl coverage (client/src/lib/distribution/snapshot.js /
// snapshotLoader.js, wired Stage 5) instead of a single RouteMember.fixed_price
// value. This never touches BuyerStateCpl itself, RouteGroup.active/lifecycle,
// or distribution_mode - it only changes how one already-existing RouteMember's
// price is resolved once it is otherwise eligible to route.
//
// Usage:
//   node scripts/set-buyer-rule-pricing.js --buyer "Acme Corp"            report only
//   node scripts/set-buyer-rule-pricing.js --buyer "Acme Corp" --apply    write it

import { ensureSchema } from '../src/db/schema.js';
import { repo } from '../src/db/repo.js';
import { pool } from '../src/db/pool.js';

const APPLY = process.argv.includes('--apply');
const buyerIdx = process.argv.indexOf('--buyer');
const BUYER_NAME = buyerIdx > -1 ? process.argv[buyerIdx + 1] : null;
if (!BUYER_NAME) {
  console.log('[set-buyer-rule-pricing] Usage: node scripts/set-buyer-rule-pricing.js --buyer "<company_name>" [--apply]');
  process.exit(1);
}

async function main() {
  await ensureSchema();
  const Buyer = repo('Buyer');
  const RouteMember = repo('RouteMember');
  const BuyerStateCpl = repo('BuyerStateCpl');

  const buyers = await Buyer.list('-created_date', 1000);
  const buyer = buyers.find((b) => b.company_name === BUYER_NAME);
  if (!buyer) { console.log(`[set-buyer-rule-pricing] No Buyer found with company_name "${BUYER_NAME}".`); await pool.end(); return; }
  console.log(`[set-buyer-rule-pricing] Buyer: ${buyer.company_name} (id ${buyer.id})`);

  const cplRows = await BuyerStateCpl.filter({ buyer_id: buyer.id }, '-created_date', 1000);
  const activeCplCount = cplRows.filter((r) => r.active === true).length;
  console.log(`[set-buyer-rule-pricing] BuyerStateCpl coverage: ${cplRows.length} row(s), ${activeCplCount} active.`);
  if (activeCplCount === 0) {
    console.log('[set-buyer-rule-pricing] Refusing: no active BuyerStateCpl coverage exists for this buyer, so rule-mode pricing would have nothing to resolve from. Populate BuyerStateCpl first.');
    await pool.end();
    return;
  }

  const members = await RouteMember.list('-created_date', 1000);
  const mine = members.filter((m) => String(m.buyer_id) === String(buyer.id));
  if (mine.length === 0) { console.log('[set-buyer-rule-pricing] No RouteMember rows for this buyer.'); await pool.end(); return; }

  let touched = 0;
  for (const m of mine) {
    const current = m.price_mode || 'fixed';
    if (current === 'rule') {
      console.log(`  RouteMember ${m.id}: already price_mode=rule, no change.`);
      continue;
    }
    console.log(`  RouteMember ${m.id}: price_mode ${current} -> rule (fixed_price ${m.fixed_price == null ? '(null, now unused)' : `${m.fixed_price} (now unused)`})`);
    if (APPLY) {
      await RouteMember.update(m.id, { price_mode: 'rule' });
      touched += 1;
    }
  }

  if (!APPLY) {
    console.log(`\n[set-buyer-rule-pricing] Report only. Re-run with --apply to write ${mine.filter((m) => (m.price_mode || 'fixed') !== 'rule').length} RouteMember(s).`);
  } else {
    console.log(`\n[set-buyer-rule-pricing] Applied to ${touched} RouteMember row(s).`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('[set-buyer-rule-pricing] FAILED:', err.message);
  try { await pool.end(); } catch { /* already closed */ }
  process.exit(1);
});
