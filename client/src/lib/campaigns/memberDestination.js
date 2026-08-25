// UI helpers for resolving a RouteMember's destination label and for detecting
// and converting legacy inline-config members. No engine or backend logic here.
// No em dashes.

import { api } from '@/api/client';

// A member is "legacy" when it carries inline delivery_config or ping_config
// but has no canonical sub_delivery_id pointer.
export function isLegacyMember(m) {
  if (!m) return false;
  if (m.sub_delivery_id) return false;
  const hasInline = (v) => v != null && String(v).trim() !== '' && String(v).trim() !== '{}';
  return hasInline(m.delivery_config) || hasInline(m.ping_config);
}

// A member is "configured" only when sub_delivery_id resolves to a real,
// active SubDelivery whose parent Delivery is also active. This is the
// client-side equivalent of server/src/lib/routeMemberMapping.js's READY
// classification, simplified for display purposes: it does not distinguish
// MISSING_DELIVERY from MISSING_SUBDELIVERY, it only answers "is this member
// actually backed by something real and routable". A member can look fully
// filled in (destination_name set, alias set) and still not be configured;
// destination_name is a free-text label, never proof of a real delivery.
export function isConfiguredMember(m, subById, deliveryById) {
  if (!m?.sub_delivery_id) return false;
  const sub = subById?.[m.sub_delivery_id];
  if (!sub || sub.active === false) return false;
  const delivery = deliveryById?.[sub.delivery_id];
  if (!delivery || delivery.status !== 'active') return false;
  return true;
}

// Resolve the primary destination name for a member.
// Only a CONFIGURED member (see isConfiguredMember) or a LEGACY member is
// trusted to show destination_name as its identity. A legacy member is a
// legitimate, intentionally-created inline config, so its destination_name
// (or the sub-delivery name, for a configured member) is real. A pure orphan
// (no sub_delivery_id, no inline config either) is neither: destination_name
// on that row is free text a form let an operator type in (including a
// buyer's own company name typed into "Buyer name" on BuyerConfigModal), and
// it must never be trusted to render as if it were a real numbered Delivery.
// That row gets a clear "Not configured" label instead.
export function destinationLabel(m, subById, deliveryById) {
  if (isConfiguredMember(m, subById, deliveryById)) {
    if (m?.destination_name) return m.destination_name;
    const sub = subById?.[m.sub_delivery_id];
    if (sub?.name) return sub.name;
  }
  if (isLegacyMember(m)) return m?.destination_name || 'Legacy destination';
  return 'Not configured';
}

function parseObj(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

// Convert a legacy member: build a Delivery + SubDelivery for the member's buyer
// from its inline delivery_config, then set sub_delivery_id on the member. The
// old inline fields are LEFT UNTOUCHED (additive, reversible, engine-safe).
// Returns the created sub-delivery id.
export async function convertLegacyMember(m, buyerName) {
  const delivery = parseObj(m.delivery_config);
  const ping = parseObj(m.ping_config);

  const created = await api.entities.Delivery.create({
    buyer_id: m.buyer_id,
    name: `${buyerName || 'Buyer'} (converted)`,
    status: 'active',
    notes: 'Created by converting a legacy inline routing config.',
  });

  const headers = delivery.headers != null
    ? (typeof delivery.headers === 'string' ? delivery.headers : JSON.stringify(delivery.headers))
    : '';
  const fieldMap = delivery.body_template
    ? (typeof delivery.body_template === 'string' ? delivery.body_template : JSON.stringify(delivery.body_template))
    : '';

  const sub = await api.entities.SubDelivery.create({
    delivery_id: created.id,
    name: m.destination_name || 'Converted destination',
    active: true,
    order_index: 0,
    target_url: delivery.url || ping.url || '',
    method: 'POST',
    encoding: (delivery.format === 'form' ? 'form' : 'json'),
    headers,
    field_map: fieldMap,
    timeout_ms: Number(delivery.timeout_ms || ping.timeout_ms || 10000),
  });

  await api.entities.RouteMember.update(m.id, { sub_delivery_id: sub.id });
  return sub.id;
}