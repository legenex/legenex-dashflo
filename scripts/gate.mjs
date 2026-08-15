// The root gate.
//
// One command that must pass before any commit on the cutover branch. It runs
// every check that can be run without a live endpoint, a production database,
// or a credential.
//
// Run: npm run gate

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STEPS = [
  {
    name: 'tests',
    describe: 'full test suite behind the outbound network guard',
    cmd: 'npx',
    args: ['vitest', 'run', '--reporter=dot'],
  },
  {
    name: 'function-loader',
    describe: 'every backend function module default-exports a handler',
    cmd: 'node',
    args: ['scripts/verify-function-loader.mjs'],
  },
  {
    name: 'lint',
    describe: 'client lint with the project rules unchanged',
    cmd: 'npm',
    args: ['--prefix', 'client', 'run', 'lint'],
  },
  {
    name: 'build',
    describe: 'client production build',
    cmd: 'npm',
    args: ['--prefix', 'client', 'run', 'build'],
  },
  {
    name: 'bundle-purity',
    describe: 'no test code in the production bundle',
    cmd: 'node',
    args: ['scripts/check-bundle-purity.mjs'],
  },
  {
    name: 'secret-scan',
    describe: 'no credential-shaped literals in tracked files',
    cmd: 'node',
    args: ['scripts/secret-scan.mjs'],
  },
  {
    name: 'em-dash',
    describe: 'no em dashes in lines this branch adds',
    cmd: 'node',
    args: ['scripts/check-em-dashes.mjs'],
  },
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const steps = only.length > 0 ? STEPS.filter((s) => only.includes(s.name)) : STEPS;

if (steps.length === 0) {
  console.error(`No matching gate step. Available: ${STEPS.map((s) => s.name).join(', ')}`);
  process.exit(2);
}

const results = [];
let failed = false;

for (const step of steps) {
  console.log(`\n${'='.repeat(72)}\n[gate] ${step.name}: ${step.describe}\n${'='.repeat(72)}`);
  const started = Date.now();
  const res = spawnSync(step.cmd, step.args, { cwd: repoRoot, stdio: 'inherit', shell: false });
  const ms = Date.now() - started;
  const ok = res.status === 0;
  results.push({ name: step.name, ok, ms, status: res.status });
  if (!ok) {
    failed = true;
    // Keep going so one run reports every problem rather than only the first.
  }
}

console.log(`\n${'='.repeat(72)}\n[gate] summary\n${'='.repeat(72)}`);
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(18)} ${(r.ms / 1000).toFixed(1)}s`);
}

if (failed) {
  console.error('\n[gate] FAILED. Fix the steps above before committing.');
  process.exit(1);
}
console.log('\n[gate] PASSED.');
