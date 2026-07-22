import { requireUser, HttpError } from './_runtime.js';

async function resolveBuyerScope(db, user, requestedBuyerId, previewRole) {
  const isOperator = user.role === 'admin';
  if (isOperator && requestedBuyerId) return requestedBuyerId;
  if (user.linked_buyer_id) return user.linked_buyer_id;
  // Operator using "View as → Buyer" with no specific target: preview the first
  // portal-enabled buyer so the portal renders a real example.
  if (isOperator && previewRole) {
    const enabled = await db.entities.Buyer.filter({ portal_enabled: true }, '-created_date', 1).catch(() => []);
    if (enabled && enabled.length > 0) return enabled[0].id;
  }
  return null;
}

export default async function portalData(ctx) {
  try {
    const db = ctx.db;
    const user = requireUser(ctx);

    const body = ctx.body || {};
    const requestedBuyerId = body.buyer_id || null;
    const previewRole = !!body.preview_role;
    const buyerId = await resolveBuyerScope(db, user, requestedBuyerId, previewRole);
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
    if (error instanceof HttpError) throw error;
    return ctx.json({ error: error.message }, 500);
  }
}
