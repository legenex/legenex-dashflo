// Generic setter for SubDelivery.response_mapping, the persisted shape
// deliveryAttempt.js's toClassifyResponseMapping reads: accepted/rejected/
// duplicate/queued (regex pattern strings matched against the response body),
// revenue/buyer_lead_id (dot-paths into the parsed JSON response),
// require_accept (boolean). This script contains no buyer-specific logic; the
// mapping itself is supplied by the caller as data, derived from a real
// observed response (see probe-buyer-response-contract.js) - never invented.
//
// Usage:
//   node scripts/set-subdelivery-response-mapping.js --sub-delivery-id <id> --mapping '<json>'              report only
//   node scripts/set-subdelivery-response-mapping.js --sub-delivery-id <id> --mapping '<json>' --apply       write it

import { ensureSchema } from '../src/db/schema.js';
import { repo } from '../src/db/repo.js';
import { pool } from '../src/db/pool.js';

const APPLY = process.argv.includes('--apply');
const idIdx = process.argv.indexOf('--sub-delivery-id');
const SUB_DELIVERY_ID = idIdx > -1 ? process.argv[idIdx + 1] : null;
const mappingIdx = process.argv.indexOf('--mapping');
const MAPPING_RAW = mappingIdx > -1 ? process.argv[mappingIdx + 1] : null;

const KNOWN_KEYS = ['accepted', 'rejected', 'duplicate', 'queued', 'revenue', 'buyer_lead_id', 'require_accept'];

if (!SUB_DELIVERY_ID || !MAPPING_RAW) {
  console.log('[set-response-mapping] Usage: node scripts/set-subdelivery-response-mapping.js --sub-delivery-id <id> --mapping \'<json>\' [--apply]');
  process.exit(1);
}

let mapping;
try { mapping = JSON.parse(MAPPING_RAW); } catch (e) {
  console.log(`[set-response-mapping] --mapping is not valid JSON: ${e.message}`);
  process.exit(1);
}
if (mapping == null || typeof mapping !== 'object' || Array.isArray(mapping)) {
  console.log('[set-response-mapping] --mapping must be a JSON object.');
  process.exit(1);
}
const unknown = Object.keys(mapping).filter((k) => !KNOWN_KEYS.includes(k));
if (unknown.length) {
  console.log(`[set-response-mapping] Unknown key(s) in --mapping: ${unknown.join(', ')}. Known keys: ${KNOWN_KEYS.join(', ')}.`);
  process.exit(1);
}

async function main() {
  await ensureSchema();
  const SubDelivery = repo('SubDelivery');
  const sd = await SubDelivery.get(SUB_DELIVERY_ID);
  if (!sd) { console.log(`[set-response-mapping] SubDelivery ${SUB_DELIVERY_ID} not found.`); await pool.end(); return; }

  console.log(`[set-response-mapping] SubDelivery "${sd.name}" (${sd.id})`);
  console.log(`  current response_mapping:  ${sd.response_mapping || '(unset)'}`);
  console.log(`  proposed response_mapping: ${JSON.stringify(mapping)}`);

  if (APPLY) {
    await SubDelivery.update(sd.id, { response_mapping: JSON.stringify(mapping) });
    console.log('  APPLIED.');
  } else {
    console.log('\n[set-response-mapping] Report only. Re-run with --apply to write.');
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('[set-response-mapping] FAILED:', err.message);
  try { await pool.end(); } catch { /* already closed */ }
  process.exit(1);
});
