import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { repo, newId } from '../db/repo.js';
import { config } from '../config.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { sendMail } from '../lib/mailer.js';

const router = express.Router();

const genOtp = () => String(Math.floor(100000 + Math.random() * 900000));
const normalizeEmail = (e) => String(e || '').trim().toLowerCase();

async function credByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM auth_credentials WHERE lower(email) = lower($1)', [email]);
  return rows[0] || null;
}

async function userCount() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM auth_credentials');
  return rows[0].n;
}

// Public app settings (branding, whether registration is open, etc.). Replaces
// the platform's public-settings endpoint the frontend expects on boot.
router.get('/public-settings', async (_req, res) => {
  let settings = {};
  try {
    const appSettings = (await repo('AppSettings').list('-created_date', 1))[0];
    settings = appSettings || {};
  } catch { /* AppSettings may be empty */ }
  res.json({
    id: 'dashos',
    public_settings: {
      name: settings.company_name || 'DashOS',
      public_base_url: settings.public_base_url || config.publicBaseUrl || '',
      registration_open: settings.registration_open ?? true,
    },
  });
});

// Register: creates the User entity + credentials, issues an OTP.
router.post('/register', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (await credByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists' });

  const isFirst = (await userCount()) === 0;
  const userId = newId();
  const hash = await bcrypt.hash(password, 10);
  const otp = genOtp();

  await repo('User').create({
    id: userId,
    email,
    full_name: req.body?.full_name || email.split('@')[0],
    role: isFirst ? 'admin' : 'user',
    base_role: isFirst ? 'owner' : 'manager',
  });
  await pool.query(
    `INSERT INTO auth_credentials (user_id, email, password_hash, otp_code, otp_expires)
     VALUES ($1, $2, $3, $4, now() + interval '15 minutes')`,
    [userId, email, hash, otp]
  );

  await sendMail({
    to: email,
    subject: 'Your DashOS verification code',
    text: `Your verification code is ${otp}. It expires in 15 minutes.`,
  });

  res.json({ success: true, requires_verification: true });
});

router.post('/verify-otp', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const otpCode = String(req.body?.otpCode || req.body?.otp_code || '').trim();
  const cred = await credByEmail(email);
  if (!cred) return res.status(404).json({ error: 'Account not found' });
  if (!cred.otp_code || cred.otp_code !== otpCode) return res.status(400).json({ error: 'Invalid code' });
  if (cred.otp_expires && new Date(cred.otp_expires) < new Date()) return res.status(400).json({ error: 'Code expired' });

  await pool.query('UPDATE auth_credentials SET otp_code = NULL, otp_expires = NULL WHERE user_id = $1', [cred.user_id]);
  const user = await repo('User').get(cred.user_id);
  const token = signToken({ id: cred.user_id, email });
  res
    .cookie(config.auth.cookieName, token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 })
    .json({ access_token: token, user });
});

router.post('/resend-otp', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const cred = await credByEmail(email);
  if (!cred) return res.status(404).json({ error: 'Account not found' });
  const otp = genOtp();
  await pool.query(
    "UPDATE auth_credentials SET otp_code = $2, otp_expires = now() + interval '15 minutes' WHERE user_id = $1",
    [cred.user_id, otp]
  );
  await sendMail({ to: email, subject: 'Your DashOS verification code', text: `Your verification code is ${otp}.` });
  res.json({ success: true });
});

// Email + password login -> JWT.
router.post('/login', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  const cred = await credByEmail(email);
  if (!cred || !cred.password_hash) return res.status(401).json({ error: 'Invalid email or password' });
  const ok = await bcrypt.compare(String(password || ''), cred.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  const user = await provisionUserOnLogin(cred, email);
  const token = signToken({ id: cred.user_id, email });
  res
    .cookie(config.auth.cookieName, token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 })
    .json({ access_token: token, user });
});

// Resolve the User record for a credential, provisioning it on first login for
// an invited user: create the User from their pending Invitation (applying its
// role/base_role/permissions) and mark the invitation accepted.
async function provisionUserOnLogin(cred, email) {
  let user = await repo('User').get(cred.user_id);
  if (user) return user;

  let invite = null;
  try {
    const invites = await repo('Invitation').filter({ email });
    invite = invites.find((i) => i.status !== 'cancelled') || null;
  } catch { /* Invitation entity may not exist */ }

  user = await repo('User').create({
    id: cred.user_id,
    email,
    full_name: (invite && invite.full_name) || email.split('@')[0],
    role: invite?.role || 'user',
    base_role: invite?.base_role || 'manager',
    permissions: invite?.permissions || undefined,
  });
  if (invite && invite.status === 'pending') {
    try { await repo('Invitation').update(invite.id, { status: 'accepted' }); } catch { /* best effort */ }
  }
  return user;
}

router.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

router.post('/update-me', requireAuth, async (req, res) => {
  const patch = { ...req.body };
  delete patch.id; delete patch.role; delete patch.base_role; // profile fields only
  const updated = await repo('User').update(req.user.id, patch);
  res.json(updated);
});

router.post('/logout', (_req, res) => {
  res.clearCookie(config.auth.cookieName).json({ success: true });
});

// Invite a user: admin-only. Creates a credential row with a set-password token
// and emails an invite link, but does NOT create a User record yet — the invited
// person shows as "Pending" (via the Invitation entity recorded by the UI) until
// they set a password and log in, at which point their User record is provisioned
// from the pending invitation (see /login). This matches the pending-invite model.
router.post('/invite', requireAuth, async (req, res) => {
  const caller = req.user;
  if ((caller.base_role || caller.role) !== 'owner' && caller.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'email is required' });

  let cred = await credByEmail(email);
  const userId = cred ? cred.user_id : newId();
  const token = crypto.randomBytes(24).toString('hex');
  if (cred) {
    await pool.query(
      "UPDATE auth_credentials SET reset_token = $2, reset_expires = now() + interval '7 days' WHERE user_id = $1",
      [userId, token]
    );
  } else {
    await pool.query(
      "INSERT INTO auth_credentials (user_id, email, reset_token, reset_expires) VALUES ($1, $2, $3, now() + interval '7 days')",
      [userId, email, token]
    );
  }

  const base = config.publicBaseUrl || '';
  await sendMail({
    to: email,
    subject: "You've been invited to DashOS",
    text: `You've been invited to DashOS. Set your password to get started: ${base}/reset-password?token=${token}`,
  });

  res.json({ success: true, user_id: userId });
});

router.post('/reset-password-request', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const cred = await credByEmail(email);
  // Always respond success (don't leak which emails exist).
  if (cred) {
    const token = crypto.randomBytes(24).toString('hex');
    await pool.query(
      "UPDATE auth_credentials SET reset_token = $2, reset_expires = now() + interval '1 hour' WHERE user_id = $1",
      [cred.user_id, token]
    );
    const base = config.publicBaseUrl || '';
    await sendMail({
      to: email,
      subject: 'Reset your DashOS password',
      text: `Reset your password: ${base}/reset-password?token=${token}`,
    });
  }
  res.json({ success: true });
});

router.post('/reset-password', async (req, res) => {
  const resetToken = req.body?.resetToken || req.body?.reset_token;
  const newPassword = req.body?.newPassword || req.body?.new_password;
  if (!resetToken || !newPassword) return res.status(400).json({ error: 'Missing token or password' });
  const { rows } = await pool.query('SELECT * FROM auth_credentials WHERE reset_token = $1', [resetToken]);
  const cred = rows[0];
  if (!cred || (cred.reset_expires && new Date(cred.reset_expires) < new Date())) {
    return res.status(400).json({ error: 'Invalid or expired reset link' });
  }
  const hash = await bcrypt.hash(String(newPassword), 10);
  await pool.query(
    'UPDATE auth_credentials SET password_hash = $2, reset_token = NULL, reset_expires = NULL WHERE user_id = $1',
    [cred.user_id, hash]
  );
  res.json({ success: true });
});

export default router;
