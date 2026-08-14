import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// migrateSource can read every entity in the database. Its shared secret used
// to be a literal committed to this repository, which made the endpoint
// effectively unauthenticated for anyone who could read the source.
//
// These tests pin the fail-closed contract: no configured secret means the
// endpoint refuses everything, including an empty or omitted secret in the
// request body.

const OPS = ['ping', 'count', 'read', 'filter', 'ids'];

function makeCtx(body) {
  return {
    req: { method: 'POST' },
    body,
    db: {
      entities: {
        Lead: {
          list: async () => [{ id: 'should-never-be-returned' }],
          filter: async () => [{ id: 'should-never-be-returned' }],
        },
      },
    },
    json: (payload, status = 200) => ({ __httpResponse: true, status, body: payload }),
  };
}

// The module reads its secret at load time, so the registry is reset before each
// import to pick up the environment set by the test.
async function loadHandler() {
  vi.resetModules();
  const mod = await import('../src/functions/migrateSource.js');
  return mod.default;
}

const ORIGINAL = process.env.MIGRATE_SOURCE_SECRET;

beforeEach(() => { delete process.env.MIGRATE_SOURCE_SECRET; });
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MIGRATE_SOURCE_SECRET;
  else process.env.MIGRATE_SOURCE_SECRET = ORIGINAL;
});

describe('migrateSource fails closed without a configured secret', () => {
  it('refuses every op when MIGRATE_SOURCE_SECRET is unset', async () => {
    const handler = await loadHandler();
    for (const op of OPS) {
      const res = await handler(makeCtx({ op, entity: 'Lead', secret: 'anything' }));
      expect(res.status, `op ${op}`).toBe(403);
    }
  });

  it('refuses an empty secret when none is configured', async () => {
    const handler = await loadHandler();
    for (const secret of ['', null, undefined]) {
      const res = await handler(makeCtx({ op: 'ping', secret }));
      expect(res.status).toBe(403);
    }
  });

  // The value that used to be committed is compromised and must not be written
  // back into this repository to test it. Fail-closed is asserted over arbitrary
  // candidates instead, which covers the old value by construction.
  it('refuses any candidate secret when none is configured', async () => {
    const handler = await loadHandler();
    const candidates = ['a', 'guessed-value', 'x'.repeat(64), '0', 'true'];
    for (const secret of candidates) {
      const res = await handler(makeCtx({ op: 'ping', secret }));
      expect(res.status, `candidate ${secret.slice(0, 12)}`).toBe(403);
    }
  });

  it('never returns entity rows while unauthenticated', async () => {
    const handler = await loadHandler();
    const res = await handler(makeCtx({ op: 'read', entity: 'Lead', secret: 'wrong' }));
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('should-never-be-returned');
  });
});

describe('migrateSource accepts only the configured secret', () => {
  it('accepts the configured secret and rejects a near miss', async () => {
    process.env.MIGRATE_SOURCE_SECRET = 'configured-secret-for-this-test';
    const handler = await loadHandler();

    const ok = await handler(makeCtx({ op: 'ping', secret: 'configured-secret-for-this-test' }));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });

    // Same length, one character different: must not pass.
    const near = await handler(makeCtx({ op: 'ping', secret: 'configured-secret-for-this-tesT' }));
    expect(near.status).toBe(403);

    // Prefix of the real secret: must not pass.
    const prefix = await handler(makeCtx({ op: 'ping', secret: 'configured-secret' }));
    expect(prefix.status).toBe(403);
  });
});
