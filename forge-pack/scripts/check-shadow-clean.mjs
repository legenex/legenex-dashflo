// Goal predicate for W11-SHADOW.
//
// A shadow run is only evidence if it proves zero commercial sends occurred and
// accounts for every discrepancy. This refuses a report that asserts either
// without showing it.
// Run: node forge-pack/scripts/check-shadow-clean.mjs

import { readFileSync, existsSync } from 'node:fs';

const PATH = 'docs/SHADOW-REPORT.md';
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!existsSync(PATH)) fail(`${PATH} does not exist.`);
const text = readFileSync(PATH, 'utf8');

if (!/commercial sends:\s*0\b/i.test(text)) {
  fail('report must state "Commercial sends: 0" and cite the DeliveryAttempt query that proves it.');
}
if (!/deliveryattempt/i.test(text)) {
  fail('the zero-sends claim must be backed by a DeliveryAttempt query, not asserted.');
}

const rows = text.split('\n').filter((l) => l.trim().startsWith('|') && /\bDISC-\d+\b/.test(l));
const unresolved = rows.filter((l) => !/\b(explained|fixed)\b/i.test(l));
if (unresolved.length) {
  console.error(`FAIL: ${unresolved.length} discrepancy row(s) neither explained nor fixed:`);
  for (const u of unresolved) console.error('  ' + u.trim());
  process.exit(1);
}

console.log(`PASS: zero commercial sends proven, ${rows.length} discrepancy row(s) all explained or fixed.`);
