import { requireUser } from './_runtime.js';

// Authenticated buyer-portal data endpoint. Returns everything the portal needs,
// strictly scoped to a single buyer_id. Reads Lead (admin-only) but never returns
// another buyer's data.
//
// Scoping rules:
// - A buyer-role user is scoped to their own user.linked_buyer_id.
// - An operator (admin) may pass buyer_id to PREVIEW a buyer's portal.
//   Non-admin callers cannot override their linked buyer.

async function resolveBuyerScope(user, requestedBuyerId) {
  const isOperator = user.role === 'admin';
  if (isOperator && requestedBuyerId) return requestedBuyerId;
  if (user.linked_buyer_id) return user.linked_buyer_id;
  return null;
}

export default async function portalData(ctx) {
  try {
    const user = requireUser(ctx);
    const db = ctx.db;

    const body = ctx.body || {};
    const requestedBuyerId = body.buyer_id || null;
    const buyerId = await resolveBuyerScope(user, requestedBuyerId);
    if (!buyerId) return ctx.json({ error: 'No buyer linked to this account' }, 403);

    const buyer = await db.entities.Buyer.get(buyerId).catch(() => null);
    if (!buyer) return ctx.json({ error: 'Buyer not found' }, 404);
    if (!buyer.portal_enabled && user.role !== 'admin') {
      return ctx.json({ error: 'Portal is not enabled for this buyer' }, 403);
    }

    // Only leads delivered to this buyer.
    const leads = await db.entities.Lead.filter({ buyer_id: buyerId }, '-created_date', 2000);
    const feedback = await db.entities.BuyerFeedback.filter({ buyer_id: buyerId }, '-created_date', 2000);
    const returns = await db.entities.ReturnRequest.filter({ buyer_id: buyerId }, '-created_date', 2000);

    // Trim lead payloads to portal-safe fields (never expose raw payloads / traces).
    const safeLeads = leads.map((l) => ({
      id: l.id,
      lead_id: l.lead_id,
      first_name: l.first_name,
      last_name: l.last_name,
      mobile: l.mobile,
      email: l.email,
      final_status: l.final_status,
      revenue: l.revenue,
      cost: l.cost,
      buyer_feedback: l.buyer_feedback,
      created_date: l.created_date,
    }));

    return {
      buyer: {
        id: buyer.id,
        company_name: buyer.company_name,
        email: buyer.email,
        portal_enabled: buyer.portal_enabled,
      },
      leads: safeLeads,
      feedback,
      returns,
    };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
