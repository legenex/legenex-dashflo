#!/usr/bin/env node
// Move stored credentials off the retired Legenex namespace.
//
//   node server/scripts/migrate-key-namespace.js            report only
//   node server/scripts/migrate-key-namespace.js --apply     write changes
//
// Report mode is the default and writes nothing, so this is safe to run
// against production to find out what it would do.
//
// There are two populations and they need different treatment, because what
// can be done to a credential depends entirely on whether its cleartext still
// exists somewhere.
//
//   Convertible. The row still carries the legacy cleartext `key` column, from
//     before hash-only storage. The value is translated into the DashFlo
//     namespace, rehashed, and the prefix recomputed. The credential changes,
//     so whoever holds the old value must be given the new one, but nothing is
//     lost and the conversion is deterministic.
//
//   Rotation required. The row is hash-only and its prefix says `lgnx_`. The
//     cleartext does not exist anywhere, by design, so there is nothing to
//     translate: a SHA-256 cannot be moved to a different namespace without
//     the input that produced it. These are flagged rather than changed. The
//     operator rotates them from the API Keys screen, which mints a DashFlo
//     value and shows it once. That is the only correct place for a new
//     credential to appear.
//
// The script never prints a credential value, in either mode. Prefixes are
// printed because they are already a bounded, deliberate disclosure and are
// what an operator uses to tell one key from another.

import { pool } from '../src/db/pool.js';
import { tableName } from '../src/schemas/index.js';
import {
  hashApiKey,
  keyPrefixOf,
  isLegacyNamespace,
  translateCredentialNamespace,
} from '../src/lib/apiKeys.js';

const APPLY = process.argv.includes('--apply');

// Marks a row whose credential could not be converted because only its hash
// survives. The API Keys dashboard reads the prefix to surface the same thing.
const ROTATION_FIELD = 'namespace_rotation_required';

const TARGETS = [
  { entity: 'ApiKey', rawField: 'key', hashField: 'key_hash', prefixField: 'key_prefix', label: 'supplier and master keys' },
  { entity: 'BuyerApiKey', rawField: 'key', hashField: null, prefixField: 'key_prefix', label: 'buyer keys' },
];

async function migrateTarget(target) {
  const table = tableName(target.entity);
  const { rows } = await pool.query(
    `SELECT id, data FROM ${table} ORDER BY created_date`,
  );

  const summary = { scanned: rows.length, converted: 0, rotationRequired: 0, alreadyDashflo: 0, noCredential: 0 };

  for (const row of rows) {
    const data = row.data || {};
    const raw = String(data[target.rawField] ?? '').trim();
    const prefix = String(data[target.prefixField] ?? '');
    const hash = target.hashField ? data[target.hashField] : null;

    if (raw && isLegacyNamespace(raw)) {
      const translated = translateCredentialNamespace(raw);
      const patch = { ...data, [target.prefixField]: keyPrefixOf(translated) };
      if (target.hashField) {
        patch[target.hashField] = hashApiKey(translated);
        // The cleartext column is the thing hash-only storage exists to remove.
        // Converting is the right moment to drop it.
        delete patch[target.rawField];
      } else {
        patch[target.rawField] = translated;
      }
      delete patch[ROTATION_FIELD];

      summary.converted += 1;
      console.log(`  convert  ${target.entity} ${row.id}  ${prefix || '(no prefix)'} -> ${keyPrefixOf(translated)}`);
      if (APPLY) {
        await pool.query(`UPDATE ${table} SET data = $2::jsonb, updated_date = now() WHERE id = $1`, [row.id, JSON.stringify(patch)]);
      }
      continue;
    }

    if (!raw && hash && isLegacyNamespace(prefix)) {
      summary.rotationRequired += 1;
      console.log(`  rotate   ${target.entity} ${row.id}  ${prefix}  (hash only, cleartext does not exist, rotate in the UI)`);
      if (APPLY && data[ROTATION_FIELD] !== true) {
        await pool.query(
          `UPDATE ${table} SET data = jsonb_set(data, $2, 'true'::jsonb), updated_date = now() WHERE id = $1`,
          [row.id, `{${ROTATION_FIELD}}`],
        );
      }
      continue;
    }

    if (!raw && !hash) { summary.noCredential += 1; continue; }
    summary.alreadyDashflo += 1;
  }

  return summary;
}

async function main() {
  console.log(APPLY ? 'Applying credential namespace migration' : 'Reporting only. Pass --apply to write changes.');
  console.log('');

  const totals = { scanned: 0, converted: 0, rotationRequired: 0, alreadyDashflo: 0, noCredential: 0 };

  for (const target of TARGETS) {
    console.log(`${target.entity} (${target.label}):`);
    let summary;
    try {
      summary = await migrateTarget(target);
    } catch (error) {
      // A table that does not exist yet is not a failure. The entity is
      // additive and an older deployment may not have it.
      if (error?.code === '42P01') { console.log('  table not present, skipped'); console.log(''); continue; }
      throw error;
    }
    console.log(`  scanned ${summary.scanned}, converted ${summary.converted}, rotation required ${summary.rotationRequired}, already DashFlo ${summary.alreadyDashflo}, no credential ${summary.noCredential}`);
    console.log('');
    for (const key of Object.keys(totals)) totals[key] += summary[key];
  }

  console.log('Totals:', JSON.stringify(totals));
  if (!APPLY && (totals.converted > 0 || totals.rotationRequired > 0)) {
    console.log('Nothing was written. Re-run with --apply.');
  }
  if (totals.rotationRequired > 0) {
    console.log('');
    console.log(`${totals.rotationRequired} credential(s) cannot be converted because only their hash is stored.`);
    console.log('Rotate them in Settings > API Keys. Rotation mints a DashFlo value and shows it once.');
  }
  await pool.end();
}

main().catch(async (error) => {
  console.error('Migration failed:', error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
