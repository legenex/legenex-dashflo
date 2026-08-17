// Endpoints the public marketing website calls.
//
// The marketing site is a static bundle on dashflo.io. It is not part of the
// application and is not trusted by it. Two narrow surfaces are opened here.
//
// Neither of these is added to ALLOWED_ORIGINS. That set decides which origins
// may perform cookie-authenticated writes, and widening it would give a static
// public site CSRF standing over the application. Each route below sets its own
// headers for the one origin and the one method it needs.

import express from 'express';
import { config } from '../config.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { sendMail } from '../lib/mailer.js';
import { validateContact, buildContactMessage, isHoneypotFilled } from '../lib/contactMessage.js';

const router = express.Router();

// A form a person fills in by hand takes longer than this. Anything faster is
// automated. Client supplied and therefore trivially forged, so it is treated
// as one weak signal alongside the honeypot, never as the only defence.
const MIN_FILL_MS = 2000;

function marketingCors(res, origin, { credentials = false } = {}) {
  res.setHeader('Vary', 'Origin');
  if (origin !== config.marketingOrigin) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  if (credentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
  return true;
}

/* Whether the caller already has an application session.
 *
 * The response is one boolean. No identifier, email, role, organisation, or
 * permission is returned, because the only question the homepage has is which
 * call to action to render.
 *
 * The session cookie stays exactly as it is: host-only to the application,
 * HttpOnly, and never readable by the marketing site's JavaScript. This route
 * reads it server-side and reports a yes or no.
 *
 * dashflo.io and app.dashflo.io share the registrable domain, so the browser
 * treats this as same-site and sends the SameSite=Lax cookie, while CORS still
 * applies because the origins differ.
 */
router.get('/auth/session-status', (req, res) => {
  marketingCors(res, req.headers.origin, { credentials: true });
  // A stale cached "true" would show a dashboard link to a signed-out visitor.
  res.setHeader('Cache-Control', 'no-store');
  res.json({ authenticated: Boolean(req.user) });
});

// Preflight for the contact POST. The JSON content type makes it a
// non-simple request, so the browser asks first.
router.options('/contact', (req, res) => {
  if (!marketingCors(res, req.headers.origin)) return res.status(403).end();
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  return res.status(204).end();
});

const limitContact = rateLimit({ name: 'contact', limit: 5, windowMs: 60 * 60_000 });

/* Public contact form.
 *
 * The recipient, the sender, and the SMTP connection all come from server
 * configuration. The browser supplies message content only, so this cannot be
 * turned into a relay for someone else's mail.
 */
router.post('/contact', limitContact, async (req, res) => {
  marketingCors(res, req.headers.origin);

  const body = req.body || {};

  // Accepted and dropped. Returning success teaches a bot nothing about which
  // check caught it, and a person who somehow trips this is not left staring at
  // an error they cannot act on.
  const tooFast = Number.isFinite(Number(body.elapsedMs)) && Number(body.elapsedMs) < MIN_FILL_MS;
  if (isHoneypotFilled(body) || tooFast) {
    console.log(`[contact] discarded automated submission (reason=${isHoneypotFilled(body) ? 'honeypot' : 'timing'})`);
    return res.json({ success: true });
  }

  const { valid, fields, value } = validateContact(body);
  if (!valid) {
    return res.status(400).json({ error: 'Invalid submission', fields });
  }

  const message = buildContactMessage({
    value,
    recipient: config.contact.recipient,
    from: config.smtp.from,
    fromName: config.smtp.fromName,
  });

  try {
    const result = await sendMail({
      to: message.to,
      subject: message.subject,
      text: message.text,
      replyTo: message.replyTo,
      from: message.from,
      sensitive: true,
    });

    // Metadata only. The submitted name, address, subject, and message body are
    // never written to the application log.
    console.log(`[contact] accepted topic=${value.topic} delivered=${result?.queued === true}`);

    if (result?.queued === false) {
      // SMTP is not configured on this deployment. Saying so plainly beats
      // telling a visitor their message was sent when it was only logged.
      return res.status(503).json({
        error: 'Email delivery is not configured',
        message: 'We could not send that message right now. Please email us directly.',
      });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error(`[contact] delivery failed: ${err?.message || 'unknown error'}`);
    return res.status(502).json({
      error: 'Delivery failed',
      message: 'We could not send that message right now. Please email us directly.',
    });
  }
});

export default router;
