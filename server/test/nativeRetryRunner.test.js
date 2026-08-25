import { describe, it, expect } from 'vitest';
import { runNativeRetryPass } from '../src/lib/nativeRetryRunner.js';
import { MODES } from '../../client/src/lib/distribution/modeControl.js';

// Only AppSettings is needed for the fail-closed-path assertions below: the
// function returns before touching any other entity when the mode gate
// itself does not open.
function makeDb(distributionMode) {
  return {
    entities: {
      AppSettings: { list: async () => [{ id: 's1', distribution_mode: distributionMode }] },
    },
  };
}

describe('runNativeRetryPass: mode gate is a fail-closed allowlist, not a bare != legacy_only check', () => {
  it('stays off for legacy_only', async () => {
    const out = await runNativeRetryPass(makeDb('legacy_only'), { workerId: 'w1' });
    expect(out.ran).toBe(false);
  });

  it('stays off for an unrecognized/drifted mode string, e.g. the historical "dual"', async () => {
    // Regression: this gate used to be `if (mode === 'legacy_only') return {ran:false}`,
    // which is fail-OPEN for any other string - including a typo or a drifted
    // value like distributionSetMode.js's old 'dual' (vs the canonical
    // 'new_primary_with_legacy_fallback' every other module uses). An
    // unrecognized mode must leave retries off, the same way processLead.js's
    // own separate allowlist already treats it as legacy_only rather than as
    // "anything goes".
    const out = await runNativeRetryPass(makeDb('dual'), { workerId: 'w1' });
    expect(out.ran).toBe(false);
    expect(out.reason).toContain('does not enable native delivery');
  });

  it('stays off for a blank/missing distribution_mode', async () => {
    const out = await runNativeRetryPass(makeDb(''), { workerId: 'w1' });
    expect(out.ran).toBe(false);
  });

  it('opens for every real native mode MODES declares', async () => {
    for (const mode of MODES.filter((m) => m !== 'legacy_only')) {
      const db = {
        entities: {
          AppSettings: { list: async () => [{ id: 's1', distribution_mode: mode }] },
          DeliveryAttempt: undefined,
          DestinationHealth: undefined,
        },
      };
      const out = await runNativeRetryPass(db, { workerId: 'w1' });
      expect(out.ran, `mode "${mode}" should open the gate`).toBe(true);
      expect(out.mode).toBe(mode);
    }
  });
});
