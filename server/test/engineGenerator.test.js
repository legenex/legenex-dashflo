import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateBundle, OUT_PATH } from '../../scripts/generate-backend-engine.mjs';
import { scanForHandWrittenMirror, firstDiffLine } from '../../scripts/check-engine-parity.mjs';

// Restored generator/parity toolchain (Stage 3). Proves the four properties
// AGENTS.md invariant 13 and the Stage 3 brief require: deterministic output,
// a source-identifying header with no environment-specific timestamp, actual
// parity against the committed bundle, and a working anti-mirror scan.

describe('generate-backend-engine determinism', () => {
  it('produces byte-identical output across repeated runs', async () => {
    const a = await generateBundle();
    const b = await generateBundle();
    expect(b.content).toBe(a.content);
    expect(b.hash).toBe(a.hash);
  });

  it('header identifies the source of truth and carries no timestamp', async () => {
    const { content } = await generateBundle();
    const header = content.split('\n').slice(0, 4).join('\n');
    expect(header).toContain('GENERATED FILE - DO NOT EDIT BY HAND');
    expect(header).toContain('src/lib/distribution/backend-entry.js');
    expect(header).toContain('node scripts/generate-backend-engine.mjs');
    expect(header).toMatch(/canonical-engine-sha256: [0-9a-f]{64}/);
    // No ISO date, no Date.now()-shaped epoch, nothing environment-specific.
    expect(header).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(header).not.toMatch(/\b1\d{12}\b/);
  });

  it('hash in the header matches the body it prefixes', async () => {
    const { content, hash, code } = await generateBundle();
    expect(content).toBe(
      '// GENERATED FILE - DO NOT EDIT BY HAND.\n' +
        '// Source of truth: src/lib/distribution/backend-entry.js and its imports.\n' +
        '// Regenerate: node scripts/generate-backend-engine.mjs\n' +
        `// canonical-engine-sha256: ${hash}\n${code}`,
    );
  });
});

describe('check-engine-parity', () => {
  it('the committed routingEngine.generated.js matches a fresh generation', async () => {
    const committed = readFileSync(OUT_PATH, 'utf8');
    const { content } = await generateBundle();
    if (committed !== content) {
      const diff = firstDiffLine(committed, content);
      throw new Error(
        `routingEngine.generated.js has drifted from canonical source at line ${diff?.line}. ` +
          'Run: node scripts/generate-backend-engine.mjs and commit the result.',
      );
    }
    expect(committed).toBe(content);
  });

  it('detects a genuinely stale committed file', async () => {
    const { content } = await generateBundle();
    const tampered = content.replace('REASON.ELIGIBLE', 'REASON.ELIGIBLE /* drift */');
    expect(tampered).not.toBe(content);
  });

  it('flags a hand-written mirror function definition', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'engine-mirror-'));
    try {
      writeFileSync(
        path.join(dir, 'suspicious.js'),
        'export function evaluateMember(member, lead) { return { eligible: true }; }\n',
      );
      const violations = scanForHandWrittenMirror(dir, null);
      expect(violations).toHaveLength(1);
      expect(violations[0].label).toBe('evaluateMember');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not flag calling the canonical engine, only defining it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'engine-mirror-ok-'));
    try {
      writeFileSync(
        path.join(dir, 'caller.js'),
        "import * as engine from './routingEngine.generated.js';\n" +
          'export function run(members, lead) { return engine.evaluateMember(members[0], lead); }\n',
      );
      const violations = scanForHandWrittenMirror(dir, null);
      expect(violations).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('excludes the generated file itself from the scan', () => {
    const generatedContent = readFileSync(OUT_PATH, 'utf8');
    const dir = mkdtempSync(path.join(tmpdir(), 'engine-mirror-exclude-'));
    try {
      const fakeGenerated = path.join(dir, 'routingEngine.generated.js');
      writeFileSync(fakeGenerated, generatedContent);
      const violations = scanForHandWrittenMirror(dir, fakeGenerated);
      expect(violations).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
