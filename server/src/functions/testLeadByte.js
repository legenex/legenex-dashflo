import { requireUser } from './_runtime.js';

// Sends a test payload to a LeadByte connector's target URL and returns the raw response.
export default async function testLeadByte(ctx) {
  requireUser(ctx);
  const db = ctx.db;

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
