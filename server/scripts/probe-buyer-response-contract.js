// ONE controlled, real, outbound synthetic delivery to a buyer's REAL,
// currently-configured SubDelivery endpoint - solely to observe the actual
// response contract (status/result field, remote lead/reference id field,
// reason/message field) so SubDelivery.response_mapping can be configured
// from a real observed response instead of left unset (Stage 4/5 finding:
// with no response_mapping, classifyResponse falls back to pure HTTP-status
// classification, so any 2xx - even an error-shaped body - reads as accepted).
//
// This is NOT a routine capability and must not be run casually or on a
// schedule: every run performs one real, non-simulated HTTP request to
// whatever target_url is currently configured. Explicit operator
// authorization is required for each run (--confirm-live-send), separate
// from --apply on the report/apply scripts elsewhere in this directory.
//
// SYNTHETIC DATA ONLY. The lead data below is the exact same synthetic
// fixture server/scripts/native-delivery-dry-run.js already uses against a
// loopback stand-in (email on the example.test reserved TLD per RFC 2606,
// phone in the 555-01XX range reserved for fictional use, no real name/PII).
// This script must never be pointed at real lead data.
//
// Deliberately bypasses the in-app operator live-test feature
// (server/src/functions/campaignDeliveryTest.js), which refuses to run at
// all while AppSettings.distribution_mode is 'legacy_only' (its own mode
// gate) - exactly the state this probe must NOT change. This script calls
// the same underlying send primitive (deliverDirectPost, with the real SSRF
// guard) directly, entirely outside any RouteGroup/RouteMember/
// distribution_mode/retry-worker state, so it activates nothing.
//
// Records a DistributionAudit entry before sending and a real DeliveryAttempt
// row (trigger: operator_response_contract_probe), the same audit pattern
// campaignDeliveryTest.js uses for an operator-confirmed live test, so this
// one-off action leaves a durable, reviewable record.
//
// Usage (both flags required; neither defaults on):
//   node scripts/probe-buyer-response-contract.js --buyer "Acme Corp" --confirm-live-send

import { ensureSchema } from '../src/db/schema.js';
import { repo } from '../src/db/repo.js';
import { pool } from '../src/db/pool.js';
import * as engine from '../src/functions/routingEngine.generated.js';
import { makeTargetValidator } from '../src/lib/ssrfGuard.js';

const buyerIdx = process.argv.indexOf('--buyer');
const BUYER_NAME = buyerIdx > -1 ? process.argv[buyerIdx + 1] : null;
const CONFIRMED = process.argv.includes('--confirm-live-send');

if (!BUYER_NAME || !CONFIRMED) {
  console.log('[probe-response-contract] Usage: node scripts/probe-buyer-response-contract.js --buyer "<company_name>" --confirm-live-send');
  console.log('[probe-response-contract] Both flags are required. This performs ONE real outbound HTTP request. There is no report-only mode.');
  process.exit(1);
}

const SYNTHETIC_LEAD = {
  first_name: 'Synthetic', last_name: 'ResponseProbe', email: 'synthetic.responseprobe@example.test',
  mobile: '5555550142', accident_state: 'CA', state: 'CA', zip: '90210', vertical: 'MVA',
  type_of_injury: 'Back injury', treatment: 'Yes', attorney: 'No',
  incident_date: '2026-07-01', incident_date_2: '2026-07-01', ip_address: '203.0.113.10',
  sid: 'response-contract-probe', ssid: 'response-contract-probe',
  trustedform_url: 'https://cert.trustedform.com/' + '0'.repeat(40),
};

async function main() {
  await ensureSchema();
  const Buyer = repo('Buyer');
  const Delivery = repo('Delivery');
  const SubDelivery = repo('SubDelivery');
  const DeliveryAttemptRepo = repo('DeliveryAttempt');
  const DistributionAudit = repo('DistributionAudit');

  const buyers = await Buyer.list('-created_date', 1000);
  const buyer = buyers.find((b) => b.company_name === BUYER_NAME);
  if (!buyer) { console.log(`[probe-response-contract] No Buyer found with company_name "${BUYER_NAME}".`); await pool.end(); return; }

  const deliveries = await Delivery.list('-created_date', 1000);
  const buyerDeliveries = deliveries.filter((d) => String(d.buyer_id) === String(buyer.id));
  if (buyerDeliveries.length === 0) { console.log('[probe-response-contract] No Delivery for this buyer.'); await pool.end(); return; }

  const subs = await SubDelivery.list('-created_date', 1000);
  const candidates = subs.filter((s) => buyerDeliveries.some((d) => String(d.id) === String(s.delivery_id))
    && s.active !== false && s.target_url);
  if (candidates.length === 0) { console.log('[probe-response-contract] No active SubDelivery with a target_url for this buyer.'); await pool.end(); return; }
  if (candidates.length > 1) {
    console.log(`[probe-response-contract] ${candidates.length} active SubDeliveries found for this buyer - refusing to guess which one to probe:`);
    for (const c of candidates) console.log(`  ${c.id}  "${c.name}"  ${c.target_url}`);
    await pool.end();
    return;
  }
  const sd = candidates[0];

  console.log(`[probe-response-contract] Buyer:       ${buyer.company_name} (${buyer.id})`);
  console.log(`[probe-response-contract] SubDelivery: "${sd.name}" (${sd.id})`);
  console.log(`[probe-response-contract] Target URL:  ${sd.target_url}`);
  console.log('[probe-response-contract] Sending ONE real, synthetic-data POST now...');
  console.log('');

  const validateTarget = makeTargetValidator();
  const db = { entities: { DeliveryAttempt: DeliveryAttemptRepo } };
  const store = engine.makeEntityAttemptStore(db);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  await DistributionAudit.create({
    action: 'delivery_live_test', entity_type: 'SubDelivery', entity_id: sd.id,
    to_value: sd.target_url || '', reason: 'operator-authorized response-contract probe, synthetic data only, run from probe-buyer-response-contract.js',
    actor_id: 'operator-script:probe-buyer-response-contract', created_at: nowIso,
  });

  const cfg = engine.resolveSubDeliveryCfg(sd);
  const result = await engine.deliverDirectPost(
    {
      ...cfg,
      idempotencyKey: `probe:${sd.id}:${nowMs}`,
      leadId: `SYNTHETIC-PROBE-${nowMs}`,
      leadData: SYNTHETIC_LEAD,
      isPrimary: false,
      trigger: 'operator_response_contract_probe',
    },
    {
      store, nowMs, fetchImpl: globalThis.fetch, testMode: false,
      resolveCredential: async () => ({}), // Walker's own documented header is non-secret; no credential_ref configured
      validateTarget,
    },
  );

  console.log('== RESULT (as classified by the engine, response_mapping currently unset -> HTTP-status fallback) ==');
  console.log(`status:       ${result.status}`);
  console.log(`httpStatus:   ${result.httpStatus}`);
  console.log(`revenue:      ${result.revenue}`);
  console.log(`buyerLeadId:  ${result.buyerLeadId}`);
  console.log(`errorClass:   ${result.errorClass || '(none)'}`);
  console.log(`attemptId:    ${result.attemptId}`);
  console.log('');

  const attempt = await DeliveryAttemptRepo.get(result.attemptId);
  console.log('== RAW RESPONSE (from the persisted DeliveryAttempt record, redacted per buildAttemptRecord) ==');
  console.log('request_meta:', attempt.request_meta);
  console.log('response_meta:', attempt.response_meta);

  await pool.end();
}

main().catch(async (err) => {
  console.error('[probe-response-contract] FAILED:', err.stack || err.message);
  try { await pool.end(); } catch { /* already closed */ }
  process.exit(1);
});
