import { requireUser } from './_runtime.js';
import { buildPayloadFromTemplate } from '../lib/payloadTemplate.js';

// Render / Dry Run for a native SubDelivery. Resolves payload_template
// against an operator-supplied sample lead and returns the rendered JSON.
// Makes NO outbound network call of any kind - this is the safe, always-
// available mode the canonical delivery editor's Testing section defaults to.
//
// Caller model: operator-only, mirrors testWebhookDelivery.js's gate.
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

export default async function deliveryPayloadPreview(ctx) {
  const user = requireUser(ctx);
  const db = ctx.db;
  if (!(await assertOperator(db, user))) return ctx.json({ error: 'Forbidden' }, 403);

  const body = ctx.body || {};
  const { sub_delivery_id, sample_lead } = body;
  if (!sub_delivery_id) return ctx.json({ error: 'sub_delivery_id required' }, 400);

  const sd = await db.entities.SubDelivery.get(sub_delivery_id).catch(() => null);
  if (!sd) return ctx.json({ error: 'SubDelivery not found' }, 404);

  const sampleLead = sample_lead && typeof sample_lead === 'object' ? sample_lead : {};
  const template = sd.payload_template || '';

  let renderedPayload = null;
  let renderError = null;
  if (template.trim() === '') {
    renderError = 'No payload_template configured on this SubDelivery.';
  } else {
    try {
      const resolved = await buildPayloadFromTemplate(template, sampleLead);
      renderedPayload = resolved;
    } catch (err) {
      renderError = err.message;
    }
  }

  const renderedText = renderedPayload != null
    ? (typeof renderedPayload === 'string' ? renderedPayload : JSON.stringify(renderedPayload, null, 2))
    : null;
  let validJson = false;
  if (renderedText != null) {
    try { JSON.parse(renderedText); validJson = true; } catch { validJson = false; }
  }

  return {
    ok: !renderError,
    error: renderError,
    target_url: sd.target_url || '',
    method: sd.method || 'POST',
    encoding: sd.encoding || 'json',
    rendered_payload: renderedText,
    valid_json: validJson,
  };
}
