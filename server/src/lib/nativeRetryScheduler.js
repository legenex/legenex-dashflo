// In-process periodic caller for the native retry worker. This is the
// "scheduled caller" Stage 3 of the Lead Distribution rebuild requires exist
// before NATIVE_RETRY_WORKER_ENABLED can mean anything: without one, the
// worker is reachable only by an operator's manual HTTP call
// (nativeRetryWorker.js), so an attempt that lands in ERROR/QUEUED with a
// next_retry_at is never automatically retried, no matter how the two safety
// gates are set.
//
// Deliberately in-process rather than an external scheduler (a GitHub
// Actions `schedule:` trigger or a VPS cron hitting the HTTP function): this
// app is a single always-running self-hosted Docker service, not a
// serverless function, and calling runNativeRetryPass directly avoids
// inventing a new authenticated cross-network credential (entering or
// creating a production credential is a human-approval gate under AGENTS.md
// section 13) just to let a scheduler call its own server's endpoint.
//
// Both existing safety gates still apply, checked independently of this
// module: NATIVE_RETRY_WORKER_ENABLED (env, gates whether the interval is
// ever created at all - checked once at startup) and
// AppSettings.distribution_mode (DB state, checked fresh by
// runNativeRetryPass on every tick, since it can change without a restart).
// With the env var unset, as in every environment today, this module creates
// no timer and does nothing.

import { runNativeRetryPass } from './nativeRetryRunner.js';

const DEFAULT_INTERVAL_MS = 60000;

// Returns the interval handle (for tests to clear), or null if disabled.
export function startNativeRetryScheduler(db, { intervalMs = DEFAULT_INTERVAL_MS, log = console } = {}) {
  if (process.env.NATIVE_RETRY_WORKER_ENABLED !== 'true') {
    log.log('[native-retry-scheduler] disabled (NATIVE_RETRY_WORKER_ENABLED is not "true")');
    return null;
  }
  log.log(`[native-retry-scheduler] enabled, polling every ${intervalMs}ms`);
  const tick = async () => {
    try {
      const result = await runNativeRetryPass(db, { workerId: 'native-retry-scheduler' });
      if (result.ran && result.outcome && result.outcome.length) {
        log.log(`[native-retry-scheduler] processed ${result.outcome.length} due attempt(s)`);
      }
    } catch (err) {
      log.error('[native-retry-scheduler] tick failed', err);
    }
  };
  const timer = setInterval(tick, intervalMs);
  // Never keep the process alive on its own (a bare `node index.js` exit or
  // a test run must not hang waiting on this timer).
  if (timer.unref) timer.unref();
  return timer;
}
