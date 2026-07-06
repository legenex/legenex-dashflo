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
export async function sendMail({ to, subject, text, html }) {
  const t = getTransport();
  if (!t) {
    console.log(`\n[mailer] SMTP not configured — email to ${to}:\n  Subject: ${subject}\n  ${text || html}\n`);
    return { queued: false, logged: true };
  }
  await t.sendMail({ from: config.smtp.from, to, subject, text, html });
  return { queued: true };
}

export default sendMail;
