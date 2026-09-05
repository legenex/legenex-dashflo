import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/* W1-FLAGS: derived money flags and backfill (forge-pack/CONTRACT.md D2).
 *
 * This proves five things against a real, disposable Postgres database (the
 * same pattern server/test/migrationBuyerIdentity.test.js uses), not mocks,
 * because the load-bearing guarantee here - write-once - is partly enforced
 * by a database trigger (server/src/db/schema.js) and cannot be proven
 * against an in-memory stand-in:
 *
 *   1. computeLeadFlags derives is_sold/sold_at/sale_price_effective/
 *      is_returned/returned_at/is_converted/converted_at/conversion_type
 *      correctly from a REALISTIC synthetic dataset covering every
 *      final_status this pre-W2-STATUS schema supports, plus both approved
 *      and not-yet-approved ReturnRequest shapes.
 *   2. backfillLeadFlags is idempotent (a second run writes nothing) and
 *      additive (it only ever adds these eight keys).
 *   3. The flags are write-once against every mutation path this task asks
 *      for evidence on: a direct Lead.update() clearing the flag, a
 *      simulated later status change, a re-run of the backfill, a simulated
 *      outcome webhook, and a raw SQL UPDATE that never goes through this
 *      module or Repo at all.
 *   4. Reconciliation, against the REAL figures this actually matters for:
 *      summing sale_price_effective where is_sold and not is_returned
 *      reproduces, to the cent, the revenue partnerMetrics.js's buyerMetrics
 *      and reportMetrics.js's booked_revenue already report for currently-
 *      Sold leads (both use a plain final_status === 'Sold' filter) - and,
 *      separately, PROVES the exact D2 drift (a converted lead silently
 *      dropping out of that Sold-only filter) for those two figures
 *      specifically. It does NOT claim to protect the primary Overview/
 *      Reports headline revenue (overviewFinance.js ~line 45,
 *      reportMetrics.js's primary `revenue` accumulator ~line 294): both sum
 *      every lead's revenue in the filtered set with no final_status check
 *      at all, so they already include Converted/Returned leads' revenue and
 *      were never actually vulnerable to this drift. A separate test only
 *      confirms flags-based revenue stays a consistent, superset-safe figure
 *      alongside that always-inclusive calculation, not that the
 *      calculation needed protecting.
 *   5. precedence_unverified: backfillLeadFlags surfaces (without changing
 *      is_sold for) every Converted/Returned lead this backfill cannot
 *      independently verify was ever actually Sold, because two live write
 *      paths - webhook.js's create/update branches and leadbyteWebhook.js's
 *      create branch - can set final_status straight to Converted/Returned
 *      with no precedence guard at all.
 *
 * What this does NOT prove: the acceptance step in
 * forge-pack/03-plan/WORK-UNITS.yaml calls for this reconciliation "on a
 * restored copy of production." No such restored copy is available in this
 * worktree (that is Odin's/infrastructure's territory), so this is a
 * synthetic reconciliation at production-realistic scale and coverage, not
 * a live-data one. See the final report for that gap; it stays open as a
 * follow-up drill before this unit is fully done end to end.
 */

const TEST_DB = 'dashflo_lead_flags_test';
const MAINTENANCE_DB = 'postgres';
const PGHOST = process.env.PGHOST || '127.0.0.1';
const PGPORT = process.env.PGPORT_TEST || '5433';
const PGUSER = process.env.PGUSER || process.env.USER || 'postgres';

process.env.PGHOST = PGHOST;
process.env.PGPORT = PGPORT;
process.env.PGUSER = PGUSER;
process.env.PGDATABASE = TEST_DB;
delete process.env.DATABASE_URL;

const pg = (await import('pg')).default;

async function canReachPostgres() {
  const client = new pg.Client({ host: PGHOST, port: Number(PGPORT), user: PGUSER, database: MAINTENANCE_DB });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}
const reachable = await canReachPostgres();

async function maintenance(sql) {
  const client = new pg.Client({ host: PGHOST, port: Number(PGPORT), user: PGUSER, database: MAINTENANCE_DB });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

describe.skipIf(!reachable)('W1-FLAGS: derived money flags', () => {
  let pool;
  let db;
  let computeLeadFlags;
  let leadFlagsPatch;
  let backfillLeadFlags;
  let revenueFromFlags;
  let LEAD_FLAG_FIELDS;

  beforeAll(async () => {
    await maintenance(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await maintenance(`CREATE DATABASE ${TEST_DB}`);
    ({ pool } = await import('../src/db/pool.js'));
    const schema = await import('../src/db/schema.js');
    await schema.ensureSchema();
    const { entitiesNamespace } = await import('../src/db/repo.js');
    db = { entities: entitiesNamespace() };
    ({ computeLeadFlags, leadFlagsPatch, backfillLeadFlags, revenueFromFlags, LEAD_FLAG_FIELDS } =
      await import('../src/lib/leadFlags.js'));
  });

  afterAll(async () => {
    await pool?.end?.().catch(() => {});
    if (reachable) {
      await maintenance(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB}' AND pid <> pg_backend_pid()`);
      await maintenance(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    }
  });

  beforeEach(async () => {
    const { rows } = await pool.query(`
      SELECT relname AS table_name FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND relname LIKE 'e\\_%'`);
    for (const row of rows) await pool.query(`TRUNCATE ${row.table_name}`);
  });

  // ── The synthetic dataset ──────────────────────────────────────────────
  //
  // One lead per final_status this pre-W2-STATUS schema supports, plus every
  // sold/returned/converted transition combination the acceptance criteria
  // name explicitly: plain sold, sold-then-returned (both return signals
  // this system has), sold-then-converted, disqualified, rejected including
  // a DNC-style rejection, unsold/no-buyer, duplicate, and the legacy
  // Error/Fake/Qualified/Queued/Processing states D4 will retire later.
  const baseLead = (overrides) => ({
    supplier_name: 'Synthetic Supplier',
    lead_id: Math.floor(Math.random() * 1e9),
    processed_at: '2026-08-01T12:00:00.000Z',
    created_date: '2026-08-01T12:00:00.000Z',
    ...overrides,
  });

  async function seedLead(overrides) {
    return db.entities.Lead.create(baseLead(overrides));
  }

  it('computes every flag correctly across a realistic synthetic dataset covering every status and transition', async () => {
    const plainSold = await seedLead({ final_status: 'Sold', revenue: 250 });
    const soldThenReturnedByStatus = await seedLead({
      final_status: 'Returned', revenue: 300, buyer_returned: true, buyer_return_reason: 'Bad number',
      leadbyte_outcome_at: '2026-08-05T09:00:00.000Z',
    });
    const soldThenReturnedByApprovedRequest = await seedLead({ final_status: 'Sold', revenue: 275 });
    const soldWithPendingReturn = await seedLead({ final_status: 'Sold', revenue: 260 });
    const soldWithRejectedReturn = await seedLead({ final_status: 'Sold', revenue: 240 });
    const soldThenConverted = await seedLead({
      final_status: 'Converted', revenue: 400, buyer_conversion: 'Signed',
      leadbyte_outcome_at: '2026-08-10T09:00:00.000Z',
    });
    const soldConvertedNoDisposition = await seedLead({ final_status: 'Converted', revenue: 220 });
    const soldUnknownRevenue = await seedLead({ final_status: 'Sold', revenue_source: 'unknown' });
    const disqualified = await seedLead({ final_status: 'Disqualified' });
    const rejected = await seedLead({ final_status: 'Rejected' });
    const rejectedDnc = await seedLead({
      final_status: 'Rejected',
      queue_reason: 'Global DNC suppression',
      mapped_fields: JSON.stringify({ dnc_suppressed: 'true' }),
    });
    const unsold = await seedLead({ final_status: 'Unsold' });
    const duplicate = await seedLead({ final_status: 'Duplicate', archived: true });
    const errorLegacy = await seedLead({ final_status: 'Error' });
    const fakeLegacy = await seedLead({ final_status: 'Fake' });
    const qualifiedLegacy = await seedLead({ final_status: 'Qualified' });
    const queued = await seedLead({ final_status: 'Queued' });
    const processing = await seedLead({ final_status: 'Processing' });

    await db.entities.ReturnRequest.create({
      lead_id: soldThenReturnedByApprovedRequest.id, buyer_id: 'buyer-1', reason: 'Duplicate contact',
      status: 'approved', resolved_date: '2026-08-06T00:00:00.000Z',
    });
    await db.entities.ReturnRequest.create({
      lead_id: soldWithPendingReturn.id, buyer_id: 'buyer-1', reason: 'Investigating', status: 'requested',
    });
    await db.entities.ReturnRequest.create({
      lead_id: soldWithRejectedReturn.id, buyer_id: 'buyer-1', reason: 'Buyer says bad lead', status: 'rejected',
    });

    const { counts, exceptions } = await backfillLeadFlags(db);

    expect(counts.total).toBe(18);
    // Ever-sold: plainSold, both returned variants, both pending/rejected-return
    // sold leads (a request that never got approved does not undo the sale),
    // both converted variants, and the unknown-revenue sale = 8.
    expect(counts.sold).toBe(8);
    expect(counts.returned).toBe(2); // status-driven + approved-request-driven
    expect(counts.converted).toBe(2);
    expect(counts.sold_unknown_price).toBe(1);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({ lead_id: soldUnknownRevenue.id, reason: 'sold_with_unknown_price' });

    const reload = async (lead) => db.entities.Lead.get(lead.id);

    // Plain sold: is_sold true, price locked at 250, nothing else set.
    const r1 = await reload(plainSold);
    expect(r1).toMatchObject({ is_sold: true, sale_price_effective: 250, is_returned: false, is_converted: false });
    expect(r1.sold_at).toBeTruthy();
    expect(r1.returned_at).toBeFalsy();

    // Sold then returned by the inline webhook signal: is_sold stays true,
    // ORIGINAL price preserved, is_returned true with a returned_at.
    const r2 = await reload(soldThenReturnedByStatus);
    expect(r2).toMatchObject({ is_sold: true, sale_price_effective: 300, is_returned: true });
    expect(r2.returned_at).toBe('2026-08-05T09:00:00.000Z');

    // Sold then returned by the FORMAL approved ReturnRequest, with
    // final_status never leaving 'Sold' - the exact case generateBillingRun.js
    // already relies on for its own returns exclusion, now surfaced as a flag.
    const r3 = await reload(soldThenReturnedByApprovedRequest);
    expect(r3).toMatchObject({ is_sold: true, sale_price_effective: 275, is_returned: true });
    expect(r3.returned_at).toBe('2026-08-06T00:00:00.000Z');

    // A REQUESTED (not yet approved) return must not mark the lead returned.
    const r4 = await reload(soldWithPendingReturn);
    expect(r4).toMatchObject({ is_sold: true, sale_price_effective: 260, is_returned: false });

    // A REJECTED return request must not mark the lead returned either.
    const r5 = await reload(soldWithRejectedReturn);
    expect(r5).toMatchObject({ is_sold: true, sale_price_effective: 240, is_returned: false });

    // Sold then converted: is_sold stays true, ORIGINAL price preserved,
    // is_converted true, conversion_type taken from buyer_conversion.
    const r6 = await reload(soldThenConverted);
    expect(r6).toMatchObject({
      is_sold: true, sale_price_effective: 400, is_returned: false,
      is_converted: true, conversion_type: 'Signed',
    });
    expect(r6.converted_at).toBe('2026-08-10T09:00:00.000Z');

    // Converted with no buyer_conversion detail falls back to a generic marker
    // rather than leaving conversion_type unset.
    const r7 = await reload(soldConvertedNoDisposition);
    expect(r7).toMatchObject({ is_converted: true, conversion_type: 'converted', sale_price_effective: 220 });

    // Sold but revenue was never captured (revenue_source: unknown): is_sold
    // true, sale_price_effective explicitly null, never a silent zero.
    const r8 = await reload(soldUnknownRevenue);
    expect(r8.is_sold).toBe(true);
    expect(r8.sale_price_effective).toBeFalsy();

    // Every non-sold status: no flag ever turns on.
    for (const lead of [
      disqualified, rejected, rejectedDnc, unsold, duplicate,
      errorLegacy, fakeLegacy, qualifiedLegacy, queued, processing,
    ]) {
      const reloaded = await reload(lead);
      for (const field of LEAD_FLAG_FIELDS) {
        expect(reloaded[field], `${field} on ${reloaded.final_status}`).toBeFalsy();
      }
    }
  });

  it('is idempotent: a second backfill run over the same data writes nothing and changes nothing', async () => {
    const sold = await seedLead({ final_status: 'Sold', revenue: 500 });
    await seedLead({ final_status: 'Rejected' });

    const first = await backfillLeadFlags(db);
    // Only the Sold lead has anything meaningful to write; the Rejected lead
    // is not_applicable (never sold), not "already flagged".
    expect(first.counts.newly_flagged).toBe(1);
    expect(first.counts.not_applicable).toBe(1);

    const before = await db.entities.Lead.get(sold.id);

    const second = await backfillLeadFlags(db);
    expect(second.counts.newly_flagged).toBe(0);
    expect(second.counts.already_flagged).toBe(1);
    expect(second.counts.not_applicable).toBe(1);

    const after = await db.entities.Lead.get(sold.id);
    expect(after).toMatchObject({
      is_sold: before.is_sold,
      sold_at: before.sold_at,
      sale_price_effective: before.sale_price_effective,
    });
  });

  it('leadFlagsPatch never includes an already-set flag, even when the freshly computed value disagrees', () => {
    const stored = { final_status: 'Disqualified', is_sold: true, sold_at: '2026-08-01T00:00:00.000Z', sale_price_effective: 250 };
    // A hostile/naive recompute from the CURRENT (mutated) final_status would
    // say this lead was never sold. The patch builder must not let that
    // recomputed falsehood anywhere near an already-set flag.
    const recomputed = computeLeadFlags(stored);
    expect(recomputed.is_sold).toBe(false); // proves the recompute really would regress it if applied blindly
    const patch = leadFlagsPatch(stored, recomputed);
    expect(patch).toBeNull();
  });

  // ── precedence_unverified: the QA-found gap in the Sold-before-Converted/
  // Returned assumption ───────────────────────────────────────────────────
  //
  // computeLeadFlags/backfillLeadFlags treat final_status Converted/Returned
  // as proof a lead was ever Sold (forge-pack/CONTRACT.md D1: both states are
  // defined as reachable only from a prior Sold). But webhook.js's create
  // (~line 604) and update (~line 505) branches, and leadbyteWebhook.js's
  // create branch, set final_status directly with no precedence guard at
  // all - only leadbyteWebhook.js's existing-lead update branch guards it.
  // So a lead can reach Converted/Returned today without ever having been
  // Sold, and because is_sold is permanently immutable, a backfill would
  // otherwise lock in a wrong is_sold=true forever with no way to notice.
  // These tests prove the new precedence_unverified exception surfaces
  // exactly the leads this backfill cannot independently verify, and only
  // those leads.
  describe('precedence_unverified: surfaces Converted/Returned leads with no corroborating sale evidence', () => {
    it('fires for a Converted lead with no corroborating positive revenue value', async () => {
      const uncorroborated = await seedLead({ final_status: 'Converted' });

      const { counts, exceptions } = await backfillLeadFlags(db);

      expect(counts.precedence_unverified).toBe(1);
      // This lead also has no revenue at all, so it separately trips
      // sold_with_unknown_price too (a different, legitimate finding about
      // price, not precedence) - find the specific exception by reason so
      // that unrelated exception doesn't mask the assertion below.
      const found = exceptions.find((e) => e.lead_id === uncorroborated.id && e.reason === 'precedence_unverified');
      expect(found).toMatchObject({ lead_id: uncorroborated.id, reason: 'precedence_unverified' });

      // is_sold is still set true (this backfill's ever-sold definition is
      // unchanged) - the exception exists to surface the risk, not to alter
      // the flag value, which would require redesigning the whole premise.
      const reloaded = await db.entities.Lead.get(uncorroborated.id);
      expect(reloaded.is_sold).toBe(true);
    });

    it('fires for a Returned lead with no corroborating positive revenue value', async () => {
      const uncorroborated = await seedLead({ final_status: 'Returned' });

      const { counts, exceptions } = await backfillLeadFlags(db);

      expect(counts.precedence_unverified).toBe(1);
      expect(exceptions.find((e) => e.lead_id === uncorroborated.id && e.reason === 'precedence_unverified')).toMatchObject({
        lead_id: uncorroborated.id, reason: 'precedence_unverified',
      });
    });

    it('does NOT fire for a Converted lead that DOES carry a corroborating positive revenue value', async () => {
      const corroborated = await seedLead({ final_status: 'Converted', revenue: 300 });

      const { counts, exceptions } = await backfillLeadFlags(db);

      expect(counts.precedence_unverified).toBe(0);
      expect(exceptions.find((e) => e.lead_id === corroborated.id)).toBeUndefined();
    });

    it('does NOT fire for a plain Sold lead, which has no precedence ambiguity at all', async () => {
      const sold = await seedLead({ final_status: 'Sold' }); // no revenue on purpose

      const { counts, exceptions } = await backfillLeadFlags(db);

      // Sold is the direct sale signal itself, not an inference from a later
      // status - there is nothing to verify precedence against, so it must
      // never be swept into this exception even though it also has no
      // revenue captured (that gap is sold_unknown_price's job, not this
      // one, and this lead legitimately trips that other exception too -
      // asserted on the reason, not just the lead_id, so that doesn't mask
      // this assertion).
      expect(counts.precedence_unverified).toBe(0);
      expect(exceptions.find((e) => e.lead_id === sold.id && e.reason === 'precedence_unverified')).toBeUndefined();
      expect(exceptions.find((e) => e.lead_id === sold.id && e.reason === 'sold_with_unknown_price')).toBeTruthy();
    });
  });

  // ── Write-once: every mutation path named in the acceptance criteria ────
  describe('write-once: is_sold and sale_price_effective survive every mutation path tried', () => {
    let leadId;

    beforeEach(async () => {
      const lead = await seedLead({ final_status: 'Sold', revenue: 777 });
      await backfillLeadFlags(db);
      leadId = lead.id;
      const flagged = await db.entities.Lead.get(leadId);
      expect(flagged.is_sold).toBe(true);
      expect(flagged.sale_price_effective).toBe(777);
    });

    it('path 1: a direct Lead.update() attempting to clear is_sold back to false is rejected by the database', async () => {
      await db.entities.Lead.update(leadId, { is_sold: false });
      const after = await db.entities.Lead.get(leadId);
      expect(after.is_sold).toBe(true);
    });

    it('path 2: a direct Lead.update() attempting to change sale_price_effective is rejected by the database', async () => {
      await db.entities.Lead.update(leadId, { sale_price_effective: 999999 });
      const after = await db.entities.Lead.get(leadId);
      expect(after.sale_price_effective).toBe(777);
    });

    it('path 3: a later status change downgrading final_status does not regress the flags, even after a full re-backfill', async () => {
      // A hypothetical future bug: something downgrades final_status on an
      // already-sold lead (webhook.js has no precedence guard against this,
      // unlike leadbyteWebhook.js - see the module comment in leadFlags.js).
      await db.entities.Lead.update(leadId, { final_status: 'Disqualified' });
      await backfillLeadFlags(db); // simulates "a re-run of the backfill"
      const after = await db.entities.Lead.get(leadId);
      expect(after.is_sold).toBe(true);
      expect(after.sale_price_effective).toBe(777);
    });

    it('path 4: a simulated outcome webhook moving a sold lead to Converted with a DIFFERENT revenue value keeps the ORIGINAL sale price', async () => {
      // Mirrors exactly what server/src/functions/webhook.js does on a real
      // outcome postback: final_status and revenue are both mutable fields on
      // the row, and revenue is legitimately overwritten in place.
      await db.entities.Lead.update(leadId, {
        final_status: 'Converted', revenue: 1500, buyer_conversion: 'Retained',
      });
      const patched = await db.entities.Lead.get(leadId);
      const computed = computeLeadFlags(patched);
      const patch = leadFlagsPatch(patched, computed);
      // is_converted is legitimately new information and SHOULD be written...
      expect(patch).toMatchObject({ is_converted: true, conversion_type: 'Retained' });
      // ...but is_sold/sale_price_effective must not appear in it at all.
      expect(patch).not.toHaveProperty('is_sold');
      expect(patch).not.toHaveProperty('sale_price_effective');
      await db.entities.Lead.update(leadId, patch);

      const after = await db.entities.Lead.get(leadId);
      expect(after.is_sold).toBe(true);
      expect(after.sale_price_effective).toBe(777); // the ORIGINAL price, not 1500
      expect(after.is_converted).toBe(true);
    });

    it('path 5: a raw SQL UPDATE that bypasses this module and the Repo layer entirely is still rejected, by the database trigger', async () => {
      const table = 'e_lead';
      await pool.query(
        `UPDATE ${table} SET data = data || '{"is_sold": false, "sale_price_effective": 1}'::jsonb WHERE id = $1`,
        [leadId],
      );
      const after = await db.entities.Lead.get(leadId);
      expect(after.is_sold).toBe(true);
      expect(after.sale_price_effective).toBe(777);
    });

    it('path 6: an UPDATE that also changes unrelated fields still applies those fields; only the protected keys are pinned', async () => {
      await db.entities.Lead.update(leadId, { is_sold: false, buyer_feedback: 'left a voicemail' });
      const after = await db.entities.Lead.get(leadId);
      expect(after.is_sold).toBe(true); // pinned
      expect(after.buyer_feedback).toBe('left a voicemail'); // unrelated field still wrote normally
    });
  });

  // ── Reconciliation ───────────────────────────────────────────────────────
  describe('reconciliation against the real Sold-only-filtered revenue figures (partnerMetrics.js buyerMetrics / reportMetrics.js booked_revenue)', () => {
    it('for leads still Sold today, flags-based revenue equals sum(revenue) where final_status = Sold, to the cent', async () => {
      // A realistic scale slice: 40 currently-Sold leads at varied prices, plus
      // a spread of every non-revenue-bearing status, none of which has moved
      // away from Sold yet. This is the case the acceptance step's "revenue
      // from flags equals revenue from the current status query" means: right
      // after backfill, before anything returns or converts, nothing about
      // switching to flags may have lost or invented a cent, for the figures
      // that actually use this Sold-only filter today - partnerMetrics.js's
      // buyerMetrics (~line 33-35) and reportMetrics.js's secondary
      // `booked_revenue` stat (~line 296). It happens to also equal the
      // primary Overview/Reports headline revenue in this particular
      // scenario, but only because nothing has converted or returned yet;
      // see the next two tests for what happens once something does.
      const prices = Array.from({ length: 40 }, (_, i) => 100 + i * 7.35);
      for (const p of prices) await seedLead({ final_status: 'Sold', revenue: Math.round(p * 100) / 100 });
      for (let i = 0; i < 25; i += 1) await seedLead({ final_status: 'Disqualified' });
      for (let i = 0; i < 10; i += 1) await seedLead({ final_status: 'Unsold' });
      for (let i = 0; i < 5; i += 1) await seedLead({ final_status: 'Rejected' });

      await backfillLeadFlags(db);
      const allLeads = await db.entities.Lead.list('-created_date', 1000, 0);

      const currentStatusRevenue = allLeads
        .filter((l) => l.final_status === 'Sold')
        .reduce((sum, l) => sum + (Number(l.revenue) || 0), 0);
      const roundedCurrent = Math.round(currentStatusRevenue * 100) / 100;

      const flagsRevenue = revenueFromFlags(allLeads);

      expect(flagsRevenue).toBe(roundedCurrent);
      expect(flagsRevenue).toBeGreaterThan(0);
    });

    it("proves the exact D2 drift in the figures that actually have it: once a sold lead converts, the Sold-only filter (partnerMetrics.js buyerMetrics / reportMetrics.js booked_revenue) silently loses it while flags-based revenue does not", async () => {
      const stillSold = await seedLead({ final_status: 'Sold', revenue: 300 });
      const willConvert = await seedLead({ final_status: 'Sold', revenue: 450 });

      await backfillLeadFlags(db);

      // Time passes. The buyer confirms it downstream - exactly the webhook.js
      // outcome path modelled in the write-once tests above.
      await db.entities.Lead.update(willConvert.id, { final_status: 'Converted', buyer_conversion: 'Signed' });
      const patched = await db.entities.Lead.get(willConvert.id);
      const patch = leadFlagsPatch(patched, computeLeadFlags(patched));
      await db.entities.Lead.update(willConvert.id, patch);

      const allLeads = await db.entities.Lead.list('-created_date', 1000, 0);

      // This Sold-only filter is exactly how partnerMetrics.js's buyerMetrics
      // (~line 33-35: `leads.filter(l => l.final_status === 'Sold')`) and
      // reportMetrics.js's secondary `booked_revenue` stat (~line 296: only
      // accumulated `if (s === 'Sold')`) compute revenue today. It is NOT how
      // the primary Overview/Reports headline revenue is computed - see the
      // superset-safe test below for that one - so this test's claim is
      // scoped to these two real figures, which is where D2's actual bug
      // lives, not to the headline.
      const soldOnlyFilteredRevenue = allLeads
        .filter((l) => l.final_status === 'Sold')
        .reduce((sum, l) => sum + (Number(l.revenue) || 0), 0);

      // The NEW way, from the immutable flags this unit adds.
      const newFlagsRevenue = revenueFromFlags(allLeads);

      // The Sold-only filter silently dropped the converted lead's $450 the
      // moment it converted, exactly as forge-pack/CONTRACT.md D2 describes
      // for buyerMetrics/booked_revenue. The flags-based figure did not.
      expect(soldOnlyFilteredRevenue).toBe(300);
      expect(newFlagsRevenue).toBe(750);
      expect(newFlagsRevenue - soldOnlyFilteredRevenue).toBe(450);
      void stillSold;
    });

    it('is a superset-safe match for the primary Overview/Reports headline revenue, which was never exposed to the D2 drift because it never filters on final_status at all', async () => {
      // overviewFinance.js's financialTruth() (~line 45: `bookedRevenue =
      // wLeads.reduce((a, l) => a + num(l.revenue), 0)`) and reportMetrics.js's
      // computeMetrics() primary `revenue` accumulator (~line 294: unconditional
      // `revenue += num(l.revenue)` inside the per-lead loop, before any status
      // branching) both sum every filtered lead's revenue with NO final_status
      // check whatsoever. A Converted or Returned lead's revenue was always
      // included there - there was never a status filter for a conversion to
      // silently fall out of. This test does not claim the fix "protects" that
      // calculation from a bug it was never exposed to; it only confirms
      // flags-based revenue remains a consistent, superset-safe figure
      // alongside it once a sold lead converts (and stays sold, unreturned).
      const stillSold = await seedLead({ final_status: 'Sold', revenue: 300 });
      const willConvert = await seedLead({ final_status: 'Sold', revenue: 450 });

      await backfillLeadFlags(db);

      await db.entities.Lead.update(willConvert.id, { final_status: 'Converted', buyer_conversion: 'Signed' });
      const patched = await db.entities.Lead.get(willConvert.id);
      await db.entities.Lead.update(willConvert.id, leadFlagsPatch(patched, computeLeadFlags(patched)));

      const allLeads = await db.entities.Lead.list('-created_date', 1000, 0);

      // The always-inclusive primary calculation: sum every lead's revenue,
      // no final_status check at all - mirroring overviewFinance.js and
      // reportMetrics.js's primary `revenue` exactly.
      const primaryHeadlineRevenue = allLeads.reduce((sum, l) => sum + (Number(l.revenue) || 0), 0);
      const flagsRevenue = revenueFromFlags(allLeads);

      expect(flagsRevenue).toBe(primaryHeadlineRevenue);
      expect(flagsRevenue).toBe(750);
      void stillSold;
    });

    it('excludes an approved return from flags-based revenue exactly as generateBillingRun.js already excludes it from billable leads', async () => {
      const kept = await seedLead({ final_status: 'Sold', revenue: 300 });
      const returned = await seedLead({ final_status: 'Sold', revenue: 500 });
      await db.entities.ReturnRequest.create({
        lead_id: returned.id, buyer_id: 'buyer-1', reason: 'Bad contact info',
        status: 'approved', resolved_date: '2026-08-07T00:00:00.000Z',
      });

      await backfillLeadFlags(db);
      const allLeads = await db.entities.Lead.list('-created_date', 1000, 0);

      expect(revenueFromFlags(allLeads)).toBe(300);
      void kept;
    });
  });
});
