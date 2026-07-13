import { requireUser, HttpError } from './_runtime.js';

const OPERATOR_PERMISSION_KEYS = ['leads', 'reports', 'overview', 'finances', 'distribution', 'operations'];

const ACTIVE_ONBOARDING_STATUSES = ['invited', 'submitted', 'in_progress', 'blocked'];

// Mint a per-buyer onboarding link record and token when a buyer is created.
// Operator only. This endpoint never sends email, never modifies the Buyer,
// returns JSON only, and never logs secrets.
//
// Access rules:
// - Must be an authenticated session.
// - Rejected if base_role is supplier or buyer, or if linked_buyer_id /
//   linked_supplier_id is set (those are portal accounts, not operators).
// - Must have at least one operator permission set true, or role admin.
export default async function mintOnboardingLink(ctx) {
  try {
    const user = requireUser(ctx);
    const db = ctx.db;

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
    const buyerId = body.buyer_id;
    if (!buyerId) return ctx.json({ error: 'buyer_id is required' }, 400);

    const buyer = await db.entities.Buyer.get(buyerId).catch(() => null);
    if (!buyer) return ctx.json({ error: 'Buyer not found' }, 404);

    if (buyer.auto_created) {
      return ctx.json({ error: 'Auto-created buyers do not get onboarding links.' }, 400);
    }

    // Idempotency: if there is already an active onboarding record for this
    // buyer, return its token without creating a new one.
    const existingList = await db.entities.BuyerOnboarding.filter({ buyer_id: buyerId });
    const existing = (Array.isArray(existingList) ? existingList : [])
      .find((o) => ACTIVE_ONBOARDING_STATUSES.includes(o.status));
    if (existing) {
      return ctx.json({ token: existing.token, onboarding_id: existing.id, reused: true });
    }

    const token = crypto.randomUUID().replace(/-/g, '');
    const created = await db.entities.BuyerOnboarding.create({
      buyer_id: buyerId,
      company_name: buyer.company_name,
      status: 'invited',
      token,
    });

    return ctx.json({ token, onboarding_id: created.id, reused: false });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return ctx.json({ error: error.message }, 500);
  }
}
