// Goal predicate for W0-AUDIT and (with --closed) W8-CONGRUENCE.
//
// This checks the SHAPE of the evidence, not the truth of it. A structural pass
// means the map is usable by a later unit; it does not mean the audit was good.
// The evaluator judges quality. Run: node forge-pack/scripts/check-gap-map.mjs [--closed]

import { readFileSync, existsSync } from 'node:fs';

const PATH = 'docs/GAP-MAP.md';
const closedMode = process.argv.includes('--closed');
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };

if (!existsSync(PATH)) fail(`${PATH} does not exist. W0-AUDIT produces it.`);
const lines = readFileSync(PATH, 'utf8').split('\n');

const items = lines.filter((l) => l.trim().startsWith('|') && /\bGAP-\d+\b/.test(l));
if (items.length === 0) fail('no items found. Each item needs an id matching GAP-<number>.');

const problems = [];
for (const line of items) {
  const id = line.match(/GAP-\d+/)[0];
  if (!/[\w./-]+\.(js|jsx|json|md)\b/.test(line)) problems.push(`${id}: no file path cited`);
  if (!/\b\d+(\.\d+)?\s*h\b/i.test(line)) problems.push(`${id}: no hours estimate`);
  if (!/\b(P0|post-cutover|closed)\b/i.test(line)) problems.push(`${id}: no P0 / post-cutover / closed flag`);
  if (closedMode && /\bP0\b/i.test(line) && !/\b(closed|deferred:)/i.test(line)) {
    problems.push(`${id}: P0 item is neither closed nor deferred with a reason`);
  }
}

if (problems.length) {
  console.error(`FAIL: ${problems.length} problem(s) in ${PATH}`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`PASS: ${items.length} items, all cite a path, an estimate and a flag${closedMode ? ', and every P0 item is closed or deferred' : ''}.`);
