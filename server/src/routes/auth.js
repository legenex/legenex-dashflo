import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { repo, newId } from '../db/repo.js';
import { config } from '../config.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { sendMail } from '../lib/mailer.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = express.Router();

// Anonymous auth endpoints are rate limited per address, and the ones that name
// an account are also limited per address and email together, so guessing a
// password or an OTP is bounded regardless of which dimension the attacker
// varies.
const byEmail = (req) => String(req.body?.email || '').trim().toLowerCase();

const limitLogin = rateLimit({ name: 'login', limit: 10, windowMs: 15 * 60_000 });
const limitLoginPerAccount = rateLimit({ name: 'login-account', limit: 5, windowMs: 15 * 60_000, by: byEmail });
const limitRegister = rateLimit({ name: 'register', limit: 5, windowMs: 60 * 60_000 });
const limitOtp = rateLimit({ name: 'otp', limit: 10, windowMs: 15 * 60_000, by: byEmail });
const limitReset = rateLimit({ name: 'reset', limit: 5, windowMs: 60 * 60_000 });

const genOtp = () => String(crypto.randomInt(100000, 1000000));
const normalizeEmail = (e) => String(e || '').trim().toLowerCase();

// Session cookie options. Secure is on whenever the deployment is not plain
// local development, so a production token is never sent over cleartext.
// SameSite lax keeps the cookie on top-level navigations back from an emailed
// link while refusing it on cross-site form posts.
function sessionCookieOptions() {
  const production = config.env === 'production';
  return {
    httpOnly: true,
    secure: production,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 864e5,
  };
}

async function credByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM auth_credentials WHERE lower(email) = lower($1)', [email]);
  return rows[0] || null;
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
      public_api_base_url: settings.public_api_base_url || config.publicApiBaseUrl || config.publicBaseUrl || '',
      // Closed unless an operator has explicitly opened it. This used to
      // default to open, and the register route did not enforce it either way,
      // so every visitor could create a privileged account.
      registration_open: settings.registration_open === true,
    },
  });
});

// Is open registration switched on? Read from AppSettings on each attempt so
// closing it takes effect immediately.
async function registrationIsOpen() {
  try {
    const settings = (await repo('AppSettings').list('-created_date', 1))[0];
    return settings?.registration_open === true;
  } catch {
    // If the setting cannot be read, refuse. Failing closed is the point.
    return false;
  }
}

// A fixed key for the advisory lock that serialises owner bootstrap. Any
// constant works as long as nothing else in the application uses it.
const BOOTSTRAP_LOCK_KEY = 4820157;

// Register.
//
// Two distinct paths, and neither is open by default:
//
//   1. Owner bootstrap, when there are no accounts at all. In production this
//      needs OWNER_BOOTSTRAP_TOKEN to be configured and presented, so the first
//      person to find the URL cannot claim the instance. The whole check and
//      insert run inside one transaction holding an advisory lock, so two
//      simultaneous requests cannot both become owner.
//   2. Ordinary registration, which requires an operator to have switched
//      registration on. New accounts are never owners.
router.post('/register', limitRegister, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (String(password).length < 12) {
    return res.status(400).json({ error: 'Password must be at least 12 characters' });
  }
  if (await credByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists' });

  const hash = await bcrypt.hash(password, 10);
  const otp = genOtp();
  const userId = newId();

  const client = await pool.connect();
  let isFirst = false;
  try {
    await client.query('BEGIN');
    // Serialise every registration attempt that could be a bootstrap. Released
    // automatically when the transaction ends.
    await client.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK_KEY]);

    const { rows } = await client.query('SELECT count(*)::int AS n FROM auth_credentials');
    isFirst = rows[0].n === 0;

    if (isFirst) {
      const expected = process.env.OWNER_BOOTSTRAP_TOKEN || '';
      if (config.env === 'production') {
        const provided = String(req.body?.bootstrap_token || '');
        const ok =
          expected.length > 0 &&
          provided.length === expected.length &&
          crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
        if (!ok) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            error: 'Owner bootstrap is not available',
            message: 'Set OWNER_BOOTSTRAP_TOKEN and present it, or seed the first account with npm run seed:admin.',
          });
        }
      }
    } else if (!(await registrationIsOpen())) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'Registration is closed',
        message: 'Ask an operator for an invitation.',
      });
    }

    await client.query(
      `INSERT INTO auth_credentials (user_id, email, password_hash, otp_code, otp_expires)
       VALUES ($1, $2, $3, $4, now() + interval '15 minutes')`,
      [userId, email, hash, otp]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // A unique violation means someone registered this email in the race.
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    throw err;
  } finally {
    client.release();
  }

  // The credential row is committed and owns the email, so creating the User
  // record afterwards cannot hand a second caller the owner role.
  await repo('User').create({
    id: userId,
    email,
    full_name: req.body?.full_name || email.split('@')[0],
    role: isFirst ? 'admin' : 'user',
    base_role: isFirst ? 'owner' : 'manager',
  });

  await sendMail({
    to: email,
    subject: 'Your DashOS verification code',
    text: `Your verification code is ${otp}. It expires in 15 minutes.`,
  });

  res.json({ success: true, requires_verification: true });
});

router.post('/verify-otp', limitOtp, async (req, res) => {
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
    .cookie(config.auth.cookieName, token, sessionCookieOptions())
    .json({ access_token: token, user });
});

router.post('/resend-otp', limitOtp, async (req, res) => {
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
router.post('/login', limitLogin, limitLoginPerAccount, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  const cred = await credByEmail(email);
  if (!cred || !cred.password_hash) return res.status(401).json({ error: 'Invalid email or password' });
  const ok = await bcrypt.compare(String(password || ''), cred.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  const user = await provisionUserOnLogin(cred, email);
  const token = signToken({ id: cred.user_id, email });
  res
    .cookie(config.auth.cookieName, token, sessionCookieOptions())
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
  // Clear with the same attributes it was set with, otherwise the browser
  // keeps the original cookie.
  const { maxAge, ...clearOpts } = sessionCookieOptions();
  res.clearCookie(config.auth.cookieName, clearOpts).json({ success: true });
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

router.post('/reset-password-request', limitReset, async (req, res) => {
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

router.post('/reset-password', limitReset, async (req, res) => {
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
