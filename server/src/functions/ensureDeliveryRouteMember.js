import { requireUser } from './_runtime.js';

// Filters, qualification conditions, caps, and schedule are RouteMember
// fields at runtime (client/src/lib/distribution/engine.js reads them off
// the assembled member, not off SubDelivery/Delivery - see
// server/src/schemas/entities/RouteMember.json). The canonical delivery
// editor presents them as part of "one delivery," so this function finds or
// creates the ONE dedicated RouteMember a Delivery's primary SubDelivery
// needs to carry them, idempotently and without ever touching an existing
// RouteGroup another buyer or delivery might already be routing through.
//
// SAFETY: any RouteGroup this function creates is created with active:false,
// lifecycle:'draft' (the schema's own defaults, stated explicitly here so a
// future schema default change cannot silently change this function's
// behavior). loadRoutingSnapshot only ever loads active+lifecycle:'active'
// groups, so a group created here can never be evaluated by the live
// pipeline until a human activates it elsewhere (Campaigns / Route Groups),
// which this editor does not do and is not asked to do.
//
// Caller model: operator-only, mirrors the other delivery-editor functions.
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

export default async function ensureDeliveryRouteMember(ctx) {
  const user = requireUser(ctx);
  const db = ctx.db;
  if (!(await assertOperator(db, user))) return ctx.json({ error: 'Forbidden' }, 403);

  const body = ctx.body || {};
  const subDeliveryId = String(body.sub_delivery_id || '');
  if (!subDeliveryId) return ctx.json({ error: 'sub_delivery_id required' }, 400);

  const sd = await db.entities.SubDelivery.get(subDeliveryId).catch(() => null);
  if (!sd) return ctx.json({ error: 'SubDelivery not found' }, 404);
  const delivery = await db.entities.Delivery.get(sd.delivery_id).catch(() => null);
  if (!delivery) return ctx.json({ error: 'Parent Delivery not found' }, 404);

  // Idempotent: reuse an existing RouteMember already pointing at this
  // SubDelivery rather than ever creating a second one.
  const existing = await db.entities.RouteMember.filter({ sub_delivery_id: subDeliveryId });
  if (existing && existing.length > 0) {
    return { ok: true, route_member: existing[0], created: false };
  }

  if (!delivery.vertical_id) {
    return ctx.json({
      ok: false,
      error: 'Set a vertical on this delivery first. Filters, schedule, caps, and qualification conditions attach to a routing group scoped to a vertical/campaign.',
    }, 409);
  }

  const campaigns = await db.entities.Campaign.filter({ vertical: delivery.vertical_id });
  const campaign = campaigns && campaigns[0];
  if (!campaign) {
    return ctx.json({
      ok: false,
      error: `No Campaign found for vertical "${delivery.vertical_id}". A Campaign for this vertical must exist before routing-scoped settings can be configured.`,
    }, 409);
  }

  const group = await db.entities.RouteGroup.create({
    campaign_id: campaign.id,
    name: `Native: ${delivery.name || 'Delivery'} (${sd.name || 'Primary'})`,
    method: 'priority',
    order_index: 0,
    active: false,
    lifecycle: 'draft',
  });

  const member = await db.entities.RouteMember.create({
    route_group_id: group.id,
    buyer_id: delivery.buyer_id,
    sub_delivery_id: subDeliveryId,
    destination_name: delivery.name || null,
    active: true,
    priority: 1,
  });

  return { ok: true, route_member: member, route_group: group, created: true };
}
