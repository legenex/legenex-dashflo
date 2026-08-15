// Bundle purity check.
//
// Test code must never reach the browser bundle. It carries fixtures, sample
// payloads and assertions that describe internal behaviour, it is dead weight
// on every page load, and it is written on the assumption that only a test
// runner will ever read it.
//
// This is not hypothetical. client/src/components/progress/OffscreenCapture.jsx
// builds its capture targets with import.meta.glob('/src/pages/**'), so any
// colocated test file under a globbed directory becomes a real module in the
// production build. It was caught the first time only because the offending
// file used top-level await, which the browser target rejects. A test file
// without top-level await would have shipped silently.
//
// Run: node scripts/check-bundle-purity.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(repoRoot, 'client', 'dist');

// Markers that only ever appear in test code. Each is matched against the
// built asset text, so they are chosen to be things a real page would not say.
const MARKERS = [
  { needle: 'vitest', why: 'the vitest runner or its globals' },
  { needle: 'describe(', why: 'a test suite declaration' },
  { needle: 'toHaveLength', why: 'a test assertion' },
  { needle: 'toStrictEqual', why: 'a test assertion' },
  { needle: '__vitest', why: 'vitest internals' },
];

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

if (!fs.existsSync(distDir)) {
  console.error(`[bundle-purity] No build found at ${path.relative(repoRoot, distDir)}.`);
  console.error('[bundle-purity] Run the client build first. This check reads the build output.');
  process.exit(2);
}

const assets = walk(distDir).filter((f) => f.endsWith('.js') || f.endsWith('.css'));

if (assets.length === 0) {
  console.error('[bundle-purity] Build directory contains no assets. Refusing to pass vacuously.');
  process.exit(2);
}

const problems = [];

// A built asset named after a test file is the clearest signal of all.
for (const asset of assets) {
  const base = path.basename(asset);
  if (/[.-](test|spec)[.-]/i.test(base)) {
    problems.push(`${path.relative(repoRoot, asset)}: asset name identifies it as a test module`);
  }
}

for (const asset of assets) {
  let text;
  try {
    text = fs.readFileSync(asset, 'utf8');
  } catch {
    continue;
  }
  for (const { needle, why } of MARKERS) {
    if (text.includes(needle)) {
      problems.push(`${path.relative(repoRoot, asset)}: contains ${JSON.stringify(needle)}, which indicates ${why}`);
    }
  }
}

if (problems.length > 0) {
  console.error('[bundle-purity] FAILED: test code reached the production bundle.');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\n[bundle-purity] Most likely cause: an import.meta.glob pattern that matches');
  console.error('[bundle-purity] a colocated test file. Exclude it in the glob, for example');
  console.error("[bundle-purity]   import.meta.glob(['/src/pages/**/*.jsx', '!**/*.test.jsx'])");
  process.exit(1);
}

console.log(`[bundle-purity] OK: ${assets.length} built assets, no test code in the bundle.`);
