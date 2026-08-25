// Write SubDelivery.headers with a server-side merge against the real
// stored value, the same reason saveIntegrationConfig.js exists for
// IntegrationConfig.config.
//
// entityPolicy.js's READ_TRANSFORM_FIELDS redacts any secret-shaped header
// value (Authorization, api_key, token, ...) to the literal string
// "[redacted]" before a SubDelivery is ever sent to the browser - correct,
// since the real value must never reach the client. But the canonical
// Delivery editor loads a SubDelivery's headers into an editable key/value
// row list and later saves the WHOLE headers object back through the
// generic entity route. Without this function, a save that never touched an
// already-secret-shaped header row would still resubmit its value as the
// literal "[redacted]" string, permanently overwriting the real header
// value with a placeholder - a silent, unrecoverable outage for that
// destination's authentication. This is the fix: merge the incoming write
// against the real stored value server-side, where the real value is
// available, so a row the operator never actually retyped is preserved
// exactly as stored.
//
// Only "[redacted]" incoming values for a key that already existed are
// replaced with the real stored value. A key absent from the incoming
// object (the operator removed that row) is dropped, matching the editor's
// own remove-row semantics. A brand-new key, or an existing key given a
// genuinely different value, is written as the operator typed it.

import { requireUser } from './_runtime.js';

function parseObj(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export default async function saveSubDeliveryHeaders(ctx) {
  requireUser(ctx);
  const db = ctx.db;
  const subDeliveryId = String(ctx.body?.subDeliveryId || '').trim();
  if (!subDeliveryId) return ctx.json({ success: false, error: 'subDeliveryId is required' }, 400);

  const sub = await db.entities.SubDelivery.get(subDeliveryId).catch(() => null);
  if (!sub) return ctx.json({ success: false, error: 'SubDelivery not found' }, 404);

  const stored = parseObj(sub.headers);
  const incoming = parseObj(ctx.body?.headers);

  const merged = {};
  for (const [key, value] of Object.entries(incoming)) {
    merged[key] = value === '[redacted]' && key in stored ? stored[key] : value;
  }

  const payload = Object.keys(merged).length ? JSON.stringify(merged) : '';
  await db.entities.SubDelivery.update(subDeliveryId, { headers: payload });
  return ctx.json({ success: true });
}
