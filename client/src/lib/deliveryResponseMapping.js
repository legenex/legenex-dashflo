// Pure parse helper for SubDelivery.response_mapping. Split out from
// DeliveryResponseRulesEditor.jsx so this can be unit tested without a DOM
// environment. Shape: { accepted, rejected, duplicate, queued, revenue,
// buyer_lead_id, require_accept } - see deliveryResolve.js's toResponseMapping.
export function parseResponseMapping(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getResponsePath(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
