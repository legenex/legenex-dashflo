import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

// pg returns NUMERIC as string by default; parse to float so JSON math works.
pg.types.setTypeParser(1700, (v) => (v == null ? null : parseFloat(v)));
// BIGINT -> number (safe for our id counters / small values)
pg.types.setTypeParser(20, (v) => (v == null ? null : parseInt(v, 10)));

export const pool = config.db.connectionString
  ? new Pool({ connectionString: config.db.connectionString, ssl: config.db.ssl })
  : new Pool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      ssl: config.db.ssl,
    });

export const query = (text, params) => pool.query(text, params);

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export default pool;
