import { requireUser } from './_runtime.js';
import { runNativeRetryPass } from '../lib/nativeRetryRunner.js';

// Operator-triggered HTTP entry point for one native retry-worker pass.
// nativeRetryScheduler.js is the automatic in-process caller (server
// startup); this function exists so an operator can also trigger a pass by
// hand, and both call the exact same runNativeRetryPass so there is one
// implementation of "how a due attempt gets resent," not two.
//
// It is a hard no-op unless BOTH of the following are true, so deploying (or
// scheduling) it is safe on its own:
//
//   1. NATIVE_RETRY_WORKER_ENABLED=true is set in the environment.
//   2. AppSettings.distribution_mode is anything other than legacy_only.
//
// Exactly the same double gate campaignDeliveryTest.js already uses for its
// live test path (mode check) plus an explicit env opt-in.
//
// What remains before this executes against live native traffic, stated
// plainly for the operator: (a) set NATIVE_RETRY_WORKER_ENABLED=true on the
// production host, (b) move distribution_mode off legacy_only, which is its
// own separate human-approval gate. The scheduled caller itself
// (nativeRetryScheduler.js, wired into server/src/index.js at startup) now
// exists either way.
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

export default async function nativeRetryWorker(ctx) {
  const user = requireUser(ctx);
  const db = ctx.db;
  if (!(await assertOperator(db, user))) return ctx.json({ error: 'Forbidden' }, 403);

  if (process.env.NATIVE_RETRY_WORKER_ENABLED !== 'true') {
    return { ok: false, ran: false, reason: 'NATIVE_RETRY_WORKER_ENABLED is not set to true.' };
  }

  const result = await runNativeRetryPass(db, { workerId: `native-retry-${user.id}` });
  if (!result.ran) return { ok: false, ...result };
  return { ok: true, ...result };
}
