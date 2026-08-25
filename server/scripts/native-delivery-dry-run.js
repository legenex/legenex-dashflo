// Real-record native delivery dry run. Lead Distribution rebuild Stage 4.
//
// Fetches a buyer's REAL Buyer / Delivery / SubDelivery / RouteGroup /
// RouteMember / Campaign / Vertical records from whatever DATABASE_URL / PG*
// the environment points at, and runs the full generic engine pipeline
// (buildRoutingSnapshot, evaluateMember, deliverDirectPost, classifyResponse,
// the circuit breaker) against them with SYNTHETIC lead data and a MOCK
// loopback transport standing in for the real endpoint. It never contacts a
// real destination host, never writes to the database, and never mutates the
// records it reads.
//
// This is a read-only simulation. To exercise a Delivery/RouteGroup that is
// still draft/inactive (the safe, correct state before a human approves live
// activation - see AGENTS.md section 13), the script builds an IN-MEMORY copy
// with those two fields forced active, purely so buildRoutingSnapshot's own
// activation gate does not itself block the simulation. That override is
// never written back; it is clearly labeled in the report below.
//
// Usage (--buyer is required - this is generic tooling for any buyer, not
// one company's acceptance script):
//   node scripts/native-delivery-dry-run.js --buyer "Acme Corp"
//
// See docs/STATE.md for prior runs this script's own output has backed.

import http from 'node:http';
import { ensureSchema } from '../src/db/schema.js';
import { repo } from '../src/db/repo.js';
import { pool } from '../src/db/pool.js';
import * as engine from '../src/functions/routingEngine.generated.js';

const {
  buildRoutingSnapshot, deliverDirectPost, evaluateMember, classifyResponse,
  toClassifyResponseMapping, makeInMemoryAttemptStore, makeInMemoryHealthStore,
  nextHealth, isBlocked, CIRCUIT, REASON,
} = engine;

const argBuyerIdx = process.argv.indexOf('--buyer');
const BUYER_NAME = argBuyerIdx > -1 ? process.argv[argBuyerIdx + 1] : null;
if (!BUYER_NAME) {
  console.log('[native-delivery-dry-run] Usage: node scripts/native-delivery-dry-run.js --buyer "<company_name>"');
  process.exit(1);
}

const SYNTHETIC_LEAD = {
  first_name: 'Synthetic', last_name: 'DryRun', email: 'synthetic.dryrun@example.test',
  mobile: '5555550100', accident_state: 'CA', state: 'CA', zip: '90210', vertical: 'MVA',
  type_of_injury: 'Back injury', treatment: 'Yes', attorney: 'No',
  incident_date: '2026-07-01', incident_date_2: '2026-07-01', ip_address: '203.0.113.10',
  sid: 'dryrun-sid', ssid: 'dryrun-ssid', trustedform_url: 'https://cert.trustedform.com/' + '0'.repeat(40),
};

function line(s = '') { console.log(s); }
function section(title) { line(''); line(`== ${title} ==`); }

// Local loopback stand-in server. Never the real target_url. scriptRef.current
// controls what the next request receives; the real target_url is only ever
// used for display, never dialed.
function makeStandInServer() {
  const scriptRef = { current: { type: 'accept' } };
  let lastRequest = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastRequest = { headers: req.headers, body };
      const s = scriptRef.current;
      if (s.type === 'accept') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'accepted', revenue: 75, buyer_lead_id: 'DRYRUN-1' }));
      } else if (s.type === 'reject') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'rejected', reason: 'dry run simulated rejection' }));
      } else if (s.type === '5xx') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'simulated upstream failure' }));
      } else if (s.type === 'malformed') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('not json {{{');
      } else if (s.type === 'hang') {
        // never responds; the client-side AbortController times out
      }
    });
  });
  return {
    server, scriptRef,
    get lastRequest() { return lastRequest; },
    async listen() { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; },
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}

async function main() {
  await ensureSchema();

  const [buyers, deliveries, subDeliveries, routeGroups, routeMembers, campaigns, verticals] = await Promise.all([
    repo('Buyer').list('-created_date', 1000),
    repo('Delivery').list('-created_date', 1000),
    repo('SubDelivery').list('-created_date', 1000),
    repo('RouteGroup').list('-created_date', 1000),
    repo('RouteMember').list('-created_date', 1000),
    repo('Campaign').list('-created_date', 1000),
    repo('Vertical').list('-created_date', 1000),
  ]);

  const buyer = buyers.find((b) => b.company_name === BUYER_NAME);
  if (!buyer) { console.log(`[native-delivery-dry-run] No Buyer found with company_name "${BUYER_NAME}".`); await pool.end(); return; }

  const buyerDeliveries = deliveries.filter((d) => String(d.buyer_id) === String(buyer.id));
  const targetDelivery = buyerDeliveries[0] || null;
  if (!targetDelivery) { console.log(`[native-delivery-dry-run] Buyer "${BUYER_NAME}" has no Delivery record.`); await pool.end(); return; }

  const buyerMembers = routeMembers.filter((m) => String(m.buyer_id) === String(buyer.id));
  const targetGroup = buyerMembers.length
    ? routeGroups.find((g) => String(g.id) === String(buyerMembers[0].route_group_id))
    : routeGroups[0];
  const campaign = targetGroup ? campaigns.find((c) => String(c.id) === String(targetGroup.campaign_id)) : null;

  // Prefer the SubDelivery the buyer's own RouteMember actually resolves to
  // in real routing (the canonical pointer) over an arbitrary Delivery-level
  // pick. Falls back to the first ACTIVE, target_url-configured SubDelivery
  // under the Delivery only when no RouteMember mapping exists yet - never to
  // an inactive/archived one, which -created_date ordering could otherwise
  // silently prefer over an older but still-active row (found while running
  // this against Walker's real, now-normalized-to-one-canonical-tier data:
  // the newer of two SubDeliveries was the one archived as a duplicate, and
  // an active-blind pick chose it anyway).
  const mappedMember = buyerMembers.find((m) => m.sub_delivery_id);
  const mappedSub = mappedMember ? subDeliveries.find((s) => String(s.id) === String(mappedMember.sub_delivery_id)) : null;
  const activeDeliverySubs = subDeliveries.filter((s) => String(s.delivery_id) === String(targetDelivery.id) && s.target_url && s.active !== false);
  const targetSub = (mappedSub && mappedSub.target_url && mappedSub.active !== false) ? mappedSub : activeDeliverySubs[0];
  if (!targetSub) {
    console.log(`[native-delivery-dry-run] Delivery "${targetDelivery.name}" has no ACTIVE SubDelivery with a target_url configured. Nothing to simulate.`);
    await pool.end();
    return;
  }

  section('REAL RECORDS RESOLVED (read-only, nothing written)');
  line(`Buyer:        ${buyer.company_name} (${buyer.id}), buyer_code=${buyer.buyer_code || '-'}, active=${buyer.active}, status=${buyer.status}`);
  line(`Delivery:     "${targetDelivery.name}" (${targetDelivery.id}), status=${targetDelivery.status}, vertical_id=${targetDelivery.vertical_id || '-'}`);
  line(`SubDelivery:  "${targetSub.name}" (${targetSub.id}), active=${targetSub.active}, target_url=${targetSub.target_url}`);
  line(`  payload_template: ${targetSub.payload_template ? `${targetSub.payload_template.length} chars, real persisted value` : '(none configured)'}`);
  line(`  response_mapping: ${targetSub.response_mapping ? targetSub.response_mapping : '(none configured - engine falls back to generic HTTP-status classification)'}`);
  line(`  credential_ref:   ${targetSub.credential_ref || '(none - no credential required by this endpoint\'s documented headers)'}`);
  if (targetGroup) {
    const rm = buyerMembers.find((m) => String(m.route_group_id) === String(targetGroup.id)) || buyerMembers[0];
    line(`RouteGroup:   "${targetGroup.name}" (${targetGroup.id}), active=${targetGroup.active}, lifecycle=${targetGroup.lifecycle}`);
    if (rm) {
      line(`RouteMember:  ${rm.id}, active=${rm.active}, filters=${rm.filters || '(none)'}, schedule=${rm.schedule || '(none)'}, caps=${rm.caps || '(none)'}`);
    } else {
      line('RouteMember:  none exists for this buyer under this group.');
    }
    line(`Campaign:     ${campaign ? `"${campaign.name}" (${campaign.id}), vertical=${campaign.vertical}` : '(not resolved)'}`);
  } else {
    line('RouteGroup:   none exists for this buyer.');
  }

  const standIn = makeStandInServer();
  const baseUrl = await standIn.listen();

  section('IN-MEMORY SIMULATION OVERRIDES (never written to the database)');
  line(`- RouteGroup.active/lifecycle forced true in this process's memory only, so buildRoutingSnapshot's`);
  line('  own activation gate does not block the simulation. The real row stays exactly as read above.');
  line(`- Delivery.status forced "active" in this process's memory only, for the same reason.`);
  line(`- target_url swapped for a local loopback stand-in (${baseUrl}) for every send scenario below.`);
  line('  The real target_url is never dialed by this script.');

  const simGroupId = 'sim-group';
  const simMemberId = 'sim-member';
  const fixtureBuyer = { ...buyer, id: buyer.id };
  const fixtureDelivery = { ...targetDelivery, status: 'active' };
  const fixtureSub = { ...targetSub, target_url: `${baseUrl}/dry-run` };
  const fixtureGroup = { id: simGroupId, campaign_id: targetGroup ? targetGroup.campaign_id : 'sim-campaign', name: 'dry-run', method: 'priority', order_index: 0, active: true, lifecycle: 'active' };
  const existingMember = targetGroup ? buyerMembers.find((m) => String(m.route_group_id) === String(targetGroup.id)) : null;
  const fixtureMember = {
    ...(existingMember || {}),
    id: simMemberId, route_group_id: simGroupId, buyer_id: buyer.id, sub_delivery_id: fixtureSub.id,
    active: true, priority: (existingMember && existingMember.priority) || 1,
    price_mode: (existingMember && existingMember.price_mode) || 'fixed', fixed_price: (existingMember && existingMember.fixed_price) ?? 0,
  };

  function fixtures() {
    return {
      groups: [fixtureGroup], members: [fixtureMember], buyers: [fixtureBuyer], destinations: [],
      deliveries: [fixtureDelivery], subDeliveries: [fixtureSub], health: [],
    };
  }

  const NOW = Date.now();
  const snap = buildRoutingSnapshot(fixtures(), { campaignId: fixtureGroup.campaign_id, nowMs: NOW, capCountsFor: () => 0 });
  section('SNAPSHOT RESOLUTION');
  if (snap.configErrors.length) {
    line(`configErrors: ${JSON.stringify(snap.configErrors)}`);
    line('Cannot proceed with send scenarios: snapshot resolution failed even with the in-memory overrides applied.');
    await standIn.close();
    await pool.end();
    return;
  }
  const resolvedMember = snap.groups[0].members.find((m) => m.id === simMemberId);
  line(`Resolved subDeliveryId: ${resolvedMember.subDeliveryId}`);
  line(`Resolved endpoint (stand-in): ${resolvedMember.delivery.targetUrl}`);
  line(`Resolved real endpoint (never dialed): ${targetSub.target_url}`);

  async function sendScenario(label, scriptType, overrides = {}) {
    standIn.scriptRef.current = { type: scriptType };
    const store = makeInMemoryAttemptStore();
    const result = await deliverDirectPost({
      ...resolvedMember.delivery, ...overrides,
      idempotencyKey: `dry-run:${label}:${Math.random()}`,
      leadId: 'L-DRYRUN', leadData: SYNTHETIC_LEAD, isPrimary: true, trigger: 'primary',
    }, { store, nowMs: NOW, testMode: true, allowlistHosts: ['127.0.0.1'], fetchImpl: globalThis.fetch });
    line(`${label.padEnd(28)} -> status=${result.status}  revenue=${result.revenue ?? '-'}  buyerLeadId=${result.buyerLeadId ?? '-'}  errorClass=${result.errorClass ?? '-'}`);
    return result;
  }

  section('SEND SCENARIOS (real payload_template + response evaluator, mock loopback transport)');
  await sendScenario('accepted', 'accept');
  await sendScenario('rejected', 'reject');
  await sendScenario('5xx retryable', '5xx');
  await sendScenario('malformed response', 'malformed');
  await sendScenario('timeout', 'hang', { timeoutMs: 200 });
  await sendScenario('invalid payload template', 'accept', { payloadTemplate: '{not valid json' });

  const disabledSnap = buildRoutingSnapshot({ ...fixtures(), subDeliveries: [{ ...fixtureSub, active: false }] }, { campaignId: fixtureGroup.campaign_id, nowMs: NOW, capCountsFor: () => 0 });
  line(`disabled SubDelivery (config-level) -> configErrors: ${JSON.stringify(disabledSnap.configErrors.map((e) => e.code))}`);

  const crossBuyerSnap = buildRoutingSnapshot({ ...fixtures(), deliveries: [{ ...fixtureDelivery, buyer_id: 'someone-else' }] }, { campaignId: fixtureGroup.campaign_id, nowMs: NOW, capCountsFor: () => 0 });
  line(`ownership mismatch (cross-buyer SubDelivery) -> configErrors: ${JSON.stringify(crossBuyerSnap.configErrors.map((e) => e.code))}`);

  section('ELIGIBILITY (evaluateMember, using the REAL RouteMember filters/schedule/caps as configured today)');
  const realFilters = existingMember ? existingMember.filters : null;
  const realSchedule = existingMember ? existingMember.schedule : null;
  const realCaps = existingMember ? existingMember.caps : null;
  line(`Real filters:  ${realFilters || '(unset - no state/vertical restriction configured)'}`);
  line(`Real schedule: ${realSchedule || '(unset - always within schedule)'}`);
  line(`Real caps:     ${realCaps || '(unset - never cap-blocked)'}`);
  const eligVerdict = evaluateMember(resolvedMember, SYNTHETIC_LEAD, { nowMs: NOW });
  line(`evaluateMember(synthetic CA lead) -> eligible=${eligVerdict.eligible}  reason=${eligVerdict.reason || REASON.ELIGIBLE}`);
  if (!realFilters) line('  (no state filter configured in production today, so a lead from ANY state is currently treated as eligible by this gate)');
  const ineligibleLead = { ...SYNTHETIC_LEAD, accident_state: 'ZZ', state: 'ZZ' };
  const eligVerdict2 = evaluateMember(resolvedMember, ineligibleLead, { nowMs: NOW });
  line(`evaluateMember(synthetic ZZ-state lead) -> eligible=${eligVerdict2.eligible}  reason=${eligVerdict2.reason || REASON.ELIGIBLE}`);
  line('(state/schedule/cap gate REJECTION itself is covered against non-null fixture values by');
  line(' client/src/lib/distribution/walkerNativeDryRun.test.js and genericDestinationDryRun.test.js -');
  line(' production currently configures none of these three for this buyer, so there is nothing real to reject against.)');

  section('CIRCUIT BREAKER (in-memory store only - no DestinationHealth row written)');
  const healthStore = makeInMemoryHealthStore();
  const key = { subDeliveryId: fixtureSub.id };
  let h = null;
  for (let i = 1; i <= 5; i += 1) {
    h = await healthStore.recordResult(key, false, NOW + i * 1000);
  }
  line(`After 5 consecutive failures: state=${h.state} (expect ${CIRCUIT.OPEN})`);
  line(`isBlocked immediately after opening: ${isBlocked(h, NOW + 5000)} (expect true)`);
  const afterCooldown = NOW + 5000 + (h.disabled_until ? (Date.parse(h.disabled_until) - (NOW + 5000)) + 1000 : 60 * 60 * 1000);
  line(`isBlocked after cooldown elapses: ${isBlocked(h, afterCooldown)} (expect false - half-open trial allowed)`);
  const recovered = await healthStore.recordResult(key, true, afterCooldown);
  line(`After one success post-cooldown: state=${recovered.state} (expect ${CIRCUIT.CLOSED})`);

  await standIn.close();
  await pool.end();
  section('DONE');
  line('No database writes occurred. No real destination host was contacted.');
}

main().catch(async (err) => {
  console.error('[native-delivery-dry-run] FAILED:', err.stack || err.message);
  try { await pool.end(); } catch { /* already closed */ }
  process.exit(1);
});
