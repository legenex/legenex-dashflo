import { requireUser, HttpError } from './_runtime.js';

// Allocates the next buyer_code for a given client_type. Reads and increments a
// per-prefix Counter, then returns the code. Never creates the Buyer record.
// Access rules mirror operationsData exactly.

const OPERATOR_PERMISSION_KEYS = ['leads', 'reports', 'overview', 'finances', 'distribution', 'operations'];

// client_type -> buyer_code prefix. Anything else (including null) is rejected.
const PREFIX_BY_CLIENT_TYPE = {
  'Law Firm': 'LF',
  'Aggregator': 'AG',
  'Network': 'NW',
  'Reseller': 'RS',
};

export default async function allocateBuyerCode(ctx) {
  try {
    const db = ctx.db;

    const user = requireUser(ctx);

    const record = await db.entities.User.get(user.id).catch(() => null);
    const caller = record || user;

    if (caller.base_role === 'supplier' || caller.base_role === 'buyer') {
      return ctx.json({ error: 'Forbidden' }, 403);
    }
    if (caller.linked_buyer_id || caller.linked_supplier_id) {
      return ctx.json({ error: 'Forbidden' }, 403);
    }

    let permissions = {};
    try {
      permissions = typeof caller.permissions === 'string'
        ? JSON.parse(caller.permissions || '{}')
        : (caller.permissions || {});
    } catch { permissions = {}; }
    const hasOperatorPermission = OPERATOR_PERMISSION_KEYS.some((k) => permissions[k] === true);
    if (!hasOperatorPermission && caller.role !== 'admin') {
      return ctx.json({ error: 'Forbidden' }, 403);
    }

    const body = ctx.body || {};
    const clientType = body && typeof body.client_type === 'string' ? body.client_type : null;
    const prefix = clientType ? PREFIX_BY_CLIENT_TYPE[clientType] : null;
    if (!prefix) {
      return ctx.json({
        error: 'A classified client_type is required to allocate a buyer code. Expected one of Law Firm, Aggregator, Network or Reseller.',
      }, 400);
    }

    const counterName = `buyer_code_${prefix}`;

    // Find or create the counter, then increment BEFORE returning so a crash can
    // never hand out the same number twice.
    const existing = await db.entities.Counter.filter({ name: counterName }, '', 1);
    let counter = existing && existing.length ? existing[0] : null;
    if (!counter) {
      counter = await db.entities.Counter.create({ name: counterName, value: 0, updated_at: new Date().toISOString() });
    }

    // Increment, checking for collisions against existing Buyer records. If the
    // counter has drifted behind reality, bump again and retry, up to five times.
    let lastError = 'Could not allocate a unique buyer code after several attempts.';
    for (let attempt = 0; attempt < 5; attempt++) {
      const nextValue = (Number(counter.value) || 0) + 1;
      counter = await db.entities.Counter.update(counter.id, {
        value: nextValue,
        updated_at: new Date().toISOString(),
      });
      const code = `${prefix}${nextValue}`;
      const clash = await db.entities.Buyer.filter({ buyer_code: code }, '', 1);
      if (!clash || clash.length === 0) {
        return ctx.json({ buyer_code: code });
      }
      lastError = `Buyer code ${code} already exists; counter has drifted.`;
    }

    return ctx.json({ error: lastError }, 409);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return ctx.json({ error: error.message }, 500);
  }
}
