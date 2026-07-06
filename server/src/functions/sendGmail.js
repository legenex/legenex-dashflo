import { requireUser } from './_runtime.js';
import { sendMail } from '../lib/mailer.js';
import { config } from '../config.js';

// Sends a plain-text email on behalf of the operator. Also acts as a lightweight
// "is email configured?" probe: called with no `to`, it just reports the
// connection state and the From address.
export default async function sendGmail(ctx) {
  requireUser(ctx);

  try {
    const body = ctx.body || {};

    // From address + connection state come from the SMTP configuration.
    const from = config.smtp.from || '';
    const connected = !!config.smtp.host;

    const to = String(body.to || '').trim();
    if (!to) return { connected, from };

    if (!connected) {
      return { success: false, from, error: 'Email is not configured' };
    }

    const subject = String(body.subject || 'Test from Legenex');
    const text = String(body.body || '');

    try {
      const result = await sendMail({ to, subject, text });
      return { success: true, from, id: result?.messageId ?? null };
    } catch (err) {
      return { success: false, from, error: err.message };
    }
  } catch (error) {
    return ctx.json({ error: error.message, connected: false }, 500);
  }
}
