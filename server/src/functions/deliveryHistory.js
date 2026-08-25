import { requireUser } from './_runtime.js';

// Operator-safe read of DeliveryAttempt history for one SubDelivery. Created
// because DeliveryHistoryTab.jsx was calling the generic entity route
// (api.entities.DeliveryAttempt.filter), and DeliveryAttempt is absent from
// entityPolicy.js's ENTITY_POLICY table - which denies it entirely, not
// narrowly, so the History tab silently showed nothing. DeliveryAttempt is
// deliberately NOT added to the generic entity route: it is not broadly
// CRUD-exposed, only read through this dedicated, explicitly allowlisted
// function, mirroring deliveryMockSend.js's operator gate.
//
// Returns only the safe fields the UI actually renders - no request_meta/
// response_meta (already redacted/minimized server-side, but still not
// needed by this view and not returned regardless), no credential
// references, no unnecessary PII.
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

const SAFE_FIELDS = [
  'id', 'lead_id', 'status', 'http_status', 'attempt_number', 'is_primary',
  'trigger', 'error_class', 'next_retry_at', 'created_date', 'started_at', 'completed_at',
];

function projectAttempt(a) {
  const out = {};
  for (const f of SAFE_FIELDS) out[f] = a[f] ?? null;
  return out;
}

export default async function deliveryHistory(ctx) {
  const user = requireUser(ctx);
  const db = ctx.db;
  if (!(await assertOperator(db, user))) return ctx.json({ error: 'Forbidden' }, 403);

  const body = ctx.body || {};
  const subDeliveryId = body.sub_delivery_id;
  if (!subDeliveryId) return ctx.json({ error: 'sub_delivery_id required' }, 400);

  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 100, 1), 500);
  const rows = await db.entities.DeliveryAttempt.filter({ sub_delivery_id: subDeliveryId }, '-created_date', limit);
  return { attempts: (rows || []).map(projectAttempt) };
}
