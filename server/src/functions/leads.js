import { getFunction } from './index.js';

// Public lead intake endpoint (/functions/leads)
// Delegates the ENTIRE lead-processing pipeline to processLead so there is
// a single source of truth. processLead handles: API-key auth, HLR, custom
// calculations, TrustedForm gate, required-fields gate, LeadByte connector
// filters & field conditions (with DQ routing), revenue capture, Facebook
// CAPI + Deliveries firing on all triggers, duplicate handling, response
// mapping, and outbound webhooks.
//
// This wrapper handles method gating and injects the supplier API key from
// headers into the payload (as _supplier_key) so processLead can find it.

export default async function leads(ctx) {
  const method = ctx.req.method;

  // CORS preflight
  if (method === 'OPTIONS') return ctx.json(null, 204);

  if (method === 'GET') return ctx.json({ status: 'ok' }, 200);
  if (method !== 'POST') return ctx.json({ Response: 'Error', reason: 'Method not allowed' }, 405);

  try {
    const body = ctx.body || {};
    const payload = body.payload || body;

    // Extract API key from headers and inject into payload so processLead can authenticate.
    let supplierKeyRaw =
      ctx.req.get('X-API-KEY') ||
      ctx.req.get('X_KEY') ||
      ctx.req.get('x-api-key') ||
      ctx.req.get('x_key') ||
      null;
    if (!supplierKeyRaw) {
      const authHeader = ctx.req.get('Authorization') || '';
      if (authHeader.startsWith('Basic ')) {
        const decoded = atob(authHeader.slice(6));
        supplierKeyRaw = decoded.split(':')[0] || null;
      }
    }
    if (supplierKeyRaw && !payload._supplier_key) {
      payload._supplier_key = supplierKeyRaw;
    }

    // Delegate to processLead (single source of truth for the pipeline).
    const processLead = getFunction('processLead');
    if (!processLead) {
      return ctx.json({ Response: 'Error', reason: 'Lead processing is not available' }, 200);
    }

    try {
      const result = await processLead({ ...ctx, body: payload });
      // processLead returns either a plain object (200) or a json() wrapper.
      if (result && result.__httpResponse) {
        return ctx.json(result.body, result.status);
      }
      return ctx.json(result ?? {}, 200);
    } catch (invokeErr) {
      return ctx.json(
        { Response: 'Error', reason: invokeErr?.message || 'Processing failed' },
        200
      );
    }
  } catch (err) {
    return ctx.json({ Response: 'Error', reason: 'Internal processing error' }, 200);
  }
}
