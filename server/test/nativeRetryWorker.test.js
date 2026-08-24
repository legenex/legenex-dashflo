import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nativeRetryWorker from '../src/functions/nativeRetryWorker.js';

const OPERATOR = { id: 'u1', role: 'admin', base_role: 'operator' };

function makeCtx({ user = OPERATOR, distributionMode = 'legacy_only' } = {}) {
  const db = {
    entities: {
      User: { get: async () => user },
      AppSettings: { list: async () => [{ distribution_mode: distributionMode }] },
    },
  };
  return { user, db, body: {}, json: (data, status = 200) => ({ __status: status, ...data }) };
}

describe('nativeRetryWorker: safe no-op by default', () => {
  const original = process.env.NATIVE_RETRY_WORKER_ENABLED;
  beforeEach(() => { delete process.env.NATIVE_RETRY_WORKER_ENABLED; });
  afterEach(() => { if (original === undefined) delete process.env.NATIVE_RETRY_WORKER_ENABLED; else process.env.NATIVE_RETRY_WORKER_ENABLED = original; });

  it('does not run when NATIVE_RETRY_WORKER_ENABLED is unset, regardless of distribution_mode', async () => {
    const res = await nativeRetryWorker(makeCtx({ distributionMode: 'new_only' }));
    expect(res.ran).toBe(false);
    expect(res.reason).toMatch(/NATIVE_RETRY_WORKER_ENABLED/);
  });

  it('does not run while distribution_mode is legacy_only, even with the env flag on', async () => {
    process.env.NATIVE_RETRY_WORKER_ENABLED = 'true';
    const res = await nativeRetryWorker(makeCtx({ distributionMode: 'legacy_only' }));
    expect(res.ran).toBe(false);
    expect(res.reason).toMatch(/legacy_only/);
  });

  it('runs (against an empty, in-memory attempt store - no network reachable) only when both gates are open', async () => {
    process.env.NATIVE_RETRY_WORKER_ENABLED = 'true';
    const res = await nativeRetryWorker(makeCtx({ distributionMode: 'shadow' }));
    expect(res.ran).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.outcome).toBeTruthy();
  });

  it('403s a non-operator caller before checking either gate', async () => {
    process.env.NATIVE_RETRY_WORKER_ENABLED = 'true';
    const buyerUser = { id: 'u2', role: 'user', base_role: 'buyer', linked_buyer_id: 'b1' };
    const res = await nativeRetryWorker(makeCtx({ user: buyerUser, distributionMode: 'new_only' }));
    expect(res.__status).toBe(403);
  });
});
