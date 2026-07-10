import processLead from './processLead.js';

// Validation-only endpoint (/functions/validate)
// Thin delegator: sets _dry_run: true on the payload and hands off to processLead,
// which validates and returns immediately with zero side effects (no Lead, no
// counter, no HLR, no CAPI, no LeadByte, no Delivery, no ApiKey increment).
//
// Injects the supplier API key from request headers into the payload (as
// _supplier_key) so processLead can authenticate.
export default async function validate(ctx) {
  const method = ctx.req?.method || 'POST';

  // CORS preflight (CORS headers themselves are applied at the app layer).
  if (method === 'OPTIONS') {
    return ctx.json({}, 204);
  }

  if (method === 'GET') return ctx.json({ status: 'ok' }, 200);
  if (method !== 'POST') return ctx.json({ Response: 'Error', reason: 'Method not allowed' }, 405);

  try {
    const body = ctx.body || {};
    const payload = body.payload || body;

    // Extract API key from headers and inject into payload so processLead can authenticate.
    const headers = ctx.req?.headers || {};
    let supplierKeyRaw =
      headers['x-api-key'] ||
      headers['x_key'] ||
      null;
    if (!supplierKeyRaw) {
      const authHeader = headers['authorization'] || '';
      if (typeof authHeader === 'string' && authHeader.startsWith('Basic ')) {
        const decoded = atob(authHeader.slice(6));
        supplierKeyRaw = decoded.split(':')[0] || null;
      }
    }
    if (supplierKeyRaw && !payload._supplier_key) {
      payload._supplier_key = supplierKeyRaw;
    }

    // Mark this as a validation-only dry run.
    payload._dry_run = true;
    // Pass an optional campaign reference through for the qualification advisory.
    if (body._campaign !== undefined && payload._campaign === undefined) {
      payload._campaign = body._campaign;
    }

    // Delegate to processLead with the payload as its body. processLead returns
    // either a plain object (200) or ctx.json(body, status); propagate as-is so
    // both the success body and any validation error status are preserved.
    try {
      const result = await processLead({ ...ctx, body: payload });
      const data = result?.data !== undefined ? result.data : result;
      return data;
    } catch (invokeErr) {
      const errData = invokeErr?.response?.data;
      const errStatus = invokeErr?.response?.status || 200;
      if (errData) {
        return ctx.json(errData, errStatus);
      }
      return ctx.json(
        { Response: 'Error', reason: invokeErr?.message || 'Validation failed' },
        200
      );
    }
  } catch (err) {
    return ctx.json({ Response: 'Error', reason: 'Internal processing error' }, 200);
  }
}
