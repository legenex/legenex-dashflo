import { requireUser } from './_runtime.js';
import * as engine from './routingEngine.generated.js';

// Wraps engine.runRetryWorker (client/src/lib/distribution/retryWorker.js) so
// it can be scheduled without risk. Audited state, confirmed by inspection:
// runRetryWorker has ZERO callers anywhere in server/src or scripts/ today,
// so an attempt that lands in ERROR/QUEUED with a next_retry_at is never
// automatically retried. This function makes retrying possible without
// making it live: it is a hard no-op unless BOTH of the following are true,
// so deploying (or even scheduling) it is safe on its own.
//
//   1. NATIVE_RETRY_WORKER_ENABLED=true is set in the environment.
//   2. AppSettings.distribution_mode is anything other than legacy_only.
//
// Exactly the same double gate campaignDeliveryTest.js already uses for its
// live test path (mode check) plus an explicit env opt-in, so this can be
// wired into a scheduler ahead of any real cutover decision without that
// scheduler itself being the thing that turns retries on.
//
// What remains before this executes against live native traffic, stated
// plainly for the operator: (a) set NATIVE_RETRY_WORKER_ENABLED=true,
// (b) add an actual periodic caller (a scheduled GitHub Actions workflow or a
// VPS cron hitting this function's route - neither exists in this repo
// today, see docs/STATE.md), and (c) move distribution_mode off legacy_only,
// which is its own separate human-approval gate.
const OPERATOR_PERMISSION_KEYS = ['leads', 'reports', 'overview', 'finances', 'distribution', 'operations'];

async function assertOperator(db, user) {
  const record = await db.entities.User.get(user.id).catch(() => null);
  const caller = record || user;
  if (caller.base_role === 'supplier' || caller.base_role === 'buyer') return false;
  if (caller.linked_buyer_id || caller.linked_supplier_id) return false;
  let permissions = {};
  try {
    permissions = typeof caller.permissions === 'string'
      ? JSON.parse(caller.permissions || '{}')
      : (caller.permissions || {});
  } catch { permissions = {}; }
  return caller.role === 'admin' || OPERATOR_PERMISSION_KEYS.some((k) => permissions[k] === true);
}

async function resolveCredential(db, ref) {
  if (!ref) return {};
  try {
    const rows = await db.entities.IntegrationConfig.filter({ key: ref });
    const val = rows && rows[0] && rows[0].value;
    if (val && typeof val === 'string') return { Authorization: val };
  } catch { /* secret store not configured in this env */ }
  return {};
}

export default async function nativeRetryWorker(ctx) {
  const user = requireUser(ctx);
  const db = ctx.db;
  if (!(await assertOperator(db, user))) return ctx.json({ error: 'Forbidden' }, 403);

  if (process.env.NATIVE_RETRY_WORKER_ENABLED !== 'true') {
    return { ok: false, ran: false, reason: 'NATIVE_RETRY_WORKER_ENABLED is not set to true.' };
  }
  const settingsArr = await db.entities.AppSettings.list();
  const mode = String((settingsArr[0] && settingsArr[0].distribution_mode) || 'legacy_only');
  if (mode === 'legacy_only') {
    return { ok: false, ran: false, reason: 'distribution_mode is legacy_only; native retries stay off.' };
  }

  const store = db.entities.DeliveryAttempt ? engine.makeDbAttemptStore(db) : engine.makeInMemoryAttemptStore();
  const healthStore = engine.makeInMemoryHealthStore ? engine.makeInMemoryHealthStore() : undefined;

  const deliverFn = async (attempt) => {
    const sd = await db.entities.SubDelivery.get(attempt.sub_delivery_id).catch(() => null);
    if (!sd) return { status: engine.ATTEMPT_STATUS.ERROR, retryable: false };
    const cfg = engine.resolveSubDeliveryCfg(sd);
    const result = await engine.deliverDirectPost(
      { ...cfg, idempotencyKey: attempt.idempotency_key, leadId: attempt.lead_id, leadData: {}, isPrimary: false, trigger: 'retry', attemptNumber: (attempt.attempt_number || 1) + 1 },
      { store, nowMs: Date.now(), fetchImpl: globalThis.fetch, testMode: false, resolveCredential: (ref) => resolveCredential(db, ref) },
    );
    return { status: result.status, retryable: result.retryable };
  };

  const outcome = await engine.runRetryWorker(store, deliverFn, {
    nowMs: Date.now(), workerId: `native-retry-${user.id}`, healthStore,
  });

  return { ok: true, ran: true, mode, outcome };
}
