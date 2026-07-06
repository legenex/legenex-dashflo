import bcrypt from 'bcryptjs';
import { ensureSchema } from '../src/db/schema.js';
import { pool } from '../src/db/pool.js';
import { repo, newId } from '../src/db/repo.js';

// Upsert a set of users with explicit roles. Idempotent: existing emails get
// their password + role reset; new emails are created.
//
// Credentials are read from environment variables so no secrets live in the
// repo. Set them before running, e.g.:
//   OWNER_EMAIL=owner@example.com OWNER_PASSWORD='...' \
//   ADMIN2_EMAIL=admin@example.com ADMIN2_PASSWORD='...' \
//   node scripts/seed-users.js
const USERS = [
  {
    email: process.env.OWNER_EMAIL,
    password: process.env.OWNER_PASSWORD,
    full_name: process.env.OWNER_NAME || 'Owner',
    role: 'admin',
    base_role: 'owner',
  },
  {
    email: process.env.ADMIN2_EMAIL,
    password: process.env.ADMIN2_PASSWORD,
    full_name: process.env.ADMIN2_NAME || 'Admin',
    role: 'admin',
    base_role: 'admin',
  },
].filter((u) => u.email && u.password);

async function upsert(u) {
  const email = u.email.trim().toLowerCase();
  const hash = await bcrypt.hash(u.password, 10);
  const { rows } = await pool.query('SELECT * FROM auth_credentials WHERE lower(email) = lower($1)', [email]);
  if (rows[0]) {
    await pool.query(
      'UPDATE auth_credentials SET password_hash = $2, otp_code = NULL, otp_expires = NULL WHERE user_id = $1',
      [rows[0].user_id, hash]
    );
    await repo('User').update(rows[0].user_id, { role: u.role, base_role: u.base_role, full_name: u.full_name });
    console.log(`[seed] updated ${email} -> ${u.base_role}`);
  } else {
    const userId = newId();
    await repo('User').create({ id: userId, email, full_name: u.full_name, role: u.role, base_role: u.base_role });
    await pool.query('INSERT INTO auth_credentials (user_id, email, password_hash) VALUES ($1, $2, $3)', [userId, email, hash]);
    console.log(`[seed] created ${email} -> ${u.base_role}`);
  }
}

if (!USERS.length) {
  console.error('[seed] No users configured. Set OWNER_EMAIL/OWNER_PASSWORD (and optionally ADMIN2_EMAIL/ADMIN2_PASSWORD).');
  process.exit(1);
}
await ensureSchema();
for (const u of USERS) await upsert(u);
await pool.end();
console.log('[seed] done');
