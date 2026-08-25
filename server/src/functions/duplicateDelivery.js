// Duplicate a Delivery (and every SubDelivery endpoint tier under it) into a
// new, independent configuration for the SAME buyer. Requested by the Buyers /
// Webhooks delivery action menu ("Duplicate").
//
// Copies: SubDelivery method, encoding, query_params, delete_with_body,
// headers, credential_ref (the opaque reference only - see below),
// field_map, transforms, payload_template, response_mapping, timeout_ms,
// retry_policy, active, order_index.
//
// Deliberately does NOT copy: DeliveryAttempt history, DestinationHealth,
// RouteMember/route membership, cap counters, RouteConfigVersion/publish
// history, or any secret material (there is none in this entity to copy -
// credential_ref is an opaque name, resolved server-side at send time from a
// completely separate store; copying the reference string is safe and is
// exactly what the operator brief calls out as permitted).
//
// The new Delivery always starts status:'draft' regardless of the source's
// status, so a duplicate can never silently become routable without an
// operator reviewing and activating it explicitly.

import { requireUser } from './_runtime.js';

export default async function duplicateDelivery(ctx) {
  requireUser(ctx);
  const db = ctx.db;
  const deliveryId = String(ctx.body?.deliveryId || '').trim();
  if (!deliveryId) return ctx.json({ success: false, error: 'deliveryId is required' }, 400);

  const source = await db.entities.Delivery.get(deliveryId).catch(() => null);
  if (!source) return ctx.json({ success: false, error: 'Delivery not found' }, 404);

  const subs = await db.entities.SubDelivery.filter({ delivery_id: deliveryId });

  const newDelivery = await db.entities.Delivery.create({
    buyer_id: source.buyer_id,
    name: `${source.name || 'Delivery'} Copy`,
    vertical_id: source.vertical_id || null,
    status: 'draft',
    notes: source.notes || '',
  });

  const newSubs = [];
  for (const sd of subs || []) {
    const created = await db.entities.SubDelivery.create({
      delivery_id: newDelivery.id,
      name: sd.name || '',
      active: sd.active !== false,
      order_index: Number(sd.order_index) || 0,
      target_url: sd.target_url || '',
      method: sd.method || 'POST',
      encoding: sd.encoding || 'json',
      query_params: sd.query_params || '',
      delete_with_body: sd.delete_with_body === true,
      headers: sd.headers || '',
      credential_ref: sd.credential_ref || '',
      credential_updated_at: null,
      field_map: sd.field_map || '',
      transforms: sd.transforms || '',
      payload_template: sd.payload_template || '',
      response_mapping: sd.response_mapping || '',
      timeout_ms: Number(sd.timeout_ms) || 10000,
      retry_policy: sd.retry_policy || '',
    });
    newSubs.push(created.id);
  }

  return ctx.json({ success: true, deliveryId: newDelivery.id, subDeliveryIds: newSubs });
}
