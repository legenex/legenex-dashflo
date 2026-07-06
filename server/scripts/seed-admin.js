import bcrypt from 'bcryptjs';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ensureSchema } from '../src/db/schema.js';
import { pool } from '../src/db/pool.js';
import { repo, newId } from '../src/db/repo.js';

// Create (or reset) the first owner account. Usage:
//   node scripts/seed-admin.js [email] [password] [full_name]
// Falls back to interactive prompts / env (ADMIN_EMAIL, ADMIN_PASSWORD).
async function main() {
  await ensureSchema();

  let [, , email, password, fullName] = process.argv;
  email = email || process.env.ADMIN_EMAIL;
  password = password || process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    if (!email) email = await rl.question('Admin email: ');
    if (!password) password = await rl.question('Admin password: ');
    if (!fullName) fullName = await rl.question('Full name (optional): ');
    rl.close();
  }
  email = String(email).trim().toLowerCase();
  fullName = fullName || email.split('@')[0];

  const { rows } = await pool.query('SELECT * FROM auth_credentials WHERE lower(email) = lower($1)', [email]);
  const hash = await bcrypt.hash(String(password), 10);

  if (rows[0]) {
    await pool.query(
      'UPDATE auth_credentials SET password_hash = $2, otp_code = NULL, otp_expires = NULL WHERE user_id = $1',
      [rows[0].user_id, hash]
    );
    await repo('User').update(rows[0].user_id, { role: 'admin', base_role: 'owner' });
    console.log(`[seed] reset password + owner role for existing user ${email}`);
  } else {
    const userId = newId();
    await repo('User').create({ id: userId, email, full_name: fullName, role: 'admin', base_role: 'owner' });
    await pool.query(
      'INSERT INTO auth_credentials (user_id, email, password_hash) VALUES ($1, $2, $3)',
      [userId, email, hash]
    );
    console.log(`[seed] created owner ${email}`);
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
