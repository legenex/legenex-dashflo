import { ensureSchema } from '../src/db/schema.js';
import { pool } from '../src/db/pool.js';

// Create/upgrade all tables. Safe to run repeatedly (IF NOT EXISTS everywhere).
await ensureSchema();
console.log('[migrate] schema ensured for all entities.');
await pool.end();
