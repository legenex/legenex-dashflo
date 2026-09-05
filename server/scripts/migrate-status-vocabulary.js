// Run the W2-STATUS seven-status vocabulary migration against a real database.
// forge-pack/CONTRACT.md D1, D3 and D4.
//
// Usage:
//   node scripts/migrate-status-vocabulary.js                  report only
//   node scripts/migrate-status-vocabulary.js --apply          write the patches
//   node scripts/migrate-status-vocabulary.js --out report.json
//
//   npm --prefix server run migrate:status-vocabulary
//   npm --prefix server run migrate:status-vocabulary -- --apply
//
//
// WHY THIS FILE EXISTS
// --------------------
// Adversarial QA finding B1. server/src/lib/leadStatus.js held the whole
// migration (migrateStatusVocabulary, backfillLeadStatus,
// backfillConnectorTriggers and the two verification scans) and every one of
// them was correct, tested and completely unreachable: nothing in the
// repository called any of them outside the test suite. There was no npm
// script, no backend function, no CLI. So the unit whose entire job is to move
// 1,984 real leads onto the new vocabulary had no path by which a single real
// lead could ever be moved. The library was the work; this is the way to run
// it.
//
// It follows the convention server/scripts/backfill-buyer-identity.js
// established and server/src/functions/backfillLeadType.js mirrors on the
// backend side: report by default, an explicit flag to write, counts and
// exceptions on stdout, an optional machine-readable report, and a non-zero
// exit when the numbers do not reconcile.
//
//
// THE DRY RUN IS A REAL DRY RUN
// -----------------------------
// Without --apply this does not call a separate "planning" copy of the
// migration that could drift from the real one. It runs the SAME
// migrateStatusVocabulary against the real database through an entity
// namespace whose update() records the patch instead of performing it. Every
// row is loaded, every mapping decision is made and every exception is raised
// exactly as it would be on the real run, and the writes are collected rather
// than sent. A dry run that exercised different code would be worth very
// little on a migration whose whole risk is which rows it decides to touch.
//
// One consequence to read the output with: in report mode the two verification
// scans at the end of migrateStatusVocabulary see the database as it is NOW,
// before any of the planned writes, so retired connector trigger keys and
// pinned route statuses are reported as still present. That is the truth about
// the current state, not a failure of the plan, and the summary labels it.
//
//
// WHAT THIS HAS NOT BEEN RUN AGAINST
// ----------------------------------
// The same limitation W1-FLAGS and W2-STATUS's own test suite disclose.
// forge-pack/CONTRACT.md section 6 asks for this migration to run on a
// restored copy of production, with revenue matching to the cent afterwards.
// No restored production copy exists in this worktree, and restoring one is
// infrastructure work outside this unit. This script is the missing invokable
// path, tested against the same disposable Postgres the rest of the suite
// uses; running it on real data with a fresh backup taken first remains a
// required, and now actually possible, follow-up.

import fs from 'node:fs';
import { migrateStatusVocabulary } from '../src/lib/leadStatus.js';

// The entities this migration reads or writes. Named explicitly so the
// planning namespace below cannot silently miss one that a later edit adds.
export const MIGRATION_ENTITIES = Object.freeze([
  'Lead', 'ApiConnector', 'LeadByteConnector', 'InboundWebhookRoute',
]);

// A db whose reads are real and whose writes are collected. See the dry-run
// note above. create() and delete() throw rather than being silently allowed:
// this migration is additive by design and a future edit that started creating
// or deleting rows must not slip through a dry run looking harmless.
export function planningDb(db, plan) {
  const entities = {};
  for (const name of MIGRATION_ENTITIES) {
    const real = db.entities[name];
    entities[name] = {
      list: (...args) => real.list(...args),
      filter: (...args) => real.filter(...args),
      get: (...args) => real.get(...args),
      count: (...args) => real.count(...args),
      update: async (id, patch) => {
        plan.push({ entity: name, id, patch });
        return { id, ...patch };
      },
      create: async () => {
        throw new Error(`planningDb: the status migration must never create a ${name}`);
      },
      delete: async () => {
        throw new Error(`planningDb: the status migration must never delete a ${name}`);
      },
    };
  }
  return { entities };
}

// The whole operation, as a function, so a test can drive it against a
// disposable database without going anywhere near process.argv or the pool.
//
// `db` is the same { entities: { Lead, ... } } shape every backend function
// receives. Returns { mode, report, plan }, where plan is the list of writes
// (recorded in report mode, performed in apply mode).
export async function runStatusVocabularyMigration(db, { apply = false, at = new Date() } = {}) {
  const plan = [];
  const target = apply ? db : planningDb(db, plan);
  const report = await migrateStatusVocabulary(target, { at });
  return { mode: apply ? 'apply' : 'report', report, plan };
}

// Formats the run for a human. Kept separate from the run itself so the
// function above stays usable from a test, a backend function or another
// script without printing anything.
export function formatSummary({ mode, report, plan }) {
  const lines = [];
  const say = (s = '') => lines.push(s);
  const { counts, exceptions } = report.leads;
  const connectors = report.connectors.counts;
  const v = report.verification;

  say('');
  say(`[migrate-status-vocabulary] mode: ${mode === 'apply' ? 'APPLY' : 'REPORT ONLY'}`);
  say('');
  say('  leads');
  say(`    scanned                ${counts.total}`);
  say(`    ${mode === 'apply' ? 'migrated              ' : 'would migrate         '} ${counts.newly_migrated}`);
  say(`    already consistent     ${counts.verified_consistent}   (examined, stamped, no field changed)`);
  say(`    already migrated       ${counts.already_migrated}   (carried migrated_at before this run)`);
  say(`    unmapped               ${counts.unmapped}   (left untouched, never defaulted)`);
  say('');
  say('  resulting lead_status');
  for (const [value, n] of Object.entries(counts.by_status)) {
    say(`    ${String(value).padEnd(14)} ${n}`);
  }
  say('');
  say('  qualification signal');
  say(`    qualified              ${counts.qualified}`);
  say(`    not qualified          ${counts.not_qualified}`);
  say(`    unknown                ${counts.qualification_unknown}`);
  say('');
  say('  duplicates');
  say(`    linked to an original  ${counts.duplicates_linked}`);
  say(`    could not be linked    ${counts.duplicates_unlinked}`);
  say('');
  say('  connector triggers (D4 risk 1)');
  say(`    ApiConnector           ${connectors.api_connectors_remapped} of ${connectors.api_connectors} remapped`);
  say(`    LeadByteConnector      ${connectors.leadbyte_connectors_remapped} of ${connectors.leadbyte_connectors} remapped`);
  say(`    InboundWebhookRoute    ${connectors.inbound_routes_remapped} of ${connectors.inbound_routes} remapped`);
  say(`    retired keys found     ${connectors.legacy_trigger_keys_found}`);
  say('');
  say(`  ex-Error leads stamped migrated_at (D4 risk 3): ${counts.migrated_error_leads}`);
  say('');
  // In apply mode the writes went to the database rather than into `plan`, so
  // the figure is reconstructed from the counts. Printing plan.length there
  // would always read zero, which looks exactly like "it did nothing".
  const writes = mode === 'apply'
    ? counts.newly_migrated + counts.verified_consistent
      + connectors.api_connectors_remapped
      + connectors.leadbyte_connectors_remapped
      + connectors.inbound_routes_remapped
    : plan.length;
  say(`  writes ${mode === 'apply' ? 'performed' : 'planned'}: ${writes}`);

  say('');
  if (mode === 'apply') {
    say('  verification (post-migration)');
  } else {
    // Stated rather than left to be misread: in report mode nothing has been
    // written, so these scans describe the database as it stands today.
    say('  verification (PRE-migration state, because nothing was written)');
  }
  say(`    leads still on a retired value    ${v.leads_on_retired_status.length}`);
  say(`    retired trigger keys remaining    ${v.retired_trigger_keys_remaining.length}`);
  say(`    unmapped leads                    ${v.unmapped_leads}`);
  say(`    exceptions needing a human        ${v.exceptions}`);
  say(`    CLEAN                             ${v.clean ? 'yes' : 'NO'}`);

  if (exceptions.length) {
    say('');
    say(`  ${exceptions.length} lead(s) need a human decision:`);
    for (const e of exceptions.slice(0, 20)) {
      say(`    ${String(e.lead_id).padEnd(24)} ${e.reason}`);
    }
    if (exceptions.length > 20) {
      say(`    ... and ${exceptions.length - 20} more. Use --out to write the full list.`);
    }
  }

  if (mode !== 'apply' && plan.length) {
    say('');
    say('  Re-run with --apply to write these patches. Take a database backup first:');
    say('  this migration is additive and reverses by dropping the new keys, but a');
    say('  backup is what makes that claim cheap to act on.');
  }

  return lines.join('\n');
}

async function main() {
  const apply = process.argv.includes('--apply');
  const outIdx = process.argv.indexOf('--out');
  const out = outIdx > -1 ? process.argv[outIdx + 1] : null;

  const { ensureSchema } = await import('../src/db/schema.js');
  const { pool } = await import('../src/db/pool.js');
  const { entitiesNamespace } = await import('../src/db/repo.js');

  await ensureSchema();
  const db = { entities: entitiesNamespace() };

  const result = await runStatusVocabularyMigration(db, { apply });
  console.log(formatSummary(result));

  if (out) {
    // Lead ids, counts and reason codes only. No contact field and no
    // credential, so the artifact is safe to hand to a human.
    fs.writeFileSync(out, `${JSON.stringify({
      generated_for: 'W2-STATUS seven-status vocabulary migration (CONTRACT.md D1, D3, D4)',
      mode: result.mode,
      generated_at: new Date().toISOString(),
      counts: result.report.leads.counts,
      connector_counts: result.report.connectors.counts,
      connector_changes: result.report.connectors.changes,
      verification: result.report.verification,
      exceptions: result.report.leads.exceptions,
      planned_writes: result.mode === 'apply' ? undefined : result.plan.length,
    }, null, 2)}\n`);
    console.log('');
    console.log(`  Full report written to ${out}`);
  }

  // An applied run that did not come out clean is a failure the operator has
  // to see in the exit code, not only in the text above.
  if (apply && !result.report.verification.clean) {
    console.error('');
    console.error('[migrate-status-vocabulary] APPLIED, BUT NOT CLEAN. See the verification block above.');
    process.exitCode = 1;
  }

  await pool.end();
}

// Only run when invoked as a script, so the exports above can be imported by a
// test without the module trying to open a database connection.
if (process.argv[1] && process.argv[1].endsWith('migrate-status-vocabulary.js')) {
  main().catch(async (err) => {
    console.error('[migrate-status-vocabulary] FAILED:', err.message);
    try {
      const { pool } = await import('../src/db/pool.js');
      await pool.end();
    } catch { /* already closed, or never opened */ }
    process.exit(1);
  });
}
