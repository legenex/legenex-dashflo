// Backfill ApiKey.key_hash from the legacy cleartext ApiKey.key. Task S4.
//
// Usage:
//   node scripts/backfill-api-key-hashes.js            report only, writes nothing
//   node scripts/backfill-api-key-hashes.js --apply    write the missing hashes
//
// Properties this script is required to have:
//
//   idempotent   running it twice changes nothing the second time, because a
//                row that already has a matching key_hash is skipped
//   restartable  it processes row by row and holds no cross-row state, so an
//                interrupted run is resumed simply by running it again
//   additive     it only ever writes key_hash. It never deletes the cleartext
//                key. Purging cleartext is a separate, later step that must not
//                happen until the hash path has been observed carrying real
//                supplier traffic. See STATE.md, task S4.
//
// A row that carries neither a cleartext key nor a hash is reported as
// unrecoverable rather than skipped silently: it is a key that can no longer
// authenticate anyone and has to be rotated.

import { ensureSchema } from '../src/db/schema.js';
import { pool } from '../src/db/pool.js';
import { repo } from '../src/db/repo.js';
import { hashApiKey } from '../src/lib/apiKeys.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  await ensureSchema();
  const ApiKey = repo('ApiKey');

  // Page through rather than loading the whole table, so this stays usable if
  // the key count grows.
  const PAGE = 200;
  let offset = 0;

  const counts = {
    scanned: 0,
    already_hashed: 0,
    hashed_now: 0,
    would_hash: 0,
    mismatch_repaired: 0,
    unrecoverable: 0,
  };
  const unrecoverable = [];

  for (;;) {
    const rows = await ApiKey.list('-created_date', PAGE, offset);
    if (!rows.length) break;

    for (const row of rows) {
      counts.scanned += 1;
      const cleartext = typeof row.key === 'string' ? row.key.trim() : '';
      const storedHash = typeof row.key_hash === 'string' ? row.key_hash.trim() : '';

      if (!cleartext && !storedHash) {
        counts.unrecoverable += 1;
        unrecoverable.push({ id: row.id, name: row.name, key_prefix: row.key_prefix });
        continue;
      }

      if (!cleartext) {
        counts.already_hashed += 1;
        continue;
      }

      const expected = hashApiKey(cleartext);

      if (storedHash === expected) {
        counts.already_hashed += 1;
        continue;
      }

      if (storedHash && storedHash !== expected) {
        // The stored hash does not match the stored cleartext. The cleartext is
        // the value a supplier is actually posting today, so it wins.
        if (APPLY) await ApiKey.update(row.id, { key_hash: expected });
        counts.mismatch_repaired += 1;
        continue;
      }

      if (APPLY) {
        await ApiKey.update(row.id, { key_hash: expected });
        counts.hashed_now += 1;
      } else {
        counts.would_hash += 1;
      }
    }

    offset += rows.length;
    if (rows.length < PAGE) break;
  }

  console.log(`[backfill-api-key-hashes] mode: ${APPLY ? 'APPLY' : 'REPORT ONLY'}`);
  console.log(`  scanned            ${counts.scanned}`);
  console.log(`  already hashed     ${counts.already_hashed}`);
  if (APPLY) {
    console.log(`  hashed now         ${counts.hashed_now}`);
    console.log(`  mismatch repaired  ${counts.mismatch_repaired}`);
  } else {
    console.log(`  would hash         ${counts.would_hash}`);
    console.log(`  mismatch to repair ${counts.mismatch_repaired}`);
  }
  console.log(`  unrecoverable      ${counts.unrecoverable}`);

  if (unrecoverable.length) {
    console.log('');
    console.log('  These rows have neither a cleartext key nor a hash. They cannot');
    console.log('  authenticate anyone and must be rotated through issueApiKey:');
    for (const row of unrecoverable) {
      console.log(`    ${row.id}  ${row.key_prefix || '(no prefix)'}  ${row.name || '(unnamed)'}`);
    }
  }

  if (!APPLY && (counts.would_hash || counts.mismatch_repaired)) {
    console.log('');
    console.log('  Re-run with --apply to write these hashes.');
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('[backfill-api-key-hashes] FAILED:', err.message);
  try { await pool.end(); } catch { /* already closed */ }
  process.exit(1);
});
