#!/usr/bin/env node
// One-off import of base44 app data (exported as JSON) into the local Postgres.
// Reads sync/state/import-export/<Entity>.json (array of records straight from
// the source app) and upserts each into its e_<snake> table, PRESERVING the
// original id, created_date, updated_date and created_by so cross-entity
// references (buyer_id, supplier_id, campaign_id, …) stay valid.
//
// Usage: node sync/import-data.mjs [--truncate]
//   --truncate  empty each target table before importing (clean load)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../server/src/db/pool.js';
import { tableName, entityNames } from '../server/src/schemas/index.js';
import { ensureSchema } from '../server/src/db/schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.join(HERE, 'state', 'import-export');
const TRUNCATE = process.argv.includes('--truncate');
const META = new Set(['id', 'created_date', 'updated_date', 'created_by', 'created_by_id']);

function splitRecord(rec) {
  const data = {};
  for (const [k, v] of Object.entries(rec)) if (!META.has(k)) data[k] = v;
  return {
    id: rec.id,
    created_date: rec.created_date || null,
    updated_date: rec.updated_date || rec.created_date || null,
    created_by: rec.created_by || rec.created_by_id || null,
    data,
  };
}

async function main() {
  await ensureSchema();
  const files = fs.existsSync(EXPORT_DIR)
    ? fs.readdirSync(EXPORT_DIR).filter((f) => f.endsWith('.json'))
    : [];
  if (!files.length) { console.error(`No export files in ${EXPORT_DIR}`); process.exit(1); }

  const summary = [];
  for (const file of files.sort()) {
    const name = path.basename(file, '.json');
    if (name === 'User') { summary.push([name, 'skipped (local auth)']); continue; }
    if (!entityNames.includes(name)) { summary.push([name, 'skipped (unknown entity)']); continue; }

    let records;
    try { records = JSON.parse(fs.readFileSync(path.join(EXPORT_DIR, file), 'utf8')); }
    catch (e) { summary.push([name, `bad JSON: ${e.message}`]); continue; }
    if (!Array.isArray(records)) records = records?.entities || [];

    const table = tableName(name);
    const client = await pool.connect();
    let ok = 0, fail = 0;
    try {
      await client.query('BEGIN');
      if (TRUNCATE) await client.query(`DELETE FROM ${table}`);
      for (const rec of records) {
        if (!rec || !rec.id) { fail++; continue; }
        const { id, created_date, updated_date, created_by, data } = splitRecord(rec);
        try {
          await client.query(
            `INSERT INTO ${table} (id, data, created_by, created_date, updated_date)
             VALUES ($1, $2::jsonb, $3, COALESCE($4::timestamptz, now()), COALESCE($5::timestamptz, now()))
             ON CONFLICT (id) DO UPDATE SET
               data = EXCLUDED.data, created_by = EXCLUDED.created_by,
               created_date = EXCLUDED.created_date, updated_date = EXCLUDED.updated_date`,
            [id, JSON.stringify(data), created_by, created_date, updated_date]
          );
          ok++;
        } catch (e) { fail++; if (fail <= 2) console.error(`  ${name} row ${id}: ${e.message}`); }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      summary.push([name, `FAILED: ${e.message}`]);
      client.release();
      continue;
    }
    client.release();
    summary.push([name, `${ok} imported${fail ? `, ${fail} failed` : ''}`]);
  }

  console.log('\n=== IMPORT SUMMARY ===');
  let total = 0;
  for (const [name, msg] of summary) {
    console.log(`  ${name.padEnd(24)} ${msg}`);
    const m = msg.match(/^(\d+) imported/); if (m) total += parseInt(m[1], 10);
  }
  console.log(`\n  total records imported: ${total}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
