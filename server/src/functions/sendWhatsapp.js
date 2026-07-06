import { requireUser } from './_runtime.js';

// Sends a WhatsApp text message via the WhatsApp Business Cloud API.
// Credentials (token + phone number id) come from the integration config.
export default async function sendWhatsapp(ctx) {
  requireUser(ctx);

  try {
    const body = ctx.body || {};
    const to = body?.to;
    const text = body?.body;
    if (!to || !text) return ctx.json({ error: 'to and body are required' }, 400);

    const accessToken = ctx.config.integrations.whatsappToken;
    const phoneNumberId = ctx.config.integrations.whatsappPhoneId;
    if (!accessToken || !phoneNumberId) {
      return ctx.json({ error: 'WhatsApp is not configured. Add your API credentials first.' }, 400);
    }

    const apiRes = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(to).replace(/\D/g, ''),
        type: 'text',
        text: { body: text },
      }),
    });

    const data = await apiRes.json();
    if (!apiRes.ok) {
      const msg = data?.error?.message || 'WhatsApp send failed';
      return ctx.json({ error: msg, details: data }, 502);
    }
    return { success: true, data };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
