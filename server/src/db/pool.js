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

/* Slow query visibility.
 *
 * Most call sites reach for pool.query directly rather than the `query` export,
 * so wrapping only the export would miss them. The instance method is replaced
 * once here instead, which covers every caller including the repositories.
 *
 * Only the statement text and the duration are logged. Parameter values are
 * never included: they carry lead identifiers, addresses, phone numbers and
 * account data, none of which belongs in an application log. The statement is
 * truncated because the point is to identify the query, not to reproduce it.
 */
const SLOW_QUERY_MS = Number.parseInt(process.env.SLOW_QUERY_MS || '', 10) || 300;

const originalQuery = pool.query.bind(pool);
pool.query = function loggedQuery(text, params, callback) {
  // The callback form is used by pg internals; leave it untouched.
  if (typeof params === 'function' || typeof callback === 'function') {
    return originalQuery(text, params, callback);
  }
  const startedAt = process.hrtime.bigint();
  const result = originalQuery(text, params);
  if (result && typeof result.then === 'function') {
    return result.finally(() => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (ms >= SLOW_QUERY_MS) {
        const statement = String(typeof text === 'string' ? text : text?.text || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 140);
        console.warn(`[slow-query] ${ms.toFixed(0)}ms ${statement}`);
      }
    });
  }
  return result;
};

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
