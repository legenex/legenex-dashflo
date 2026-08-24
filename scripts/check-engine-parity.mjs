// Blocking parity check: regenerates the backend engine bundle in memory and
// compares it to the committed generated file. Fails (exit 1) if they differ,
// which means the canonical source under client/src/lib/distribution/
// changed without regenerating the backend copy. This is what guarantees
// there is exactly one engine and no silent drift, per AGENTS.md invariant
// 13 ("change generated code only through its source and generator").
//
// Also fails if a hand-written routing-engine mirror is reintroduced into
// server/src/functions.
//
// Restored and adapted from the original upstream check-engine-parity.mjs
// (https://github.com/legenex/legenex-dashboard, never ported into this
// repository - see docs/GROUND-TRUTH.md item 8). The original also governed
// two sibling generated files in that project's Base44 layout
// (base44/functions/_shared/{supplierRules,outboundPayload}.generated.js)
// via CONSUMER_DIRS fan-out that does not apply here. This repository's
// server/src/functions/supplierRules.generated.js and
// outboundPayload.generated.js are the same kind of orphaned generated file
// this script restores protection for, but wiring their own generators back
// in is a separate, out-of-scope task - see docs/STATE.md.
//
// Run: node scripts/check-engine-parity.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBundle, OUT_PATH } from './generate-backend-engine.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const functionsDir = path.join(repoRoot, 'server/src/functions');

export function firstDiffLine(a, b) {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i++) {
    if (aLines[i] !== bLines[i]) {
      return { line: i + 1, committed: aLines[i] ?? '<EOF>', generated: bLines[i] ?? '<EOF>' };
    }
  }
  return null;
}

// Anti-mirror: no hand-written routing-engine DEFINITION may exist anywhere
// in server/src/functions outside the generated file itself. Calling the
// bundled engine (engine.routeWaterfall(...), engine.evaluateMember(...)) is
// allowed; DEFINING routing functions by hand is not.
export const FORBIDDEN = [
  [/function\s+routeWaterfall\b/, 'routeWaterfall'],
  [/\brouteWaterfall\s*=\s*(async\s*)?\(/, 'routeWaterfall'],
  [/function\s+evaluateMember\b/, 'evaluateMember'],
  [/\bevaluateMember\s*=\s*(async\s*)?\(/, 'evaluateMember'],
  [/function\s+classifyResponse\b/, 'classifyResponse'],
  [/\bclassifyResponse\s*=\s*(async\s*)?\(/, 'classifyResponse'],
  [/function\s+deliverDirectPost\b/, 'deliverDirectPost'],
  [/\bdeliverDirectPost\s*=\s*(async\s*)?\(/, 'deliverDirectPost'],
];

// Scans `dir` for hand-written mirrors of the canonical engine. Returns a
// list of { file, label } violations; empty when clean. `exclude` is an
// absolute path skipped entirely (the one allowed definition).
export function scanForHandWrittenMirror(dir, exclude) {
  const violations = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      violations.push(...scanForHandWrittenMirror(p, exclude));
      continue;
    }
    if (!p.endsWith('.js') && !p.endsWith('.mjs')) continue;
    if (p === exclude) continue;
    const src = readFileSync(p, 'utf8');
    for (const [re, label] of FORBIDDEN) {
      if (re.test(src)) violations.push({ file: p, label });
    }
  }
  return violations;
}

async function main() {
  let failed = false;
  const fail = (msg) => {
    console.error(`[check-engine-parity] FAIL: ${msg}`);
    failed = true;
  };

  // 1. Committed generated file must match a fresh generation from the
  // canonical source.
  let committed;
  try {
    committed = readFileSync(OUT_PATH, 'utf8');
  } catch {
    fail(`${path.relative(repoRoot, OUT_PATH)} is missing. Run: node scripts/generate-backend-engine.mjs`);
    process.exit(1);
  }

  const { content } = await generateBundle();
  if (committed !== content) {
    const diff = firstDiffLine(committed, content);
    fail(`${path.relative(repoRoot, OUT_PATH)} is stale relative to client/src/lib/distribution/backend-entry.js and its imports.`);
    if (diff) {
      console.error(`  first difference at line ${diff.line}:`);
      console.error(`    committed:  ${JSON.stringify(diff.committed)}`);
      console.error(`    generated:  ${JSON.stringify(diff.generated)}`);
    }
    console.error('  Run: node scripts/generate-backend-engine.mjs, then commit the regenerated file.');
  }

  // 2. Anti-mirror scan.
  for (const v of scanForHandWrittenMirror(functionsDir, OUT_PATH)) {
    fail(`hand-written routing logic (${v.label}) found in ${path.relative(repoRoot, v.file)}. Use the canonical engine via routingEngine.generated.js instead of redefining it.`);
  }

  if (failed) process.exit(1);
  console.log('[check-engine-parity] PASS: routingEngine.generated.js matches canonical source; no hand-written mirror.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
