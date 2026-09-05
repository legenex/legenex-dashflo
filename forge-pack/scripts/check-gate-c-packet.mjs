// Goal predicate for W10-GATEC.
//
// Checks that every line of the Gate C evidence list in docs/HUMAN-GATES.md has
// a corresponding section in the packet, and that the packet contains no
// question a test could answer. Structural check only: the owner judges the
// packet, this just refuses to send an incomplete one.
// Run: node forge-pack/scripts/check-gate-c-packet.mjs

import { readFileSync, existsSync } from 'node:fs';

const PATH = 'docs/GATE-C-PACKET.md';
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!existsSync(PATH)) fail(`${PATH} does not exist.`);
const text = readFileSync(PATH, 'utf8');
const lower = text.toLowerCase();

// Derived from docs/HUMAN-GATES.md Gate C, plus the two additions in CONTRACT D7.
const REQUIRED = [
  'green root gate',
  'security review',
  'authorization matrix',
  'receipt crash and replay',
  'dnc all-path',            // stands unchanged per CONTRACT D3
  'routing and shadow',
  'portal isolation',
  'delivery and billing idempotency',
  'migration and monetary reconciliation',
  'backup restore drill',
  'load and latency',
  'first-supplier manifest',
  'success thresholds',
  'kill switch',
  'rollback',
  'live pricing'             // CONTRACT D7
];

const missing = REQUIRED.filter((r) => !lower.includes(r));
if (missing.length) {
  console.error('FAIL: packet is missing required evidence sections:');
  for (const m of missing) console.error('  - ' + m);
  process.exit(1);
}

// Every decision must carry a recommendation and a consequence, per the template.
const decisions = text.split('\n').filter((l) => /^\s*\d+\.\s/.test(l) && /decision/i.test(l));
const weak = decisions.filter((l) => !/recommend/i.test(l) || !/consequence/i.test(l));
if (weak.length) {
  console.error('FAIL: decisions without a recommendation and a consequence:');
  for (const w of weak) console.error('  ' + w.trim());
  process.exit(1);
}

if (!/no question in this packet is answerable by code, tests, exports or history/i.test(text)) {
  fail('packet must carry the explicit self-check required by docs/HUMAN-GATES.md.');
}

console.log(`PASS: all ${REQUIRED.length} evidence sections present, ${decisions.length} decision(s) carry a recommendation and a consequence.`);
