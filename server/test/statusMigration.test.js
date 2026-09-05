import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/* W2-STATUS: the seven-status migration, the connector trigger remap and the
 * do-not-contact rejection path. forge-pack/CONTRACT.md D1, D3 and D4.
 *
 * Run against a real, disposable PostgreSQL, the same pattern
 * server/test/leadFlags.test.js and server/test/migrationBuyerIdentity.test.js
 * use, because two of the load-bearing guarantees are database properties and
 * cannot be proven against an in-memory stand-in:
 *
 *   - the money flags this migration must not disturb are latched by the
 *     lead_flags_write_once trigger in server/src/db/schema.js;
 *   - the JSONB entity repository does a blind top-level merge on update, so
 *     "the patch only contains what I think it contains" is only really
 *     answered by writing it and reading the row back.
 *
 * What is proven here, mapped to W2-STATUS's acceptance_steps:
 *
 *   1. "All leads migrate with zero rows on a retired value." Every one of the
 *      twelve legacy values is present in the synthetic set and every row ends
 *      on one of D1's seven, with the unmappable ones reported rather than
 *      defaulted.
 *   2. "Revenue, sold count and GP identical before and after, to the cent."
 *      Revenue is computed from the W1-FLAGS money flags before the migration
 *      and again after it, and every one of the eight flags is compared field
 *      by field on every lead.
 *   3. "A test asserts no connector trigger key references a retired status."
 *      Both directions: the check passes after the remap, and it fails when a
 *      retired key is deliberately reintroduced, so the check is not vacuous.
 *   4. "Historical Error leads carry migrated_at and the reaper excludes them."
 *   5. "A DNC-suppressed lead is stored, reaches rejected with REJECTED_DNC,
 *      reaches no buyer." Proven by running the real processLead against a
 *      real DncEntry, not by reading the source.
 *   6. "Existing DNC all-path tests pass unchanged." Left to those suites;
 *      this file adds to them rather than restating them.
 *
 * WHAT THIS DOES NOT PROVE, and it is the same limitation W1-FLAGS disclosed.
 * forge-pack/CONTRACT.md section 6 asks for the migration to run on a restored
 * copy of production, with 1,984 real leads, and for revenue to match to the
 * cent on that data. No restored production copy exists in this worktree; a
 * database backup restore is infrastructure work and is out of this unit's
 * scope. Everything below runs against a REALISTIC SYNTHETIC dataset that
 * covers every legacy value and every edge case named in the work unit, at
 * miniature scale. The restored-copy drill remains a required follow-up before
 * this migration is applied to real data.
 */

const TEST_DB = 'dashflo_status_migration_test';
const MAINTENANCE_DB = 'postgres';
const FORBIDDEN_DATABASES = new Set(['dashos', 'postgres', 'template0', 'template1']);
const PGHOST = process.env.PGHOST || '127.0.0.1';
const PGPORT = process.env.PGPORT_TEST || '5433';
const PGUSER = process.env.PGUSER || process.env.USER || 'postgres';

process.env.PGHOST = PGHOST;
process.env.PGPORT = PGPORT;
process.env.PGUSER = PGUSER;
process.env.PGDATABASE = TEST_DB;
delete process.env.DATABASE_URL;

// Without a key the suppression check returns UNAVAILABLE and every post takes
// the HELD branch, which would make the do-not-contact assertions below prove
// nothing. Disposable local value, never a real secret.
process.env.DNC_HASH_KEY = 'status-migration-suite-disposable-hash-key';

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

describe.skipIf(!reachable)('W2-STATUS: seven-status migration', () => {
  let pool;
  let db;
  let status;
  let flags;
  let processLead;
  let hashApiKey;
  let mintApiKey;
  let dncLib;
  let webhook;
  let leadbyteWebhook;
  let migrationScript;
  let sha256Hex;

  beforeAll(async () => {
    await maintenance(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await maintenance(`CREATE DATABASE ${TEST_DB}`);
    ({ pool } = await import('../src/db/pool.js'));
    const { rows } = await pool.query('SELECT current_database() AS db');
    if (rows[0].db !== TEST_DB || FORBIDDEN_DATABASES.has(rows[0].db)) {
      throw new Error(`Refusing to run: connected to "${rows[0].db}", expected "${TEST_DB}".`);
    }
    const schema = await import('../src/db/schema.js');
    await schema.ensureSchema();
    const { ensureReceiptSchema } = await import('../src/db/receiptSchema.js');
    await ensureReceiptSchema();
    const { entitiesNamespace } = await import('../src/db/repo.js');
    db = { entities: entitiesNamespace() };
    status = await import('../src/lib/leadStatus.js');
    flags = await import('../src/lib/leadFlags.js');
    dncLib = await import('../src/lib/dnc.js');
    ({ hashApiKey, mintApiKey } = await import('../src/lib/apiKeys.js'));
    processLead = (await import('../src/functions/processLead.js')).default;
    // The two live outcome endpoints, exercised for real rather than by
    // reading their source. Adversarial QA finding B2.
    webhook = (await import('../src/functions/webhook.js')).default;
    leadbyteWebhook = (await import('../src/functions/leadbyteWebhook.js')).default;
    // The migration's invokable entry point. Adversarial QA finding B1.
    migrationScript = await import('../scripts/migrate-status-vocabulary.js');
    const { createHash } = await import('node:crypto');
    sha256Hex = (input) => createHash('sha256').update(input).digest('hex');
  });

  afterAll(async () => {
    await pool?.end?.().catch(() => {});
    if (reachable) {
      await maintenance(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB}' AND pid <> pg_backend_pid()`).catch(() => {});
      await maintenance(`DROP DATABASE IF EXISTS ${TEST_DB}`).catch(() => {});
    }
  });

  beforeEach(async () => {
    const { rows } = await pool.query(`
      SELECT relname AS table_name FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND relname LIKE 'e\\_%'`);
    for (const row of rows) await pool.query(`TRUNCATE ${row.table_name}`);
    await pool.query('TRUNCATE lead_receipts');
  });

  // ── The synthetic dataset ───────────────────────────────────────────────
  //
  // One lead for every one of the twelve legacy values, plus every edge case
  // W2-STATUS names: a lead already sitting on a target seven-value status, a
  // lead with an already-recorded do-not-contact rejection, a duplicate of
  // another lead in the same set (both linkage routes), an Error lead whose
  // downstream connector is keyed on the retired intake trigger, and a lead
  // on a value the migration must refuse to guess at.
  const baseLead = (overrides) => ({
    supplier_name: 'Synthetic Supplier',
    created_date: '2026-08-01T12:00:00.000Z',
    processed_at: '2026-08-01T12:00:00.000Z',
    ...overrides,
  });

  const seedLead = async (overrides) => db.entities.Lead.create(baseLead(overrides));

  async function seedSyntheticLeads() {
    const L = status.LEGACY_STATUS;
    const original = await seedLead({
      final_status: L.SOLD, revenue: 250, email: 'ada@example.test',
      email_normalized: 'ada@example.test', mobile_normalized: '5551110001',
      created_date: '2026-08-01T09:00:00.000Z',
    });

    const leads = {
      original,
      soldNoPrice: await seedLead({ final_status: L.SOLD, revenue_source: 'unknown' }),
      unsold: await seedLead({ final_status: L.UNSOLD }),
      returned: await seedLead({
        final_status: L.RETURNED, revenue: 300, buyer_returned: true,
        leadbyte_outcome_at: '2026-08-05T09:00:00.000Z',
      }),
      converted: await seedLead({
        final_status: L.CONVERTED, revenue: 400, buyer_conversion: 'Signed',
        leadbyte_outcome_at: '2026-08-10T09:00:00.000Z',
      }),
      disqualified: await seedLead({ final_status: L.DISQUALIFIED }),
      rejected: await seedLead({ final_status: L.REJECTED }),
      queued: await seedLead({ final_status: L.QUEUED, queue_reason: 'Missing required fields' }),
      processing: await seedLead({ final_status: L.PROCESSING }),
      qualified: await seedLead({ final_status: L.QUALIFIED }),
      fake: await seedLead({ final_status: L.FAKE }),
      errored: await seedLead({ final_status: L.ERROR, error_stage: 'leadbyte' }),

      // Duplicate route 1: leadbyteWebhook.js recorded the collapse, so the
      // link is a recorded decision rather than an inference.
      duplicateByMarker: await seedLead({
        final_status: L.DUPLICATE, archived: true,
        created_date: '2026-08-02T09:00:00.000Z',
        mapped_fields: JSON.stringify({ merged_into: original.id, merged_reason: 'identity_match_leadbyte_webhook' }),
      }),
      // Duplicate route 2: no marker, but it shares the original's identity.
      duplicateByIdentity: await seedLead({
        final_status: L.DUPLICATE, archived: true,
        email: 'ada@example.test', email_normalized: 'ada@example.test',
        created_date: '2026-08-03T09:00:00.000Z',
      }),
      // Duplicate route 3: nothing to link it to. Must be reported, not guessed.
      duplicateOrphan: await seedLead({
        final_status: L.DUPLICATE, archived: true,
        created_date: '2026-08-04T09:00:00.000Z',
      }),

      // Already migrated by the live path: carries the new vocabulary and a
      // do-not-contact rejection already recorded against it. The migration
      // must leave it completely alone.
      alreadyRejectedDnc: await seedLead({
        final_status: L.REJECTED,
        lead_status: status.LEAD_STATUS.REJECTED,
        processing_state: status.PROCESSING_STATE.SETTLED,
        status_reason: status.STATUS_REASON.REJECTED_DNC,
        is_qualified: false,
      }),
      // Already sitting on a target seven-value status with nothing left to do.
      alreadySold: await seedLead({
        final_status: L.SOLD, revenue: 125,
        lead_status: status.LEAD_STATUS.SOLD,
        processing_state: status.PROCESSING_STATE.SETTLED,
        is_qualified: true,
      }),
      // A value the vocabulary does not know. Reported, never defaulted.
      unmappable: await seedLead({ final_status: '24m Lead' }),
    };
    return leads;
  }

  async function seedConnectors() {
    const T = status.LEGACY_TRIGGER;
    return {
      intakeConnector: await db.entities.ApiConnector.create({
        name: 'Meta intake', kind: 'facebook_capi', enabled: true,
        triggers: JSON.stringify([T.RECEIVED]),
        received_event_name: 'Lead',
      }),
      dupeAndDqConnector: await db.entities.ApiConnector.create({
        name: 'Dedupe and DQ', kind: 'webhook', enabled: true,
        triggers: JSON.stringify([T.DUPLICATES, T.DQ]),
        duplicates_event_name: 'DupeLead', dq_event_name: 'DQLead',
      }),
      fireOnEverything: await db.entities.ApiConnector.create({
        name: 'Fires at intake only', kind: 'webhook', enabled: true,
        triggers: JSON.stringify([]),
      }),
      alreadyCanonical: await db.entities.ApiConnector.create({
        name: 'Sold only', kind: 'facebook_capi', enabled: true,
        triggers: JSON.stringify([status.TRIGGER.ON_SOLD]),
        sold_event_name: 'Purchase',
      }),
      // The case W2-STATUS names explicitly: an Error lead's downstream
      // destination, keyed on the retired intake trigger.
      errorDestination: await db.entities.LeadByteConnector.create({
        api_name: 'Error mirror', target_url: 'https://destination.invalid/errors',
        enabled: true, kind: 'generic_http',
        triggers: JSON.stringify([T.RECEIVED, T.ERROR]),
      }),
      customDestination: await db.entities.LeadByteConnector.create({
        api_name: 'Custom status feed', target_url: 'https://destination.invalid/custom',
        enabled: true, kind: 'generic_http',
        triggers: JSON.stringify(['on_24m_lead']),
      }),
      duplicateRoute: await db.entities.InboundWebhookRoute.create({
        name: 'Buyer duplicate postbacks', enabled: true,
        event_type: status.LEGACY_STATUS.DUPLICATE,
      }),
      soldRoute: await db.entities.InboundWebhookRoute.create({
        name: 'Buyer sold postbacks', enabled: true,
        event_type: status.LEGACY_STATUS.SOLD,
      }),
      dynamicRoute: await db.entities.InboundWebhookRoute.create({
        name: 'Dynamic postbacks', enabled: true, event_type: '',
      }),
    };
  }

  const reload = (id) => db.entities.Lead.get(id);

  // ── Acceptance step 1: zero rows on a retired value ─────────────────────

  it('migrates every one of the twelve legacy values onto D1 seven, and leaves nothing on a retired value', async () => {
    const leads = await seedSyntheticLeads();
    const report = await status.migrateStatusVocabulary(db);

    expect(report.leads.counts.total).toBe(Object.keys(leads).length);
    expect(report.verification.leads_on_retired_status).toEqual([]);

    // Every legacy value present in the fixture is covered by the mapping, and
    // every migrated row landed inside the seven.
    const all = await db.entities.Lead.list('-created_date', 500, 0);
    for (const lead of all) {
      if (lead.id === leads.unmappable.id) continue;
      expect(status.isLeadStatus(lead.lead_status), `${lead.final_status} landed on ${lead.lead_status}`).toBe(true);
      expect(status.isProcessingState(lead.processing_state)).toBe(true);
    }

    // D4's five retiring values, row by row.
    expect(await reload(leads.processing.id)).toMatchObject({
      lead_status: 'queued', processing_state: 'routing',
      status_reason: 'MIGRATED_FROM_PROCESSING',
    });
    expect(await reload(leads.qualified.id)).toMatchObject({
      lead_status: 'queued', is_qualified: true,
      status_reason: 'MIGRATED_FROM_QUALIFIED',
    });
    expect(await reload(leads.duplicateByMarker.id)).toMatchObject({
      lead_status: 'rejected', status_reason: 'REJECTED_DUPLICATE',
      duplicate_of_lead_id: leads.original.id,
    });
    expect(await reload(leads.errored.id)).toMatchObject({
      lead_status: 'queued', processing_state: 'failed',
      status_reason: 'MIGRATED_FROM_ERROR',
    });
    expect(await reload(leads.fake.id)).toMatchObject({
      lead_status: 'rejected', status_reason: 'REJECTED_FAKE',
    });

    // The seven survivors keep their meaning.
    expect((await reload(leads.original.id)).lead_status).toBe('sold');
    expect((await reload(leads.unsold.id)).lead_status).toBe('unsold');
    expect((await reload(leads.returned.id)).lead_status).toBe('returned');
    expect((await reload(leads.converted.id)).lead_status).toBe('converted');
    expect((await reload(leads.disqualified.id)).lead_status).toBe('disqualified');
    expect((await reload(leads.rejected.id)).lead_status).toBe('rejected');
    expect((await reload(leads.queued.id)).lead_status).toBe('queued');
  });

  it('reports an unmappable value instead of defaulting it onto a status it never earned', async () => {
    const leads = await seedSyntheticLeads();
    const { counts, exceptions } = await status.backfillLeadStatus(db);

    expect(counts.unmapped).toBe(1);
    const unmapped = exceptions.find((e) => e.reason === 'unmapped_status');
    expect(unmapped.lead_id).toBe(leads.unmappable.id);

    const row = await reload(leads.unmappable.id);
    expect(row.lead_status).toBeUndefined();
    expect(row.migrated_at).toBeUndefined();
    // Untouched means untouched: the legacy value is still exactly what it was.
    expect(row.final_status).toBe('24m Lead');
  });

  it('leaves final_status alone, which is what makes the rollback "drop the new keys"', async () => {
    const leads = await seedSyntheticLeads();
    const before = new Map();
    for (const lead of Object.values(leads)) before.set(lead.id, lead.final_status);

    await status.migrateStatusVocabulary(db);

    for (const [id, legacyValue] of before) {
      expect((await reload(id)).final_status, `final_status moved on ${id}`).toBe(legacyValue);
    }
  });

  it('links a duplicate by recorded marker, then by identity, and reports the one it cannot link', async () => {
    const leads = await seedSyntheticLeads();
    const { counts, exceptions } = await status.backfillLeadStatus(db);

    expect(counts.duplicates_linked).toBe(2);
    expect(counts.duplicates_unlinked).toBe(1);

    expect((await reload(leads.duplicateByMarker.id)).duplicate_of_lead_id).toBe(leads.original.id);
    expect((await reload(leads.duplicateByIdentity.id)).duplicate_of_lead_id).toBe(leads.original.id);

    const orphanRow = await reload(leads.duplicateOrphan.id);
    expect(orphanRow.lead_status).toBe('rejected');
    expect(orphanRow.status_reason).toBe('REJECTED_DUPLICATE');
    expect(orphanRow.duplicate_of_lead_id).toBeUndefined();
    expect(exceptions.some((e) => e.reason === 'duplicate_original_not_found'
      && e.lead_id === leads.duplicateOrphan.id)).toBe(true);
  });

  it('records the qualification signal as true, false or unknown, and counts the unknown bucket', async () => {
    await seedSyntheticLeads();
    const { counts } = await status.backfillLeadStatus(db);
    // Provably qualified: the original sale, the unpriced sale, unsold,
    // returned, converted, the Qualified lead, and the already-sold lead.
    expect(counts.qualified).toBe(7);
    // Provably not: disqualified, rejected, the already-DNC-rejected lead,
    // fake, and the three duplicates.
    expect(counts.not_qualified).toBe(7);
    // Genuinely unknowable: queued, processing, errored.
    expect(counts.qualification_unknown).toBe(3);
    expect(counts.qualified + counts.not_qualified + counts.qualification_unknown)
      .toBe(counts.total - counts.unmapped);
  });

  it('is idempotent: a second run writes nothing and changes nothing', async () => {
    await seedSyntheticLeads();
    await seedConnectors();

    const first = await status.migrateStatusVocabulary(db);
    expect(first.leads.counts.newly_migrated).toBeGreaterThan(0);
    expect(first.connectors.counts.api_connectors_remapped).toBeGreaterThan(0);

    const snapshot = new Map();
    for (const lead of await db.entities.Lead.list('-created_date', 500, 0)) {
      snapshot.set(lead.id, JSON.stringify(lead));
    }

    const second = await status.migrateStatusVocabulary(db);
    expect(second.leads.counts.newly_migrated).toBe(0);
    expect(second.leads.counts.verified_consistent).toBe(0);
    expect(second.connectors.counts.api_connectors_remapped).toBe(0);
    expect(second.connectors.counts.leadbyte_connectors_remapped).toBe(0);
    expect(second.connectors.counts.inbound_routes_remapped).toBe(0);
    // NOT clean, and that is the point of finding S1 below: this fixture
    // deliberately contains a lead on a value the mapping does not know and a
    // duplicate with no identifiable original. Both need a human. This
    // assertion used to read `toBe(true)`, which is how a verification that
    // ignored its own exception list managed to look green on a dirty
    // dataset for as long as it did.
    expect(second.verification.clean).toBe(false);

    for (const lead of await db.entities.Lead.list('-created_date', 500, 0)) {
      expect(JSON.stringify(lead), `row changed on the second run: ${lead.id}`).toBe(snapshot.get(lead.id));
    }
  });

  it('resumes safely when the first run was interrupted partway through', async () => {
    const leads = await seedSyntheticLeads();
    // Simulate an interruption: migrate one lead by hand, then run the whole
    // backfill and confirm it neither skips the rest nor rewrites the one that
    // was already done.
    const partial = status.leadStatusPatch(leads.errored, { at: new Date('2026-09-01T00:00:00.000Z') });
    await db.entities.Lead.update(leads.errored.id, partial);

    const { counts } = await status.backfillLeadStatus(db);
    expect(counts.already_migrated).toBeGreaterThanOrEqual(1);

    const row = await reload(leads.errored.id);
    // The earlier stamp survives, so provenance is not rewritten by a resume.
    expect(row.migrated_at).toBe('2026-09-01T00:00:00.000Z');
    expect(row.lead_status).toBe('queued');
    expect((await reload(leads.fake.id)).lead_status).toBe('rejected');
  });

  // ── Acceptance step 2: revenue identical to the cent (D4 risk 2) ────────

  it('leaves every money flag and the revenue total byte-identical (D4 risk 2)', async () => {
    const leads = await seedSyntheticLeads();

    // W1-FLAGS runs first, exactly as it would in production: the money flags
    // are already set and already latched before the status migration starts.
    await flags.backfillLeadFlags(db);

    const before = await db.entities.Lead.list('-created_date', 500, 0);
    const revenueBefore = flags.revenueFromFlags(before);
    const flagsBefore = new Map(before.map((lead) => [
      lead.id,
      JSON.stringify(Object.fromEntries(flags.LEAD_FLAG_FIELDS.map((f) => [f, lead[f] ?? null]))),
    ]));
    // The synthetic set must actually carry revenue, or this proves nothing.
    expect(revenueBefore).toBeGreaterThan(0);

    await status.migrateStatusVocabulary(db);

    const after = await db.entities.Lead.list('-created_date', 500, 0);
    const revenueAfter = flags.revenueFromFlags(after);

    // To the cent.
    expect(revenueAfter).toBe(revenueBefore);
    expect(revenueAfter.toFixed(2)).toBe(revenueBefore.toFixed(2));

    // And field by field on every lead, not just in aggregate: an aggregate
    // can stay equal while two leads swap values.
    for (const lead of after) {
      const snapshot = JSON.stringify(
        Object.fromEntries(flags.LEAD_FLAG_FIELDS.map((f) => [f, lead[f] ?? null])),
      );
      expect(snapshot, `money flags moved on ${lead.id}`).toBe(flagsBefore.get(lead.id));
    }

    // Sold count, the other figure the acceptance step names, read the D2 way.
    const soldBefore = before.filter((l) => l.is_sold === true).length;
    const soldAfter = after.filter((l) => l.is_sold === true).length;
    expect(soldAfter).toBe(soldBefore);

    // The converted and returned leads are the ones that used to drift, so
    // check them explicitly rather than trusting the aggregate.
    expect((await reload(leads.converted.id)).sale_price_effective).toBe(400);
    expect((await reload(leads.returned.id)).is_returned).toBe(true);
    expect((await reload(leads.converted.id)).lead_status).toBe('converted');
  });

  it('refuses at runtime to write a money flag, even if a future edit tries', async () => {
    // The guarantee above is only as good as the guard behind it. This proves
    // the guard is real: STATUS_PATCH_FIELDS shares no member with the money
    // flags, and every patch is checked against it before it is written.
    for (const moneyField of status.MONEY_FIELDS_NEVER_WRITTEN) {
      expect(status.STATUS_PATCH_FIELDS).not.toContain(moneyField);
    }
    const patch = status.statusPatch(status.LEGACY_STATUS.SOLD, { reason: 'SOLD' });
    for (const key of Object.keys(patch)) {
      expect(status.MONEY_FIELDS_NEVER_WRITTEN).not.toContain(key);
    }
  });

  it('does not disturb the money flags even when a status migration runs BEFORE the flags backfill', async () => {
    // Order independence matters operationally: nobody should have to
    // remember which backfill runs first.
    await seedSyntheticLeads();
    await status.migrateStatusVocabulary(db);
    await flags.backfillLeadFlags(db);
    const afterStatusFirst = flags.revenueFromFlags(await db.entities.Lead.list('-created_date', 500, 0));

    // Same dataset, flags first.
    const { rows } = await pool.query(`
      SELECT relname AS table_name FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND relname LIKE 'e\\_%'`);
    for (const row of rows) await pool.query(`TRUNCATE ${row.table_name}`);

    await seedSyntheticLeads();
    await flags.backfillLeadFlags(db);
    await status.migrateStatusVocabulary(db);
    const afterFlagsFirst = flags.revenueFromFlags(await db.entities.Lead.list('-created_date', 500, 0));

    expect(afterStatusFirst).toBe(afterFlagsFirst);
  });

  // ── Acceptance step 3: no retired connector trigger survives (D4 risk 1) ──

  it('remaps every connector trigger array and every pinned route status', async () => {
    const connectors = await seedConnectors();
    const report = await status.backfillConnectorTriggers(db);

    expect(report.counts.api_connectors_remapped).toBe(2);
    expect(report.counts.leadbyte_connectors_remapped).toBe(1);
    expect(report.counts.inbound_routes_remapped).toBe(2);
    expect(report.counts.legacy_trigger_keys_found).toBe(5);

    const read = async (entity, id) => db.entities[entity].get(id);
    const triggersOf = async (entity, id) => JSON.parse((await read(entity, id)).triggers || '[]');

    expect(await triggersOf('ApiConnector', connectors.intakeConnector.id))
      .toEqual([status.TRIGGER.ON_QUALIFIED]);
    expect(await triggersOf('ApiConnector', connectors.dupeAndDqConnector.id))
      .toEqual([status.TRIGGER.ON_REJECTED_DUPLICATE, status.TRIGGER.ON_DISQUALIFIED]);
    // Empty and already canonical arrays are untouched, and carry no marker.
    expect(await triggersOf('ApiConnector', connectors.fireOnEverything.id)).toEqual([]);
    expect((await read('ApiConnector', connectors.fireOnEverything.id)).triggers_migrated_at).toBeUndefined();
    expect(await triggersOf('ApiConnector', connectors.alreadyCanonical.id))
      .toEqual([status.TRIGGER.ON_SOLD]);
    // The Error lead's destination, the case W2-STATUS names explicitly.
    expect(await triggersOf('LeadByteConnector', connectors.errorDestination.id))
      .toEqual([status.TRIGGER.ON_QUALIFIED, status.TRIGGER.ON_PROCESSING_FAILED]);
    // A custom inbound status keeps its own trigger.
    expect(await triggersOf('LeadByteConnector', connectors.customDestination.id))
      .toEqual(['on_24m_lead']);

    // InboundWebhookRoute pinned statuses.
    expect((await read('InboundWebhookRoute', connectors.duplicateRoute.id)).event_type).toBe('rejected');
    expect((await read('InboundWebhookRoute', connectors.soldRoute.id)).event_type).toBe('sold');
    expect((await read('InboundWebhookRoute', connectors.dynamicRoute.id)).event_type).toBe('');
    expect((await read('InboundWebhookRoute', connectors.dynamicRoute.id)).event_type_migrated_at).toBeUndefined();
  });

  it('preserves the pre-migration value on the row, so the remap is reversible without a restore', async () => {
    const connectors = await seedConnectors();
    await status.backfillConnectorTriggers(db);

    const intake = await db.entities.ApiConnector.get(connectors.intakeConnector.id);
    expect(JSON.parse(intake.triggers_legacy)).toEqual([status.LEGACY_TRIGGER.RECEIVED]);
    expect(intake.triggers_migrated_at).toBeTruthy();

    const route = await db.entities.InboundWebhookRoute.get(connectors.duplicateRoute.id);
    expect(route.event_type_legacy).toBe(status.LEGACY_STATUS.DUPLICATE);
    expect(route.event_type_migrated_at).toBeTruthy();
  });

  it('FAILS LOUDLY if any retired trigger key survives anywhere in stored data', async () => {
    await seedConnectors();
    await status.backfillConnectorTriggers(db);
    expect(await status.findRetiredTriggerKeys(db)).toEqual([]);

    // Negative control. A check that can only ever return empty proves
    // nothing, so reintroduce a retired key exactly the way an unmigrated
    // settings screen would and confirm the check catches it.
    const smuggled = await db.entities.ApiConnector.create({
      name: 'Created by an unmigrated settings screen', kind: 'facebook_capi', enabled: true,
      triggers: JSON.stringify([status.LEGACY_TRIGGER.RECEIVED]),
    });
    const found = await status.findRetiredTriggerKeys(db);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      entity: 'ApiConnector', id: smuggled.id, key: status.LEGACY_TRIGGER.RECEIVED,
    });

    // And a route left on a retiring pinned status is caught too.
    const staleRoute = await db.entities.InboundWebhookRoute.create({
      name: 'Left on a retired pin', enabled: true, event_type: status.LEGACY_STATUS.DUPLICATE,
    });
    expect((await status.findRetiredTriggerKeys(db)).some((f) => f.id === staleRoute.id)).toBe(true);
  });

  it('keeps a connector firing whichever spelling its stored array holds', async () => {
    // The silent failure D4 risk 1 describes cuts both ways. After the remap
    // the stored array is canonical and must still match; a connector created
    // afterwards by an unmigrated settings screen holds the retired key and
    // must ALSO still match, or this migration causes the exact failure it
    // exists to prevent.
    const connectors = await seedConnectors();
    await status.backfillConnectorTriggers(db);

    const migrated = JSON.parse((await db.entities.ApiConnector.get(connectors.intakeConnector.id)).triggers);
    expect(status.triggerMatches(migrated, status.INTAKE_TRIGGER)).toBe(true);

    const unmigrated = [status.LEGACY_TRIGGER.RECEIVED];
    expect(status.triggerMatches(unmigrated, status.INTAKE_TRIGGER)).toBe(true);

    // And the two merges that must NOT happen still do not happen.
    expect(status.triggerMatches(migrated, status.TRIGGER.ON_QUEUED)).toBe(false);
    const dupeDq = JSON.parse((await db.entities.ApiConnector.get(connectors.dupeAndDqConnector.id)).triggers);
    expect(status.triggerMatches(dupeDq, status.TRIGGER.ON_REJECTED)).toBe(false);
    expect(status.triggerMatches(dupeDq, status.TRIGGER.ON_REJECTED_DUPLICATE)).toBe(true);
  });

  // ── Acceptance step 4: historical errors are never re-driven (risk 3) ────

  it('stamps migrated_at on every migrated row and excludes them all from re-drive', async () => {
    const leads = await seedSyntheticLeads();
    await status.migrateStatusVocabulary(db);

    const errored = await reload(leads.errored.id);
    expect(errored.lead_status).toBe('queued');
    expect(errored.processing_state).toBe('failed');
    expect(errored.migrated_at).toBeTruthy();
    expect(status.isExcludedFromRedrive(errored)).toBe(true);
    expect(status.isRedriveEligible(errored)).toBe(false);

    // Not only the Error leads. A historical Processing row becomes queued +
    // routing, which is indistinguishable from a lead in flight right now, and
    // a historical Queued row looks exactly like one waiting for an operator.
    // Every migrated row is excluded, which is the superset that cannot flood.
    // The only row not covered is the one the migration refused to touch,
    // because its final_status is a value nothing knows how to map.
    const all = await db.entities.Lead.list('-created_date', 500, 0);
    const migratedRows = all.filter((l) => l.id !== leads.unmappable.id);
    for (const lead of migratedRows) {
      expect(status.isExcludedFromRedrive(lead), `${lead.id} is re-drive eligible`).toBe(true);
    }

    // The whole point of the exclusion: nothing at queued + failed that came
    // from history is eligible, so a first run of any recovery job finds none
    // of them.
    const stuckAndEligible = all.filter((l) => l.lead_status === 'queued'
      && l.processing_state === 'failed' && status.isRedriveEligible(l));
    expect(stuckAndEligible).toEqual([]);
  });

  it('rewrites nothing on a lead already on a target status, and records that it looked', async () => {
    // Adversarial QA finding S2. This test used to assert that such a row came
    // out byte-identical, INCLUDING carrying no migrated_at, on the reasoning
    // that a lead the live path already wrote correctly is not a migration
    // candidate. It is: the migration examined it and confirmed it. Leaving no
    // trace made it indistinguishable from a row the migration never reached,
    // which broke the unit's fourth claim for exactly the rows a reader would
    // most want to ask about. The additive guarantee is unchanged and is what
    // this test now pins: every field except the marker is untouched.
    const leads = await seedSyntheticLeads();
    const beforeDnc = await reload(leads.alreadyRejectedDnc.id);
    const beforeSold = await reload(leads.alreadySold.id);

    const { leads: leadReport } = await status.migrateStatusVocabulary(db);

    const afterDnc = await reload(leads.alreadyRejectedDnc.id);
    const afterSold = await reload(leads.alreadySold.id);

    // Reported as examined-and-consistent, not as newly migrated.
    expect(leadReport.counts.verified_consistent).toBe(2);

    const ignoringBookkeeping = (row) => {
      const { migrated_at: marker, updated_date: touched, ...rest } = row;
      return rest;
    };
    expect(ignoringBookkeeping(afterDnc)).toEqual(ignoringBookkeeping(beforeDnc));
    expect(ignoringBookkeeping(afterSold)).toEqual(ignoringBookkeeping(beforeSold));
    expect(afterDnc.migrated_at).toBeTruthy();
    expect(afterSold.migrated_at).toBeTruthy();
    expect(afterDnc.status_reason).toBe('REJECTED_DNC');
    expect(afterDnc.lead_status).toBe('rejected');
    expect(afterSold.lead_status).toBe('sold');
  });

  it('a row that fails again for real AFTER the migration is re-drivable, marker or not', async () => {
    // Adversarial QA finding S3, proven end to end rather than on a literal.
    // migrated_at is permanent and never cleared, so the presence test this
    // predicate used to be would have hidden this lead from W4-REAPER for the
    // rest of its life: no log line, no queue entry, just a stuck lead nobody
    // was coming for.
    const leads = await seedSyntheticLeads();
    await status.migrateStatusVocabulary(db);

    const migrated = await reload(leads.errored.id);
    expect(migrated.migrated_at).toBeTruthy();
    expect(status.isRedriveEligible(migrated)).toBe(false);

    // Months later, a live processLead run touches this lead and it fails for
    // real. processLead.js writes processed_at on every branch it takes, and
    // leadStatus.js structurally cannot write it (not in STATUS_PATCH_FIELDS),
    // so a later value there can only have come from a live path.
    await db.entities.Lead.update(leads.errored.id, {
      processing_state: status.PROCESSING_STATE.FAILED,
      processed_at: '2026-11-20T09:00:00.000Z',
    });

    const failedAgain = await reload(leads.errored.id);
    expect(failedAgain.migrated_at).toBe(migrated.migrated_at); // never rewritten
    expect(status.isRedriveEligible(failedAgain)).toBe(true);

    // And a re-run of the migration still will not touch it: "already
    // migrated" and "not re-drivable" are now separate questions.
    const { counts } = await status.backfillLeadStatus(db);
    expect(counts.newly_migrated).toBe(0);
    expect((await reload(leads.errored.id)).migrated_at).toBe(migrated.migrated_at);
  });

  // ── Adversarial QA finding S1: the verification must fail on a dirty run ──

  it('reports clean false when a lead could not be mapped, or an exception was raised', async () => {
    // `clean` used to be computed from the two scans alone and reported true on
    // this very fixture, which contains a lead on a value the mapping does not
    // know and a duplicate with no identifiable original. Neither scan can see
    // either: an unmapped row has no lead_status at all, so it is invisible to
    // findLeadsOnRetiredStatus, and findRetiredTriggerKeys is about connectors.
    await seedSyntheticLeads();
    const report = await status.migrateStatusVocabulary(db);

    expect(report.verification.leads_on_retired_status).toEqual([]);
    expect(report.verification.retired_trigger_keys_remaining).toEqual([]);
    // The two scans are clean, and the run is NOT.
    expect(report.verification.unmapped_leads).toBe(1);
    expect(report.verification.exceptions).toBe(2); // unmappable + orphan duplicate
    expect(report.verification.clean).toBe(false);
  });

  it('reports clean true only when there is genuinely nothing left for a human', async () => {
    // The other half. A check that can only ever say "not clean" is as useless
    // as one that can only ever say "clean", so prove it flips.
    const L = status.LEGACY_STATUS;
    await seedLead({ final_status: L.SOLD, revenue: 100 });
    await seedLead({ final_status: L.UNSOLD });
    await seedLead({ final_status: L.QUALIFIED });
    await seedLead({ final_status: L.ERROR });

    const report = await status.migrateStatusVocabulary(db);
    expect(report.leads.counts.unmapped).toBe(0);
    expect(report.leads.exceptions).toEqual([]);
    expect(report.verification.clean).toBe(true);

    // Now introduce exactly one unmappable row and watch it flip, so the
    // verdict is demonstrably driven by the thing it claims to be driven by.
    await seedLead({ final_status: 'Some Custom Status' });
    const dirty = await status.migrateStatusVocabulary(db);
    expect(dirty.verification.unmapped_leads).toBe(1);
    expect(dirty.verification.clean).toBe(false);
  });

  // ── Acceptance step 5: DNC-suppressed leads (D3) ─────────────────────────

  describe('a do-not-contact suppressed lead, end to end through the real processLead', () => {
    const SUPPRESSED_MOBILE = '5559998877';
    const SUPPRESSED_EMAIL = 'blocked@example.test';
    let rawKey;

    async function seedSuppression() {
      const apiKeyRecord = {
        id: 'key-dnc', name: 'Test master', type: 'master',
        key_hash: hashApiKey(rawKey), key_prefix: rawKey.slice(0, 16),
        active: true, request_count: 0,
      };
      await db.entities.ApiKey.create(apiKeyRecord);
      // The entry is stored by keyed hash, never by raw value, exactly as
      // dncManage.js writes it.
      const { hashes } = dncLib.contactHashesFor({ mobile: SUPPRESSED_MOBILE, email: SUPPRESSED_EMAIL });
      for (const { kind, hash } of hashes) {
        await db.entities.DncEntry.create({
          contact_hash: hash, contact_kind: kind, scope: 'global',
          active: true, reason: 'Consumer opt-out request',
        });
      }
      return apiKeyRecord;
    }

    function makeCtx(payload, key) {
      const headers = { 'x-api-key': key };
      return {
        db,
        body: payload,
        env: process.env,
        user: null,
        req: { method: 'POST', headers, get: (name) => headers[String(name).toLowerCase()] || null },
        json: (body, statusCode = 200) => ({ __httpResponse: true, body, status: statusCode }),
      };
    }

    beforeEach(async () => {
      rawKey = mintApiKey('master');
    });

    it('is durably stored, reaches rejected with REJECTED_DNC, and reaches no buyer', async () => {
      await seedSuppression();
      // An enabled connector with an empty triggers array fires at intake on
      // EVERY lead, so if the suppression branch leaked past its return this
      // lead would have gone somewhere.
      await db.entities.ApiConnector.create({
        name: 'Fires on every lead', kind: 'webhook', enabled: true,
        triggers: JSON.stringify([]), target_url: 'https://buyer.invalid/intake',
      });

      const response = await processLead(makeCtx({
        first_name: 'Blocked', last_name: 'Person',
        mobile: SUPPRESSED_MOBILE, email: SUPPRESSED_EMAIL,
        state: 'TX', trustedform_url: 'https://cert.trustedform.com/abc',
      }, rawKey));

      // The supplier is told plainly, with the stable enforcement reason code.
      expect(response.status).toBe(200);
      expect(response.body.lead_status).toBe('rejected');
      expect(response.body.code).toBe('DNC_SUPPRESSED');

      // D3: durably stored. This is the part that did not happen before
      // W2-STATUS: the receipt was durable but no Lead row was ever created.
      const stored = await db.entities.Lead.list('-created_date', 50, 0);
      expect(stored).toHaveLength(1);
      const lead = stored[0];

      expect(lead.lead_status).toBe(status.LEAD_STATUS.REJECTED);
      expect(lead.status_reason).toBe(status.STATUS_REASON.REJECTED_DNC);
      expect(lead.processing_state).toBe(status.PROCESSING_STATE.SETTLED);
      expect(lead.is_qualified).toBe(false);
      // Dual-written, so the unmigrated client still shows it correctly.
      expect(lead.final_status).toBe(status.LEGACY_STATUS.REJECTED);
      // It is a real lead with a real sequential id, not a half record.
      expect(lead.lead_id).toBeGreaterThan(0);
      expect(lead.supplier_name).toBe('Master');

      // Reached no buyer: nothing was delivered and nothing fired.
      expect(lead.capi_log).toBeUndefined();
      expect(lead.delivery_log).toBeUndefined();
      expect(lead.buyer_id).toBeUndefined();
      expect(lead.revenue).toBeUndefined();
      // Money flags untouched by a rejection.
      expect(lead.is_sold).toBe(false);
      expect(lead.sale_price_effective).toBeUndefined();

      // The system's own durable record of "no effects were applied".
      const { rows } = await pool.query('SELECT * FROM lead_receipts');
      expect(rows).toHaveLength(1);
      expect(rows[0].terminal_outcome).toBe('suppressed');
      expect(rows[0].effects_applied).toBe(false);
    });

    it('records an auditable reason that carries no raw contact value', async () => {
      await seedSuppression();
      await processLead(makeCtx({
        first_name: 'Blocked', mobile: SUPPRESSED_MOBILE, email: SUPPRESSED_EMAIL,
      }, rawKey));

      const [lead] = await db.entities.Lead.list('-created_date', 50, 0);
      expect(lead.status_reason_detail).toContain('matched_field=');
      expect(lead.status_reason_detail).toContain('dnc_entry_id=');
      // Invariant 4 and 5: the audit says which field matched and which entry
      // did it, never the value itself.
      expect(lead.status_reason_detail).not.toContain(SUPPRESSED_MOBILE);
      expect(lead.status_reason_detail).not.toContain(SUPPRESSED_EMAIL);
    });

    it('does not create a second lead when the same posting is replayed', async () => {
      await seedSuppression();
      const payload = {
        first_name: 'Blocked', mobile: SUPPRESSED_MOBILE, email: SUPPRESSED_EMAIL,
        _idempotency_key: 'replay-me-once',
      };

      const first = await processLead(makeCtx({ ...payload }, rawKey));
      expect(first.body.lead_status).toBe('rejected');

      const second = await processLead(makeCtx({ ...payload }, rawKey));
      // The receipt already concluded, so the replay is answered from it.
      expect(second.body.acceptance).toBe('duplicate');

      expect(await db.entities.Lead.list('-created_date', 50, 0)).toHaveLength(1);
    });

    it('a stored DNC rejection needs no migration, because the live path already wrote the new vocabulary', async () => {
      await seedSuppression();
      await processLead(makeCtx({
        first_name: 'Blocked', mobile: SUPPRESSED_MOBILE, email: SUPPRESSED_EMAIL,
      }, rawKey));

      const { counts } = await status.backfillLeadStatus(db);
      // Nothing to change: the live path wrote every target value already.
      expect(counts.newly_migrated).toBe(0);
      // It IS examined and confirmed, though, and says so. Finding S2: this
      // used to assert already_migrated 1 and migrated_at undefined, which
      // left a row the migration had looked at and verified looking exactly
      // like one it had never reached.
      expect(counts.verified_consistent).toBe(1);
      expect(counts.already_migrated).toBe(0);

      const [lead] = await db.entities.Lead.list('-created_date', 50, 0);
      expect(lead.migrated_at).toBeTruthy();
      expect(lead.status_reason).toBe(status.STATUS_REASON.REJECTED_DNC);
      // And the values the live path wrote are untouched by the stamp.
      expect(lead.lead_status).toBe(status.LEAD_STATUS.REJECTED);
      expect(lead.final_status).toBe(status.LEGACY_STATUS.REJECTED);

      // A second run is still a no-op: the marker is what makes it idempotent.
      const again = await status.backfillLeadStatus(db);
      expect(again.counts.newly_migrated).toBe(0);
      expect(again.counts.verified_consistent).toBe(0);
      expect(again.counts.already_migrated).toBe(1);
    });
  });

  // ── Adversarial QA finding B1: the migration has an invokable entry point ──
  //
  // Everything above proves the migration is correct. None of it proved the
  // migration could be RUN: nothing in the repository called
  // migrateStatusVocabulary, backfillLeadStatus or backfillConnectorTriggers
  // outside this file, so zero of DashFlo's real leads had any path onto the
  // new vocabulary. server/scripts/migrate-status-vocabulary.js is that path,
  // and these tests drive it the way an operator would.

  describe('the migration entry point an operator actually runs', () => {
    it('reports without writing anything by default, and the plan is the real one', async () => {
      const leads = await seedSyntheticLeads();
      await seedConnectors();

      const snapshot = new Map();
      for (const lead of await db.entities.Lead.list('-created_date', 500, 0)) {
        snapshot.set(lead.id, JSON.stringify(lead));
      }

      const { mode, report, plan } = await migrationScript.runStatusVocabularyMigration(db);

      expect(mode).toBe('report');
      // It decided real work: every mappable lead, plus the connectors.
      expect(report.leads.counts.total).toBe(Object.keys(leads).length);
      expect(report.leads.counts.newly_migrated).toBeGreaterThan(0);
      expect(plan.length).toBeGreaterThan(0);
      expect(plan.every((w) => w.id && w.patch)).toBe(true);
      expect([...new Set(plan.map((w) => w.entity))]).toContain('Lead');

      // And wrote none of it. This is the assertion that matters: a dry run
      // that quietly wrote would be worse than no dry run at all. Compared
      // row by row against the snapshot rather than field by field, so a
      // write to ANY column is caught, not only the ones this unit adds.
      for (const lead of await db.entities.Lead.list('-created_date', 500, 0)) {
        expect(JSON.stringify(lead), `${lead.id} was written during a report run`)
          .toBe(snapshot.get(lead.id));
        expect(lead.migrated_at).toBeUndefined();
      }
      for (const row of await db.entities.ApiConnector.list('-created_date', 500, 0)) {
        expect(row.triggers_migrated_at).toBeUndefined();
      }
    });

    it('writes exactly what it planned when told to apply', async () => {
      const leads = await seedSyntheticLeads();
      await seedConnectors();

      // The same instant for both runs, so the plan and the applied write are
      // compared on their content rather than on which millisecond they ran.
      const at = new Date('2026-09-05T12:00:00.000Z');

      const dry = await migrationScript.runStatusVocabularyMigration(db, { at });
      const planned = new Map(dry.plan
        .filter((w) => w.entity === 'Lead')
        .map((w) => [w.id, w.patch]));

      const applied = await migrationScript.runStatusVocabularyMigration(db, { apply: true, at });
      expect(applied.mode).toBe('apply');
      // In apply mode the writes go to the database, not into the plan array.
      expect(applied.plan).toEqual([]);
      expect(applied.report.leads.counts.newly_migrated).toBe(dry.report.leads.counts.newly_migrated);

      // Every field the dry run said it would write holds that value now.
      for (const [id, patch] of planned) {
        const row = await reload(id);
        for (const [field, value] of Object.entries(patch)) {
          expect(row[field], `${id}.${field}`).toBe(value);
        }
      }
      // And the unmappable lead the plan left out is still untouched.
      expect((await reload(leads.unmappable.id)).lead_status).toBeUndefined();
    });

    it('is safe to run twice, because the underlying migration is', async () => {
      await seedSyntheticLeads();
      await seedConnectors();

      await migrationScript.runStatusVocabularyMigration(db, { apply: true });
      const second = await migrationScript.runStatusVocabularyMigration(db, { apply: true });

      expect(second.report.leads.counts.newly_migrated).toBe(0);
      expect(second.report.leads.counts.verified_consistent).toBe(0);
      expect(second.report.connectors.counts.api_connectors_remapped).toBe(0);
    });

    it('refuses to create or delete a row even in a dry run', async () => {
      // The migration is additive by construction. A future edit that started
      // creating or deleting must not slip past a dry run looking harmless.
      const plan = [];
      const planning = migrationScript.planningDb(db, plan);
      await expect(planning.entities.Lead.create({ final_status: status.LEGACY_STATUS.SOLD }))
        .rejects.toThrow(/must never create a Lead/);
      await expect(planning.entities.ApiConnector.delete('anything'))
        .rejects.toThrow(/must never delete a ApiConnector/);
      expect(plan).toEqual([]);
    });

    it('prints the counts, the exceptions and the verdict a human has to read', async () => {
      await seedSyntheticLeads();
      const result = await migrationScript.runStatusVocabularyMigration(db);
      const summary = migrationScript.formatSummary(result);

      expect(summary).toContain('REPORT ONLY');
      expect(summary).toContain(`scanned                ${result.report.leads.counts.total}`);
      expect(summary).toContain('unmapped');
      expect(summary).toContain('need a human decision');
      // The verdict is stated, and on this fixture it is not clean.
      expect(summary).toContain('CLEAN                             NO');
      // And a report run says plainly that its verification describes today.
      expect(summary).toContain('PRE-migration state');
      expect(summary).toContain('Re-run with --apply');
    });
  });

  // ── Adversarial QA finding B2: the two live webhook paths dual-write ──────
  //
  // Both endpoints create and update Leads and wrote final_status only, so
  // every lead arriving through either of them after this release would have
  // carried a permanently NULL lead_status: invisible to the new vocabulary,
  // and a hole that would only have surfaced when W3-UI-STATUS switched the
  // client over to reading lead_status.
  //
  // These tests run the real handlers against the real database. Each one
  // asserts BOTH halves: the new field is populated AND the existing
  // behaviour of that branch is exactly what it was.

  describe('webhook.js writes the new vocabulary alongside final_status', () => {
    let rawCredential;

    const makeCtx = (body, credential) => {
      const headers = { 'x-api-key': credential };
      return {
        db,
        body,
        env: process.env,
        user: null,
        req: { method: 'POST', headers, query: {} },
        json: (payload, statusCode = 200) => ({ __httpResponse: true, body: payload, status: statusCode }),
      };
    };

    beforeEach(async () => {
      rawCredential = mintApiKey('master');
      await db.entities.ApiKey.create({
        id: 'inbound-webhook-test', name: 'Test master', type: 'master',
        key_hash: hashApiKey(rawCredential), key_prefix: rawCredential.slice(0, 16),
        active: true, request_count: 0,
      });
    });

    it('populates lead_status on a lead it creates, derived from the same final_status', async () => {
      const response = await webhook(makeCtx({
        email: 'created@example.test', first_name: 'Ada',
        lead_status: 'sold', revenue: 250, sid: 'LGNX',
      }, rawCredential));

      expect(response.status).toBe(200);
      expect(response.body.outcome).toBe('created');
      // Existing behaviour, unchanged: the response still reports the legacy
      // value, because the sender and the unmigrated client both read it.
      expect(response.body.final_status).toBe(status.LEGACY_STATUS.SOLD);

      const [lead] = await db.entities.Lead.list('-created_date', 50, 0);
      expect(lead.final_status).toBe(status.LEGACY_STATUS.SOLD);
      expect(lead.lead_status).toBe(status.LEAD_STATUS.SOLD);
      expect(lead.processing_state).toBe(status.PROCESSING_STATE.SETTLED);
      expect(lead.is_qualified).toBe(true);
      // A live write is never a migrated write.
      expect(lead.migrated_at).toBeUndefined();
      // And it carries no migration provenance code, which is what the
      // descriptor fallback would have stamped before this repair.
      expect(status.MIGRATION_ONLY_REASONS).not.toContain(lead.status_reason);
    });

    it('still populates lead_status when the payload names no status at all', async () => {
      // The commonest shape, and the one that would have produced most of the
      // invisible rows: a plain lead post with no lead_status key.
      await webhook(makeCtx({
        email: 'nostatus@example.test', mobile: '5550001111', sid: 'LGNX',
      }, rawCredential));

      const [lead] = await db.entities.Lead.list('-created_date', 50, 0);
      // final_status is exactly what it was before: nothing was passed, so
      // Lead.json's schema default applies. That default is the retiring
      // Processing value, which is precisely why the mirror is derived from
      // it rather than from the undefined the handler passed.
      expect(lead.final_status).toBe(status.LEGACY_STATUS.PROCESSING);
      // Durably saved, nothing settled. D1 calls that queued.
      expect(lead.lead_status).toBe(status.LEAD_STATUS.QUEUED);
      expect(lead.processing_state).toBe(status.PROCESSING_STATE.RECEIVED);
      expect(status.isLeadStatus(lead.lead_status)).toBe(true);
      // Not a provenance code: this lead was created, not migrated from
      // anything.
      expect(status.MIGRATION_ONLY_REASONS).not.toContain(lead.status_reason);
    });

    it('mirrors the new fields onto a lead it updates, without touching `changed`', async () => {
      const seeded = await seedLead({
        final_status: status.LEGACY_STATUS.QUEUED, email: 'update@example.test', revenue: 0,
      });
      expect(seeded.lead_status).toBeUndefined();

      const response = await webhook(makeCtx({
        email: 'update@example.test', lead_status: 'sold', revenue: 250,
      }, rawCredential));

      expect(response.body.outcome).toBe('updated');
      // Existing behaviour: the reported change set is the operator-facing one
      // and must not grow. `changed` drives the response text and it drives
      // the "nothing changed" early return below.
      expect(response.body.changed).toEqual(['revenue', 'final_status']);
      expect(response.body.final_status).toBe(status.LEGACY_STATUS.SOLD);

      const row = await reload(seeded.id);
      expect(row.final_status).toBe(status.LEGACY_STATUS.SOLD);
      expect(row.lead_status).toBe(status.LEAD_STATUS.SOLD);
      expect(row.processing_state).toBe(status.PROCESSING_STATE.SETTLED);
      expect(row.revenue).toBe(250);
    });

    it('changes nothing at all when nothing changed, exactly as before', async () => {
      // The early return is load-bearing: it is what stops a replayed postback
      // bumping leadbyte_outcome_at on every retry. The dual-write must not be
      // able to turn a no-op into a write, so it never pushes onto `changed`.
      const seeded = await seedLead({
        final_status: status.LEGACY_STATUS.SOLD, email: 'noop@example.test', revenue: 100,
      });
      const before = await reload(seeded.id);

      const response = await webhook(makeCtx({
        email: 'noop@example.test', lead_status: 'sold', revenue: 100,
      }, rawCredential));

      expect(response.body.outcome).toBe('duplicate');
      expect(response.body.message).toContain('Nothing changed');
      const after = await reload(seeded.id);
      expect(after.lead_status).toBeUndefined();
      expect(after.leadbyte_outcome_at).toBeUndefined();
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    });

    it('mirrors the STORED status when an outcome post carries none', async () => {
      // A buyer_feedback style post with no lead_status still updates the
      // lead. The mirror follows the value the row will actually hold, so the
      // two fields cannot end up disagreeing.
      const seeded = await seedLead({
        final_status: status.LEGACY_STATUS.SOLD, email: 'feedback@example.test',
      });

      await webhook(makeCtx({
        email: 'feedback@example.test', buyer_feedback: 'Spoke to the customer',
      }, rawCredential));

      const row = await reload(seeded.id);
      expect(row.final_status).toBe(status.LEGACY_STATUS.SOLD);
      expect(row.lead_status).toBe(status.LEAD_STATUS.SOLD);
    });
  });

  describe('leadbyteWebhook.js writes the new vocabulary alongside final_status', () => {
    const ROUTE_TOKEN = 'status-migration-suite-disposable-route-token';

    const makeCtx = (body) => ({
      db,
      body,
      env: process.env,
      user: null,
      req: { method: 'POST', headers: {}, query: { token: ROUTE_TOKEN }, rawBody: JSON.stringify(body) },
      json: (payload, statusCode = 200) => ({ __httpResponse: true, body: payload, status: statusCode }),
    });

    beforeEach(async () => {
      await db.entities.InboundWebhookRoute.create({
        name: 'LeadByte outcomes', enabled: true, provider: 'leadbyte',
        token_hash: sha256Hex(ROUTE_TOKEN),
      });
    });

    it('populates lead_status on a lead it creates from an outcome payload', async () => {
      const response = await leadbyteWebhook(makeCtx({
        lead_status: 'sold', contact_email: 'lb-created@example.test',
        lead_revenue: 300, leadbyte_id: 9001, supplier_sid: 'INBNDS',
      }));

      expect(response.status).toBe(200);
      expect(response.body.created).toBe(true);
      // Existing behaviour: the response still reports the legacy value.
      expect(response.body.final_status).toBe(status.LEGACY_STATUS.SOLD);

      const [lead] = await db.entities.Lead.list('-created_date', 50, 0);
      expect(lead.final_status).toBe(status.LEGACY_STATUS.SOLD);
      expect(lead.lead_status).toBe(status.LEAD_STATUS.SOLD);
      expect(lead.processing_state).toBe(status.PROCESSING_STATE.SETTLED);
      expect(lead.is_qualified).toBe(true);
      expect(lead.migrated_at).toBeUndefined();
    });

    it('still populates lead_status when the payload status maps to nothing', async () => {
      await leadbyteWebhook(makeCtx({
        lead_status: 'a-status-this-endpoint-does-not-map',
        contact_email: 'lb-nostatus@example.test', leadbyte_id: 9002,
      }));

      const [lead] = await db.entities.Lead.list('-created_date', 50, 0);
      // Unchanged: an unmapped status means this endpoint writes no
      // final_status, so Lead.json's schema default applies, and that default
      // is the retiring Processing value.
      expect(lead.final_status).toBe(status.LEGACY_STATUS.PROCESSING);
      expect(lead.lead_status).toBe(status.LEAD_STATUS.QUEUED);
      expect(lead.processing_state).toBe(status.PROCESSING_STATE.RECEIVED);
      expect(status.MIGRATION_ONLY_REASONS).not.toContain(lead.status_reason);
    });

    it('mirrors an accepted upgrade on the update branch', async () => {
      const seeded = await seedLead({
        final_status: status.LEGACY_STATUS.UNSOLD,
        email: 'lb-upgrade@example.test', email_normalized: 'lb-upgrade@example.test',
      });

      await leadbyteWebhook(makeCtx({
        lead_status: 'sold', contact_email: 'lb-upgrade@example.test', lead_revenue: 450,
      }));

      const row = await reload(seeded.id);
      expect(row.final_status).toBe(status.LEGACY_STATUS.SOLD);
      expect(row.lead_status).toBe(status.LEAD_STATUS.SOLD);
    });

    it('FOLLOWS the precedence guard instead of going around it', async () => {
      // The guard deletes patch.final_status when an outcome would downgrade a
      // lead. Mirroring before it ran would have written the downgrade into
      // lead_status anyway, so this endpoint would have blocked the downgrade
      // in the field the client reads today and allowed it in the field the
      // client is about to start reading. That is the whole reason the mirror
      // is computed after the guard.
      const seeded = await seedLead({
        final_status: status.LEGACY_STATUS.SOLD, revenue: 500,
        email: 'lb-downgrade@example.test', email_normalized: 'lb-downgrade@example.test',
      });

      const response = await leadbyteWebhook(makeCtx({
        lead_status: 'unsold', contact_email: 'lb-downgrade@example.test',
      }));

      // Existing behaviour, unchanged: the downgrade is refused.
      expect(response.body.final_status).toBe(status.LEGACY_STATUS.SOLD);
      const row = await reload(seeded.id);
      expect(row.final_status).toBe(status.LEGACY_STATUS.SOLD);
      // And the new field agrees with it rather than with the payload.
      expect(row.lead_status).toBe(status.LEAD_STATUS.SOLD);
      expect(row.lead_status).not.toBe(status.LEAD_STATUS.UNSOLD);
    });

    it('gives a collapsed duplicate the rejected vocabulary and the link to its survivor', async () => {
      const survivor = await seedLead({
        final_status: status.LEGACY_STATUS.SOLD, revenue: 400,
        email: 'lb-dupe@example.test', email_normalized: 'lb-dupe@example.test',
        created_date: '2026-08-01T09:00:00.000Z',
      });
      const loser = await seedLead({
        final_status: status.LEGACY_STATUS.UNSOLD,
        email: 'lb-dupe@example.test', email_normalized: 'lb-dupe@example.test',
        created_date: '2026-08-02T09:00:00.000Z',
      });

      await leadbyteWebhook(makeCtx({
        lead_status: 'sold', contact_email: 'lb-dupe@example.test', lead_revenue: 400,
      }));

      const collapsed = await reload(loser.id);
      // Existing behaviour, unchanged.
      expect(collapsed.final_status).toBe(status.LEGACY_STATUS.DUPLICATE);
      expect(collapsed.archived).toBe(true);
      expect(JSON.parse(collapsed.mapped_fields).merged_into).toBe(survivor.id);
      // New: D4 maps the retiring Duplicate value onto rejected with
      // REJECTED_DUPLICATE, and the survivor is the link D4 asks for, known
      // here for free. Without this these would have been the only leads
      // reaching rejected with no lead_status at all.
      expect(collapsed.lead_status).toBe(status.LEAD_STATUS.REJECTED);
      expect(collapsed.status_reason).toBe(status.STATUS_REASON.REJECTED_DUPLICATE);
      expect(collapsed.duplicate_of_lead_id).toBe(survivor.id);
    });

    it('leaves nothing for the migration to do, which is the point of the dual-write', async () => {
      // The end-to-end statement of finding B2: a lead born on a live webhook
      // path is already on the new vocabulary, so the migration finds it
      // consistent rather than finding it invisible.
      await leadbyteWebhook(makeCtx({
        lead_status: 'sold', contact_email: 'lb-nomigration@example.test',
        lead_revenue: 200, leadbyte_id: 9003,
      }));

      const report = await status.migrateStatusVocabulary(db);
      expect(report.leads.counts.newly_migrated).toBe(0);
      expect(report.leads.counts.verified_consistent).toBe(1);
      expect(report.leads.counts.unmapped).toBe(0);
      expect(report.verification.clean).toBe(true);
    });
  });
});
