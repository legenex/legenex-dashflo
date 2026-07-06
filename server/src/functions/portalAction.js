import { requireUser } from './_runtime.js';

// Authenticated buyer-portal write endpoint. Handles two actions, both strictly
// scoped to the caller's buyer_id:
//   - request_return: create a ReturnRequest for one of the buyer's own leads.
//   - add_feedback:   create a manual BuyerFeedback record for one of the buyer's leads.

async function resolveBuyerScope(user, requestedBuyerId) {
  const isOperator = user.role === 'admin';
  if (isOperator && requestedBuyerId) return requestedBuyerId;
  if (user.linked_buyer_id) return user.linked_buyer_id;
  return null;
}

export default async function portalAction(ctx) {
  try {
    const user = requireUser(ctx);
    const db = ctx.db;

    const body = ctx.body || {};
    const buyerId = await resolveBuyerScope(user, body.buyer_id || null);
    if (!buyerId) return ctx.json({ error: 'No buyer linked to this account' }, 403);

    const buyer = await db.entities.Buyer.get(buyerId).catch(() => null);
    if (!buyer) return ctx.json({ error: 'Buyer not found' }, 404);
    if (!buyer.portal_enabled && user.role !== 'admin') {
      return ctx.json({ error: 'Portal is not enabled for this buyer' }, 403);
    }

    const action = body.action;

    // Validate that a referenced lead actually belongs to this buyer.
    async function assertOwnLead(leadId) {
      if (!leadId) return null;
      const lead = await db.entities.Lead.get(leadId).catch(() => null);
      if (!lead || lead.buyer_id !== buyerId) {
        throw new Error('Lead not found for this buyer');
      }
      return lead;
    }

    if (action === 'request_return') {
      await assertOwnLead(body.lead_id);
      const created = await db.entities.ReturnRequest.create({
        lead_id: body.lead_id,
        buyer_id: buyerId,
        reason: String(body.reason || ''),
        status: 'requested',
        requested_date: new Date().toISOString(),
      });
      return { status: 'ok', id: created.id };
    }

    if (action === 'add_feedback') {
      const lead = await assertOwnLead(body.lead_id);
      const disposition = String(body.disposition || '').trim();
      if (!disposition) return ctx.json({ error: 'Disposition is required' }, 400);

      const created = await db.entities.BuyerFeedback.create({
        lead_id: body.lead_id || null,
        buyer_id: buyerId,
        matched_by: 'manual',
        disposition,
        raw_disposition: disposition,
        notes: String(body.notes || ''),
        outcome: String(body.outcome || ''),
        revenue_value: Number(body.revenue_value) || 0,
        source: 'manual',
        match_confidence: 1,
      });

      // Stamp disposition on the lead for operator reporting.
      if (lead) {
        await db.entities.Lead.update(lead.id, { buyer_feedback: disposition });
      }
      return { status: 'ok', id: created.id };
    }

    return ctx.json({ error: 'Unknown action' }, 400);
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
