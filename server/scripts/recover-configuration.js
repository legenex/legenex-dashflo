// Configuration recovery report. Task C1.
//
// Usage:
//   node scripts/recover-configuration.js
//   node scripts/recover-configuration.js --out gate-b-exceptions.json
//
// Read only. It writes nothing to the database.
//
// The output is the raw material for the Gate B packet: what was recovered
// automatically, and the exceptions that genuinely need a human. HUMAN-GATES.md
// is explicit that a packet containing a question code could have answered is
// not ready to send, so anything derivable is derived here instead of asked.
//
// No credential value and no contact detail enters this report. Credential
// references appear by name only.

import fs from 'node:fs';
import { ensureSchema } from '../src/db/schema.js';
import { pool } from '../src/db/pool.js';
import { repo } from '../src/db/repo.js';
import { recoverConfiguration, SEVERITY } from '../src/lib/configRecovery.js';

const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > -1 ? process.argv[outIdx + 1] : null;

const LIMIT = 10_000;

async function main() {
  await ensureSchema();

  const [buyers, suppliers, apiKeys, campaigns, verticals, dncEntries] = await Promise.all([
    repo('Buyer').list('-created_date', LIMIT),
    repo('Supplier').list('-created_date', LIMIT),
    repo('ApiKey').list('-created_date', LIMIT),
    repo('Campaign').list('-created_date', LIMIT),
    repo('Vertical').list('-created_date', LIMIT),
    repo('DncEntry').list('-created_date', LIMIT).catch(() => []),
  ]);

  const report = recoverConfiguration({
    buyers, suppliers, apiKeys, campaigns, verticals, dncEntries, env: process.env,
  });

  console.log('[recover-configuration] recovered automatically:');
  for (const [k, v] of Object.entries(report.recovered)) {
    console.log(`  ${k.padEnd(14)} ${v}`);
  }

  console.log('');
  console.log(`[recover-configuration] findings: ${report.findings.length}`);
  console.log(`  blockers   ${report.bySeverity.blocker}`);
  console.log(`  questions  ${report.bySeverity.question}`);
  console.log(`  info       ${report.bySeverity.info}`);

  for (const severity of [SEVERITY.BLOCKER, SEVERITY.QUESTION, SEVERITY.INFO]) {
    const group = report.findings.filter((f) => f.severity === severity);
    if (!group.length) continue;
    console.log('');
    console.log(`  ${severity.toUpperCase()}`);
    for (const f of group) {
      const subject = f.subject ? ` [${f.subject}]` : '';
      const value = f.value ? ` (${f.value})` : '';
      console.log(`    ${f.area}/${f.code}${subject}${value}`);
      console.log(`      ${f.message}`);
    }
  }

  console.log('');
  console.log(report.ready_for_gate_b
    ? '[recover-configuration] No blockers. The remaining findings are genuine Gate B questions.'
    : '[recover-configuration] Blockers present. Resolve these in configuration before sending a Gate B packet.');

  if (OUT) {
    fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[recover-configuration] Full report written to ${OUT}`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('[recover-configuration] FAILED:', err.message);
  try { await pool.end(); } catch { /* already closed */ }
  process.exit(1);
});
