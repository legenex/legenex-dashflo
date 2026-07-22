import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Static regression proof that the shadow hook cannot alter the legacy supplier
// response. When distribution_mode = legacy_only (production default) the whole
// block is skipped, so the response path is byte-identical to the pre-hook code.
// Combined with shadowHook.test.js proving runShadow is a no-op on legacy_only.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const entry = readFileSync(join(root, 'api/functions/processLead/entry.ts'), 'utf8');

// Extract the hook block: from its marker comment to the matching closing brace.
function hookBlock(src) {
  const start = src.indexOf('Distribution engine SHADOW hook');
  const guardIdx = src.indexOf("if (distributionMode !== 'legacy_only')", start);
  // slice a generous window; the block is short and self-contained
  return src.slice(guardIdx, guardIdx + 1400);
}

describe('shadow hook is inert on legacy_only (static regression)', () => {
  it('distribution_mode defaults to legacy_only', () => {
    expect(entry).toMatch(/distributionMode\s*=/);
    expect(entry).toContain("? distModeRaw : 'legacy_only'");
  });

  it('the hook is fully guarded by the legacy_only check', () => {
    expect(entry).toContain("if (distributionMode !== 'legacy_only')");
    // exactly one such guard
    const count = (entry.match(/if \(distributionMode !== 'legacy_only'\)/g) || []).length;
    expect(count).toBe(1);
  });

  it('inside the hook, the ONLY entity write is RouteDecisionTrace (no response/lead mutation)', () => {
    const block = hookBlock(entry);
    const writes = block.match(/db\.entities\.(\w+)\.(create|update|delete)/g) || [];
    for (const w of writes) expect(w).toContain('RouteDecisionTrace');
    // does not return from the handler or touch the response envelope
    expect(block).not.toMatch(/\breturn\b/);
    expect(block).not.toMatch(/supplierResponse|buildEnvelope|Response\.json/);
  });

  it('the engine is loaded lazily (dynamic import) so legacy_only never loads it', () => {
    const block = hookBlock(entry);
    expect(block).toContain("await import('./routingEngine.generated.js')");
    // no top-level static import of the generated engine (would run even on legacy_only)
    expect(entry).not.toMatch(/^import .*routingEngine\.generated/m);
  });
});
