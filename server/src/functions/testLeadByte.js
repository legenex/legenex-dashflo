import { requireUser, HttpError, json } from './_runtime.js';

// Caller model: operator-only. Fires an outbound POST to an operator-configured
// destination using operator credentials, so it must be gated to operators
// BEFORE any privileged read. Portal (buyer/supplier) accounts and
// unauthenticated callers are rejected.
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

export default async function testLeadByte(ctx) {
  const db = ctx.db;
  const user = requireUser(ctx);
  if (!(await assertOperator(db, user))) return ctx.json({ error: 'Forbidden' }, 403);

  const body = ctx.body || {};
  const { connector_id, test_payload } = body;

  const connectors = await db.entities.LeadByteConnector.filter({ id: connector_id });
  if (!connectors.length) return ctx.json({ error: 'Connector not found' }, 404);
  const conn = connectors[0];

  const headerRows = typeof conn.headers === 'string' ? JSON.parse(conn.headers || '[]') : (conn.headers || []);
  const headers = {};
  if (Array.isArray(headerRows)) {
    headerRows.forEach(row => { if (row.key) headers[row.key] = row.value; });
  } else {
    Object.assign(headers, headerRows);
  }

  const contentType = conn.content_type || 'application/json';
  headers['Content-Type'] = contentType;

  let bodyStr;
  if (contentType === 'application/x-www-form-urlencoded') {
    bodyStr = new URLSearchParams(test_payload || {}).toString();
  } else {
    bodyStr = JSON.stringify(test_payload || {});
  }

  try {
    const resp = await fetch(conn.target_url, {
      method: conn.http_method || 'POST',
      headers,
      body: bodyStr,
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: resp.status, response: data };
  } catch (err) {
    return ctx.json({ error: err.message }, 200);
  }
}
