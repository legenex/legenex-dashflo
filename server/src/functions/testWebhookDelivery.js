import { requireUser } from './_runtime.js';
import { buildPayloadFromTemplate } from '../lib/payloadTemplate.js';

// ── Handler ───────────────────────────────────────────────────────────────
// The {{token|transform}} resolver used below lives in lib/payloadTemplate.js,
// shared with the native Delivery/SubDelivery dry-run/mock-send functions
// (deliveryPayloadPreview.js, deliveryMockSend.js) so both resolve tokens
// identically to the live pipeline rather than carrying separate copies.

// Caller model: operator-only. Fires an outbound POST to an operator-configured
// LeadByte destination using operator credentials, so it is gated to operators
// BEFORE any service-role read. Portal accounts and unauthenticated callers are
// rejected.
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

export default async function testWebhookDelivery(ctx) {
  const user = requireUser(ctx);
  const db = ctx.db;

  if (!(await assertOperator(db, user))) return ctx.json({ error: 'Forbidden' }, 403);

  const body = ctx.body || {};
  const { connector_id, test_payload } = body;

  if (!connector_id || !test_payload) {
    return ctx.json({ error: 'connector_id and test_payload are required' }, 400);
  }

  // Load connector
  const connectors = await db.entities.LeadByteConnector.filter({ id: connector_id });
  const connector = connectors[0];
  if (!connector) return ctx.json({ error: 'Connector not found' }, 404);

  // Resolve the Payload Template against the sample inbound lead using the SAME
  // resolver the live pipeline uses (canonical aliases + |transforms).
  const mode = connector.forwarding_mode || 'template';
  const outboundPayload = await buildPayloadFromTemplate(connector.payload_template, test_payload);

  // Build headers from connector header rows
  const headerRowsParsed = typeof connector.headers === 'string'
    ? JSON.parse(connector.headers || '[]')
    : (connector.headers || []);

  const lbHeaders = {};
  if (Array.isArray(headerRowsParsed)) {
    headerRowsParsed.forEach(row => { if (row.key) lbHeaders[row.key] = row.value; });
  } else {
    Object.assign(lbHeaders, headerRowsParsed);
  }

  const contentType = connector.content_type || 'application/json';
  lbHeaders['Content-Type'] = contentType;

  let bodyStr;
  if (contentType === 'application/x-www-form-urlencoded') {
    bodyStr = new URLSearchParams(typeof outboundPayload === 'object' ? outboundPayload : {}).toString();
  } else {
    bodyStr = typeof outboundPayload === 'string' ? outboundPayload : JSON.stringify(outboundPayload);
  }

  // POST directly to the destination
  let lbResponse = null;
  let httpStatus = null;
  try {
    const resp = await fetch(connector.target_url, {
      method: connector.http_method || 'POST',
      headers: lbHeaders,
      body: bodyStr,
    });
    httpStatus = resp.status;
    const text = await resp.text();
    try { lbResponse = JSON.parse(text); } catch { lbResponse = { raw: text }; }
  } catch (err) {
    lbResponse = { error: err.message };
  }

  return ctx.json({
    request_body: outboundPayload,
    lb_response: lbResponse,
    http_status: httpStatus,
    forwarding_mode: mode,
    target_url: connector.target_url,
  });
}
