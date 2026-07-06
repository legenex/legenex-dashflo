import { requireUser } from './_runtime.js';

// Generic outbound request tester: fires a payload at a target URL and returns
// the raw status/body so the UI can inspect the destination's response.
export default async function sendPayloadTest(ctx) {
  requireUser(ctx);
  try {
    const { target_url, method, content_type, payload, headers } = ctx.body || {};
    if (!target_url) return ctx.json({ error: 'target_url is required' }, 400);

    const hdrs = { 'Content-Type': content_type || 'application/json' };
    if (Array.isArray(headers)) {
      for (const h of headers) {
        if (h && h.key) hdrs[h.key] = h.value ?? '';
      }
    }

    const resp = await fetch(target_url, {
      method: method || 'POST',
      headers: hdrs,
      body: payload == null ? '' : String(payload),
    });

    const respText = await resp.text();
    let body;
    try { body = JSON.parse(respText); } catch { body = respText; }

    return {
      status: resp.status,
      statusText: resp.statusText,
      ok: resp.ok,
      body,
    };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
