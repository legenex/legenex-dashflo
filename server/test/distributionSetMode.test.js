import { describe, it, expect } from 'vitest';
import distributionSetMode from '../src/functions/distributionSetMode.js';
import { MODES } from '../../client/src/lib/distribution/modeControl.js';

const OPERATOR = { id: 'u1', role: 'admin', base_role: 'operator' };

function makeDb({ settings = null, users = { u1: OPERATOR } } = {}) {
  const created = { audits: [], settingsUpdates: [] };
  let current = settings;
  return {
    created,
    entities: {
      User: { get: async (id) => users[id] || null },
      AppSettings: {
        list: async () => (current ? [current] : []),
        update: async (id, patch) => { current = { ...current, ...patch }; created.settingsUpdates.push({ id, patch }); return current; },
        create: async (data) => { current = { id: 'settings-1', ...data }; created.settingsUpdates.push({ id: null, patch: data }); return current; },
      },
      DistributionAudit: {
        create: async (data) => { created.audits.push(data); return { id: `audit-${created.audits.length}`, ...data }; },
      },
    },
  };
}

function ctxFor(db, body) {
  return { user: OPERATOR, db, body, json: (data, status = 200) => ({ __status: status, ...data }) };
}

describe('distributionSetMode: mode allowlist matches the rest of the engine', () => {
  it('accepts every mode client/src/lib/distribution/modeControl.js\'s MODES declares', async () => {
    // Regression: this function's own DISTRIBUTION_MODES array once drifted to
    // 'dual' where modeControl.js and processLead.js both say
    // 'new_primary_with_legacy_fallback'. That let an operator "successfully"
    // set mode:'dual' here - accepted, audited, persisted, no error - while
    // processLead.js's own separate allowlist rejected it on every lead and
    // silently fell back to legacy_only. Looping over the shared MODES export
    // means a future edit to one list without the other fails this test
    // immediately instead of drifting silently again.
    for (const mode of MODES) {
      const db = makeDb({ settings: { id: 's1', distribution_mode: 'legacy_only' } });
      const res = await distributionSetMode(ctxFor(db, { mode }));
      expect(res.ok, `mode "${mode}" should be accepted`).toBe(true);
      expect(res.to).toBe(mode);
    }
  });

  it('rejects a mode string not in the canonical list, e.g. the old drifted "dual"', async () => {
    const db = makeDb({ settings: { id: 's1', distribution_mode: 'legacy_only' } });
    const res = await distributionSetMode(ctxFor(db, { mode: 'dual' }));
    expect(res.__status).toBe(400);
    expect(res.error).toContain('Unknown distribution_mode');
    expect(db.created.settingsUpdates).toHaveLength(0);
    expect(db.created.audits).toHaveLength(0);
  });
});

describe('distributionSetMode: authorization and audit ordering', () => {
  it('denies a non-operator before touching AppSettings', async () => {
    const db = makeDb({ settings: { id: 's1', distribution_mode: 'legacy_only' } });
    const ctx = ctxFor(db, { mode: 'shadow' });
    ctx.user = { id: 'u2', role: 'buyer', base_role: 'buyer' };
    const res = await distributionSetMode(ctx);
    expect(res.__status).toBe(403);
    expect(db.created.settingsUpdates).toHaveLength(0);
  });

  it('writes the DistributionAudit record before updating AppSettings', async () => {
    const db = makeDb({ settings: { id: 's1', distribution_mode: 'legacy_only' } });
    const res = await distributionSetMode(ctxFor(db, { mode: 'shadow', reason: 'test rollout' }));
    expect(res.ok).toBe(true);
    expect(db.created.audits).toHaveLength(1);
    expect(db.created.audits[0].from_mode).toBe('legacy_only');
    expect(db.created.audits[0].to_mode).toBe('shadow');
    expect(db.created.settingsUpdates).toHaveLength(1);
    expect(db.created.settingsUpdates[0].patch.distribution_mode).toBe('shadow');
  });
});
