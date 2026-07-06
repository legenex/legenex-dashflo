import { requireUser } from './_runtime.js';

// HLR phone lookup test. Sends a single number to the configured HLR endpoint and
// returns the raw request/response so the UI can verify the integration.
// The frontend reads resp.data, i.e. { request, response }.
export default async function testHlr(ctx) {
  requireUser(ctx);

  const body = ctx.body || {};
  const { phone, firstname, lastname } = body;

  const hlrBaseUrl = ctx.config.integrations.hlrBaseUrl || ctx.env.HLR_BASE_URL || '';
  const hlrApiKey = ctx.config.integrations.hlrApiKey || ctx.env.HLR_API_KEY || '';
  if (!hlrBaseUrl || !hlrApiKey) {
    return ctx.json({ error: 'No HLR settings configured' }, 404);
  }

  // Always send the HLR field names directly.
  const hlrBody = {
    mobile: phone,
    first_name: firstname,
    last_name: lastname,
  };

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(hlrBaseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hlrApiKey}`,
      },
      body: JSON.stringify(hlrBody),
      signal: controller.signal,
    });
    clearTimeout(tid);
    const data = await resp.json();
    return { request: hlrBody, response: data };
  } catch (err) {
    return ctx.json({ error: err.message, request: hlrBody }, 200);
  }
}
