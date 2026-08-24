import { describe, it, expect, afterEach, vi } from 'vitest';
import { startNativeRetryScheduler } from '../src/lib/nativeRetryScheduler.js';

// The scheduled caller Stage 3 requires exist before NATIVE_RETRY_WORKER_ENABLED
// can mean anything. Never actually delivers here: no test flips
// distribution_mode off legacy_only, so runNativeRetryPass always stops at
// its own mode gate even when this module's timer does fire.

describe('startNativeRetryScheduler', () => {
  const original = process.env.NATIVE_RETRY_WORKER_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.NATIVE_RETRY_WORKER_ENABLED;
    else process.env.NATIVE_RETRY_WORKER_ENABLED = original;
  });

  function fakeDb(mode = 'legacy_only') {
    return { entities: { AppSettings: { list: async () => [{ distribution_mode: mode }] } } };
  }
  function fakeLog() { return { log: vi.fn(), error: vi.fn() }; }

  it('creates no timer when NATIVE_RETRY_WORKER_ENABLED is unset (every environment today)', () => {
    delete process.env.NATIVE_RETRY_WORKER_ENABLED;
    const log = fakeLog();
    const timer = startNativeRetryScheduler(fakeDb(), { log });
    expect(timer).toBe(null);
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('disabled'));
  });

  it('creates an unref\'d timer when enabled, so it never keeps the process alive on its own', () => {
    process.env.NATIVE_RETRY_WORKER_ENABLED = 'true';
    const log = fakeLog();
    const timer = startNativeRetryScheduler(fakeDb(), { intervalMs: 50, log });
    expect(timer).not.toBe(null);
    clearInterval(timer);
  });

  it('a tick against a real (fake) db does not throw even while distribution_mode is legacy_only', async () => {
    process.env.NATIVE_RETRY_WORKER_ENABLED = 'true';
    const log = fakeLog();
    const timer = startNativeRetryScheduler(fakeDb('legacy_only'), { intervalMs: 5, log });
    await new Promise((r) => setTimeout(r, 30));
    clearInterval(timer);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('a tick failure is caught and logged, never thrown or left unhandled', async () => {
    process.env.NATIVE_RETRY_WORKER_ENABLED = 'true';
    const throwingDb = { entities: { AppSettings: { list: async () => { throw new Error('db unreachable'); } } } };
    const log = fakeLog();
    const timer = startNativeRetryScheduler(throwingDb, { intervalMs: 5, log });
    await new Promise((r) => setTimeout(r, 30));
    clearInterval(timer);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('tick failed'), expect.any(Error));
  });
});
