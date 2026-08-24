// One retry-worker pass against a real database. Shared by the
// operator-triggered HTTP function (nativeRetryWorker.js) and the in-process
// scheduler (nativeRetryScheduler.js) so there is exactly one implementation
// of "how a due native delivery attempt gets resent" rather than two that can
// drift. Checks the distribution_mode gate itself (fresh, since it is DB
// state that can change without a restart); the NATIVE_RETRY_WORKER_ENABLED
// env gate and operator authorization are the caller's responsibility.

import * as engine from '../functions/routingEngine.generated.js';

async function resolveCredential(db, ref) {
  if (!ref) return {};
  try {
    const rows = await db.entities.IntegrationConfig.filter({ key: ref });
    const val = rows && rows[0] && rows[0].value;
    if (val && typeof val === 'string') return { Authorization: val };
  } catch { /* secret store not configured in this env */ }
  return {};
}

export async function runNativeRetryPass(db, { workerId }) {
  const settingsArr = await db.entities.AppSettings.list();
  const mode = String((settingsArr[0] && settingsArr[0].distribution_mode) || 'legacy_only');
  if (mode === 'legacy_only') {
    return { ran: false, reason: 'distribution_mode is legacy_only; native retries stay off.', mode };
  }

  const store = db.entities.DeliveryAttempt ? engine.makeEntityAttemptStore(db) : engine.makeInMemoryAttemptStore();
  // Must persist across ticks/invocations, or the breaker never accumulates
  // consecutive failures and never opens.
  const healthStore = db.entities.DestinationHealth ? engine.makeEntityHealthStore(db) : engine.makeInMemoryHealthStore();

  const deliverFn = async (attempt) => {
    const sd = await db.entities.SubDelivery.get(attempt.sub_delivery_id).catch(() => null);
    if (!sd) return { status: engine.ATTEMPT_STATUS.ERROR, retryable: false };
    const cfg = engine.resolveSubDeliveryCfg(sd);
    const lead = await db.entities.Lead.get(attempt.lead_id).catch(() => null);
    // retryWorker.js's runRetryWorker already incremented attempt_number
    // before calling this function; reusing it here (rather than
    // incrementing a second time) keeps the stored attempt sequence
    // contiguous instead of skipping a number on every retry.
    const result = await engine.deliverDirectPost(
      {
        ...cfg, idempotencyKey: attempt.idempotency_key, leadId: attempt.lead_id, leadData: lead || {},
        subDeliveryId: attempt.sub_delivery_id || cfg.subDeliveryId || null,
        isPrimary: false, trigger: 'retry', attemptNumber: attempt.attempt_number || 1,
      },
      { store, nowMs: Date.now(), fetchImpl: globalThis.fetch, testMode: false, resolveCredential: (ref) => resolveCredential(db, ref) },
    );
    return { status: result.status, retryable: result.retryable };
  };

  const outcome = await engine.runRetryWorker(store, deliverFn, { nowMs: Date.now(), workerId, healthStore });
  return { ran: true, mode, outcome };
}
