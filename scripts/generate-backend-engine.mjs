// Generates the single self-contained backend routing-engine bundle from the
// canonical source (client/src/lib/distribution/backend-entry.js). The output
// is a no-import ESM module that server/src/functions/*.js consume directly
// via `import * as engine from './routingEngine.generated.js'`, plus a
// content-hash header.
//
// This is the allowed "generated copy" mechanism for one canonical engine:
// the backend never hand-maintains a routing mirror; it consumes this
// generated file, and a blocking parity check
// (scripts/check-engine-parity.mjs) fails the gate if the file is stale
// relative to the canonical source.
//
// Restored from the original upstream generator at
// https://github.com/legenex/legenex-dashboard scripts/generate-backend-engine.mjs
// (never ported into this repository, see docs/GROUND-TRUTH.md item 8 and
// docs/STATE.md's Lead Distribution rebuild Stage 1/2 entries) and adapted
// from that project's Base44 multi-copy-per-function layout to this
// repository's single dynamically-loaded server/src/functions/ module. The
// esbuild options (bundle, format esm, platform neutral, target es2022,
// legalComments none) are unchanged from the original: reproducing them
// against the current canonical source yields an output byte-identical to
// the routingEngine.generated.js already committed here, which is how this
// restoration was verified.
//
// Run: node scripts/generate-backend-engine.mjs

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = path.join(repoRoot, 'client');
const ENTRY = 'src/lib/distribution/backend-entry.js';
export const OUT_PATH = path.join(repoRoot, 'server/src/functions/routingEngine.generated.js');

export async function generateBundle() {
  const result = await build({
    entryPoints: [ENTRY],
    absWorkingDir: clientDir,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    legalComments: 'none',
    write: false,
  });
  const code = result.outputFiles[0].text;
  const hash = createHash('sha256').update(code).digest('hex');
  const header =
    '// GENERATED FILE - DO NOT EDIT BY HAND.\n' +
    '// Source of truth: src/lib/distribution/backend-entry.js and its imports.\n' +
    '// Regenerate: node scripts/generate-backend-engine.mjs\n' +
    `// canonical-engine-sha256: ${hash}\n`;
  return { code, hash, content: header + code };
}

async function main() {
  const { content, hash } = await generateBundle();
  writeFileSync(OUT_PATH, content);
  console.log(`[generate-backend-engine] wrote ${path.relative(repoRoot, OUT_PATH)} (canonical-engine-sha256: ${hash})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
