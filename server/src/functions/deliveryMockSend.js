import { requireUser } from './_runtime.js';
import * as engine from './routingEngine.generated.js';
const { buildPayloadFromTemplate } = engine;

// Mock Send for a native SubDelivery: renders the real payload template
// (same as deliveryPayloadPreview.js) AND runs an operator-supplied simulated
// HTTP response through the SAME classifyResponse the live send path uses, so
// an operator can see exactly what DashFlo would conclude - accepted,
// rejected, duplicate, queued, or error - without ever making a real network
// call. This is deliberately NOT deliverDirectPost: no fetch, no target host
// is ever contacted, so this is safe to run against any buyer's real
// target_url with zero risk of a live commercial side effect.
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

function getPath(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function parseJson(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

export default async function deliveryMockSend(ctx) {
  const user = requireUser(ctx);
  const db = ctx.db;
  if (!(await assertOperator(db, user))) return ctx.json({ error: 'Forbidden' }, 403);

  const body = ctx.body || {};
  const { sub_delivery_id, sample_lead, simulated } = body;
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
    try { renderedPayload = await buildPayloadFromTemplate(template, sampleLead); }
    catch (err) { renderError = err.message; }
  }

  // simulated: { http_status, body, error } - all operator-supplied, never a
  // real response. `error` (e.g. "timeout") short-circuits to ERROR exactly
  // as a real network failure would.
  const sim = simulated && typeof simulated === 'object' ? simulated : {};
  const evalMapping = engine.toClassifyResponseMapping(parseJson(sd.response_mapping));
  const classification = sim.error
    ? { status: engine.ATTEMPT_STATUS.ERROR }
    : { status: engine.classifyResponse({
        httpStatus: sim.http_status != null ? Number(sim.http_status) : null,
        body: sim.body ?? '',
        mapping: evalMapping,
      }) };

  let parsedResponse = null;
  try { parsedResponse = JSON.parse(sim.body ?? ''); } catch { /* not JSON */ }
  const revenue = classification.status === engine.ATTEMPT_STATUS.ACCEPTED && parsedResponse
    ? getPath(parsedResponse, evalMapping.revenuePath) : undefined;
  const buyerLeadId = parsedResponse ? getPath(parsedResponse, evalMapping.leadIdPath) : undefined;

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
    rendered_payload: renderedText,
    valid_json: validJson,
    simulated_result: {
      status: classification.status,
      revenue: revenue ?? null,
      buyer_lead_id: buyerLeadId ?? null,
    },
    note: 'No network request was made. This classifies an operator-supplied simulated response only.',
  };
}
