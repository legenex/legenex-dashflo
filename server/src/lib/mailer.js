import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transporter = null;
function getTransport() {
  if (!config.smtp.host) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transporter;
}

// Send an email. When SMTP isn't configured, logs to console (dev-friendly)
// so OTP / reset flows still work locally.
//
// `from` overrides the configured sender for callers that build their own
// identity. `replyTo` lets a reply reach someone other than the sender, which
// is how the public contact form routes answers back to a visitor without ever
// sending as them.
//
// `sensitive` suppresses the body in the unconfigured-SMTP log. Message content
// submitted by the public does not belong in application logs, whereas a local
// OTP printed to the console is the point of that branch.
export async function sendMail({ to, subject, text, html, from, replyTo, sensitive = false }) {
  const t = getTransport();
  if (!t) {
    const body = sensitive ? '[body withheld]' : (text || html);
    console.log(`\n[mailer] SMTP not configured, email to ${to}:\n  Subject: ${subject}\n  ${body}\n`);
    return { queued: false, logged: true };
  }
  await t.sendMail({ from: from || config.smtp.from, to, subject, text, html, replyTo });
  return { queued: true };
}

export default sendMail;
