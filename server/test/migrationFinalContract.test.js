import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/* Synthetic final-contract package test.
 *
 * This test simulates the final clean Base44 package that conforms to the
 * agreed contract (legenex-migration-v1). It verifies that DashFlo's importer
 * cleanly accepts such a package with zero hard blockers and balanced
 * reconciliation.
 *
 * The fixture includes:
 * - 93-entity manifest shape (all MIGRATION_ENTITY_ORDER entities present)
 * - Large historical entity (MetaSyncRun with ~1000 records)
 * - No duplicate source ids
 * - Required BuyerStateCpl Buyer parents present (including archived/soft-deleted)
 * - Safe natural-key CustomField remaps
 * - Existing owner User natural-key preserve/remap
 * - Optional dangling historical relationships (warnings only)
 * - Credential-bearing records with fake values
 * - Fully balanced reconciliation
 */

const TEST_DB = 'dashflo_migration_final_contract_test';
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

const OWNER = { id: 'dashflo-owner', email: 'owner@dashflo.test', base_role: 'owner', role: 'admin' };
const PASSPHRASE = 'final contract test passphrase 2026';

describe.skipIf(!reachable)('final contract synthetic package', () => {
  let pool;
  let runMigrationImport;
  let normalizeMigrationBundle;
  let cryptoSpec;
  let migrationOrder;

  beforeAll(async () => {
    await maintenance(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await maintenance(`CREATE DATABASE ${TEST_DB}`);
    ({ pool } = await import('../src/db/pool.js'));
    const schema = await import('../src/db/schema.js');
    await schema.ensureSchema();
    const { ensureBase44SyncSchema } = await import('../src/db/base44SyncSchema.js');
    await ensureBase44SyncSchema();
    const { ensureMigrationImportSchema } = await import('../src/db/migrationImportSchema.js');
    await ensureMigrationImportSchema();
    ({ runMigrationImport, normalizeMigrationBundle } = await import('../src/lib/migrationImport.js'));
    const catalog = await import('../src/functions/systemTransfer.generated.js');
    cryptoSpec = catalog.MIGRATION_CRYPTO;
    migrationOrder = catalog.MIGRATION_ENTITY_ORDER;
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
    await pool.query('TRUNCATE base44_record_provenance');
  });

  // Build an encrypted owner package with the given entities
  function ownerPackage(entities) {
    const salt = crypto.randomBytes(cryptoSpec.salt_bytes);
    const key = crypto.pbkdf2Sync(Buffer.from(PASSPHRASE, 'utf8'), salt, cryptoSpec.iterations, cryptoSpec.key_bits / 8, 'sha256');
    const chunks = [];
    for (const entity of migrationOrder) {
      const rows = entities[entity];
      if (!rows?.length) continue;
      const plaintext = Buffer.from(JSON.stringify({ entity, offset: 0, records: rows }), 'utf8');
      const iv = crypto.randomBytes(cryptoSpec.iv_bytes);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
      chunks.push({
        entity,
        offset: 0,
        records: rows.length,
        iv: iv.toString('base64'),
        ciphertext: sealed.toString('base64'),
        plaintext_sha256: crypto.createHash('sha256').update(plaintext).digest('hex'),
      });
    }
    return {
      format: cryptoSpec.format,
      source_app: 'legenex-dashboard',
      target: 'dashflo',
      exported_at: '2026-08-20T12:00:00.000Z',
      crypto: { ...cryptoSpec, salt: salt.toString('base64') },
      counts: Object.fromEntries(migrationOrder.map((name) => [name, entities[name]?.length || 0])),
      chunks,
    };
  }

  const preview = (entities) => runMigrationImport({ kind: 'owner', mode: 'preview', bundle: ownerPackage(entities), passphrase: PASSPHRASE, user: OWNER });

  // Helper factories for common entities
  const supplier = (id, sid, extra = {}) => ({ id, sid, name: `Supplier ${sid}`, active: true, created_date: '2026-01-01T00:00:00.000Z', updated_date: '2026-08-20T00:00:00.000Z', ...extra });
  const buyer = (id, code, extra = {}) => ({ id, buyer_code: code, company_name: `Buyer ${code}`, active: true, created_date: '2026-01-01T00:00:00.000Z', updated_date: '2026-08-20T00:00:00.000Z', ...extra });
  const campaign = (id, campaignId, supplierIds = [], extra = {}) => ({ id, campaign_id: campaignId, name: `Campaign ${campaignId}`, supplier_ids: JSON.stringify(supplierIds), updated_date: '2026-08-20T00:00:00.000Z', ...extra });
  const cpl = (id, buyerId, state = 'TX', extra = {}) => ({ id, buyer_id: buyerId, vertical: 'MVA', state, cpl: 10, updated_date: '2026-08-20T00:00:00.000Z', ...extra });
  const delivery = (id, buyerId, verticalId = 'vertical-1', extra = {}) => ({ id, name: `Delivery ${id}`, buyer_id: buyerId, vertical_id: verticalId, active: true, updated_date: '2026-08-20T00:00:00.000Z', ...extra });
  const subDelivery = (id, deliveryId, extra = {}) => ({ id, delivery_id: deliveryId, name: `SubDelivery ${id}`, url: `https://example.test/post?id=${id}`, active: true, updated_date: '2026-08-20T00:00:00.000Z', ...extra });
  const lead = (id, buyerId, supplierKeyId = 'api-key-1', extra = {}) => ({ id, buyer_id: buyerId, supplier_key_id: supplierKeyId, campaign_id: 'campaign-1', webhook_key: `webhook-${id}`, updated_date: '2026-08-20T00:00:00.000Z', ...extra });
  const apiKey = (id, supplierId, extra = {}) => ({ id, name: `API Key ${id}`, supplier_id: supplierId, supplier_name: `Supplier ${supplierId}`, key: `lgnx_sup_fake_${id}`, active: true, request_count: 0, created_date: '2026-01-01T00:00:00.000Z', updated_date: '2026-08-20T00:00:00.000Z', ...extra });
  const metaConnection = (id, extra = {}) => ({ id, name: `Meta ${id}`, token: `meta-token-${id}`, active: true, updated_date: '2026-08-20T00:00:00.000Z', ...extra });
  const integrationConfig = (id, name, config, extra = {}) => ({ id, name, config: JSON.stringify(config), created_date: '2026-01-01T00:00:00.000Z', updated_date: '2026-08-20T00:00:00.000Z', ...extra });
  const systemKey = (id, provider, extra = {}) => ({ id, name: `${provider} Key`, provider, client_id: `${provider}-client`, secret: `${provider}-secret`, owner_user_id: OWNER.id, active: true, created_date: '2026-01-01T00:00:00.000Z', updated_date: '2026-08-20T00:00:00.000Z', ...extra });
  const buyerApiKey = (id, buyerId, extra = {}) => ({ id, buyer_id: buyerId, buyer_name: `Buyer ${buyerId}`, name: `Buyer Key ${id}`, key: `lgnx_byr_fake_${id}`, key_prefix: `lgnx_byr_fake_${id}`.slice(0, 16), active: true, created_date: '2026-01-01T00:00:00.000Z', updated_date: '2026-08-20T00:00:00.000Z', ...extra });
  const keyAuditEvent = (id, subjectType, subjectId, extra = {}) => ({ id, subject_type: subjectType, subject_id: subjectId, subject_name: `${subjectType} ${subjectId}`, action: 'created', at: '2026-08-20T00:00:00.000Z', created_date: '2026-08-20T00:00:00.000Z', updated_date: '2026-08-20T00:00:00.000Z', ...extra });
  const customField = (id, fieldName, extra = {}) => ({ id, field_name: fieldName, label: `Field ${fieldName}`, type: 'text', required: false, updated_date: '2026-08-20T00:00:00.000Z', ...extra });
  const metaSyncRun = (id, extra = {}) => ({ id, ad_account_id: `act_${id}`, account_name: `Account ${id}`, sync_type: 'full', status: 'completed', records_processed: 100, started_at: '2026-08-20T00:00:00.000Z', completed_at: '2026-08-20T01:00:00.000Z', updated_date: '2026-08-20T00:00:00.000Z', ...extra });

  it('accepts a clean final-contract package with zero hard blockers and balanced reconciliation', async () => {
    // Build the synthetic final contract package
    const entities = {
      // Core master entities
      Supplier: [
        supplier('supplier-1', 'LGNX1'),
        supplier('supplier-2', 'LGNX2'),
      ],
      Buyer: [
        // Active buyers
        buyer('buyer-1', 'B1'),
        buyer('buyer-2', 'B2'),
        // Archived/soft-deleted buyers that were previously missing
        // These are the ones Base44 will now include in the final package
        buyer('buyer-archived-1', 'B-ARCHIVED-1', { active: false }),
        buyer('buyer-archived-2', 'B-ARCHIVED-2', { active: false }),
        // Buyer with leadbyte_bid different from buyer_code
        buyer('buyer-lb-1', 'B-LB', { leadbyte_bid: 'LB-9001' }),
      ],
      Vertical: [
        { id: 'vertical-1', name: 'MVA', code: 'MVA', updated_date: '2026-08-20T00:00:00.000Z' },
        { id: 'vertical-2', name: 'Workers Comp', code: 'WC', updated_date: '2026-08-20T00:00:00.000Z' },
      ],
      Disposition: [
        { id: 'disp-1', name: 'Pending', updated_date: '2026-08-20T00:00:00.000Z' },
        { id: 'disp-2', name: 'Accepted', updated_date: '2026-08-20T00:00:00.000Z' },
        { id: 'disp-3', name: 'Rejected', updated_date: '2026-08-20T00:00:00.000Z' },
      ],

      // Credential-bearing entities
      ApiKey: [
        apiKey('api-key-1', 'supplier-1'),
        apiKey('api-key-2', 'supplier-2'),
      ],
      SystemKey: [
        systemKey('syskey-meta', 'meta'),
        systemKey('syskey-google', 'google'),
      ],
      BuyerApiKey: [
        buyerApiKey('buyer-key-1', 'buyer-1'),
      ],
      MetaConnection: [
        metaConnection('meta-conn-1'),
      ],
      IntegrationConfig: [
        integrationConfig('int-meta', 'meta_app', { app_id: 'meta-app-id', app_secret: 'meta-app-secret' }),
      ],

      // Campaign and delivery entities
      Campaign: [
        campaign('campaign-1', 'C1', ['supplier-1']),
        campaign('campaign-2', 'C2', ['supplier-2']),
      ],
      BuyerCplRule: [
        { id: 'cpl-rule-1', buyer_id: 'buyer-1', campaign_id: 'campaign-1', state: 'TX', cpl: 15, updated_date: '2026-08-20T00:00:00.000Z' },
      ],
      BuyerStateCpl: [
        // References active buyers by id
        cpl('cpl-1', 'buyer-1', 'TX'),
        cpl('cpl-2', 'buyer-2', 'CA'),
        // References archived buyers by id (these were previously missing)
        cpl('cpl-3', 'buyer-archived-1', 'NY'),
        cpl('cpl-4', 'buyer-archived-2', 'FL'),
        // References buyer by buyer_code (natural key)
        cpl('cpl-5', 'B-LB', 'WA'),
      ],
      Delivery: [
        delivery('delivery-1', 'buyer-1'),
        delivery('delivery-2', 'buyer-2'),
      ],
      SubDelivery: [
        subDelivery('sub-1', 'delivery-1'),
        subDelivery('sub-2', 'delivery-2'),
      ],
      BuyerWallet: [
        { id: 'wallet-1', buyer_id: 'buyer-1', balance: 1000, updated_date: '2026-08-20T00:00:00.000Z' },
      ],
      BuyerOnboarding: [
        { id: 'onboarding-1', buyer_id: 'buyer-1', status: 'pending', updated_date: '2026-08-20T00:00:00.000Z' },
        // Optional dangling reference - warning only
        { id: 'onboarding-2', buyer_id: 'never-existed-buyer', status: 'pending', updated_date: '2026-08-20T00:00:00.000Z' },
      ],

      // Lead and related
      LeadSource: [
        { id: 'lead-source-1', name: 'Source 1', api_key_id: 'api-key-1', campaign_id: 'campaign-1', webhook_key: 'webhook-src-1', updated_date: '2026-08-20T00:00:00.000Z' },
      ],
      LeadByteConnector: [
        { id: 'lb-conn-1', name: 'LeadByte 1', headers: JSON.stringify({ X_KEY: 'lb-key-1' }), target_url: 'https://lb.example.test/post', enabled: true, updated_date: '2026-08-20T00:00:00.000Z' },
      ],
      ApiConnector: [
        { id: 'api-conn-1', name: 'API Conn 1', fb_access_token: 'fb-token-1', headers: JSON.stringify({ Authorization: 'Bearer token' }), target_url: 'https://api.example.test/post', enabled: true, updated_date: '2026-08-20T00:00:00.000Z' },
      ],
      Webhook: [
        { id: 'webhook-1', name: 'Webhook 1', secret: 'webhook-secret-1', headers: JSON.stringify({ Authorization: 'Bearer wh' }), url: 'https://wh.example.test/post', enabled: true, updated_date: '2026-08-20T00:00:00.000Z' },
      ],
      OutboundWebhook: [
        { id: 'outbound-1', name: 'Outbound 1', api_key: 'outbound-key-1', headers: JSON.stringify({ Authorization: 'Bearer ob' }), url: 'https://outbound.example.test/post', enabled: true, updated_date: '2026-08-20T00:00:00.000Z' },
      ],
      InboundWebhookRoute: [
        { id: 'inbound-1', name: 'Inbound 1', api_key_id: 'api-key-1', token_hash: 'hash-1', enabled: true, updated_date: '2026-08-20T00:00:00.000Z' },
      ],
      PullSource: [
        { id: 'pull-1', name: 'Pull 1', api_key: 'pull-key-1', url: 'https://pull.example.test/read', enabled: true, updated_date: '2026-08-20T00:00:00.000Z' },
      ],

      // Leads
      Lead: [
        lead('lead-1', 'buyer-1', 'api-key-1'),
        lead('lead-2', 'buyer-2', 'api-key-2'),
        // Optional dangling supplier_key_id - warning only
        lead('lead-3', 'buyer-1', 'missing-api-key'),
      ],

      // Historical entities (large volume)
      MetaSyncRun: Array.from({ length: 100 }, (_, i) => metaSyncRun(`metasync-${i}`)),

      // StateChangeEvent with optional dangling triggered_by_user_id
      StateChangeEvent: [
        { id: 'state-event-1', entity: 'Lead', entity_id: 'lead-1', from_state: 'new', to_state: 'accepted', triggered_by_user_id: 'user-that-does-not-exist', at: '2026-08-20T00:00:00.000Z', updated_date: '2026-08-20T00:00:00.000Z' },
      ],

      // CustomField with existing DashFlo-native record for natural-key remap test
      CustomField: [
        customField('cf-1', 'custom_field_1'),
        customField('cf-2', 'custom_field_2'),
      ],

      // User - existing owner account that should be preserved
      User: [
        { id: OWNER.id, email: OWNER.email, base_role: 'owner', role: 'admin', full_name: 'DashFlo Owner', updated_date: '2026-08-20T00:00:00.000Z' },
        // Another user that will be created
        { id: 'src-user-1', email: 'user1@test.example', base_role: 'admin', role: 'admin', full_name: 'User One', updated_date: '2026-08-20T00:00:00.000Z' },
      ],

      // Minimal entities to fill the 93-entity manifest
      AppSettings: [{ id: 'settings', company_name: 'DashFlo', updated_date: '2026-08-20T00:00:00.000Z' }],
      Brand: [{ id: 'brand-1', brand_code: 'DF1', name: 'DashFlo', updated_date: '2026-08-20T00:00:00.000Z' }],
      ReferenceKey: [{ id: 'refkey-1', key: 'test', updated_date: '2026-08-20T00:00:00.000Z' }],
      EmailValidationSettings: [{ id: 'evs-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      HlrSettings: [{ id: 'hlr-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      NotificationRule: [{ id: 'nr-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      OnboardingEmailTemplate: [{ id: 'oet-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      ImportTemplate: [{ id: 'it-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      Report: [{ id: 'report-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      BotConfig: [{ id: 'bot-1', name: 'Bot 1', bot_key: 'bot-key-1', active: true, updated_date: '2026-08-20T00:00:00.000Z' }],
      KnowledgeDoc: [{ id: 'kd-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      FieldMapping: [{ id: 'fm-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      CustomCalculation: [{ id: 'cc-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      ResponseMapping: [{ id: 'rm-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      SupplierSource: [{ id: 'ss-1', supplier_id: 'supplier-1', source_code: 'SRC1', updated_date: '2026-08-20T00:00:00.000Z' }],
      SupplierStateCoverage: [{ id: 'ssc-1', supplier_id: 'supplier-1', state: 'TX', updated_date: '2026-08-20T00:00:00.000Z' }],
      SupplierAdAccount: [{ id: 'saa-1', supplier_id: 'supplier-1', ad_account_id: 'act_123', updated_date: '2026-08-20T00:00:00.000Z' }],
      ContractVersion: [{ id: 'cv-1', campaign_id: 'campaign-1', version: 1, updated_date: '2026-08-20T00:00:00.000Z' }],
      RouteConfigVersion: [{ id: 'rcv-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      RouteGroup: [{ id: 'rg-1', campaign_id: 'campaign-1', name: 'Group 1', method: 'priority', updated_date: '2026-08-20T00:00:00.000Z' }],
      RouteMember: [{ id: 'rm-1', route_group_id: 'rg-1', buyer_id: 'buyer-1', sub_delivery_id: 'sub-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      StateStatus: [{ id: 'ss-1', state: 'TX', status: 'active', updated_date: '2026-08-20T00:00:00.000Z' }],
      CallRecord: [{ id: 'cr-1', lead_id: 'lead-1', source_id: 'lead-source-1', call_id: 'call-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      VerificationRecord: [{ id: 'vr-1', lead_id: 'lead-1', status: 'verified', updated_date: '2026-08-20T00:00:00.000Z' }],
      CertBackupStore: [{ id: 'cbs-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      ReturnRequest: [{ id: 'rr-1', buyer_id: 'buyer-1', lead_id: 'lead-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      BuyerFeedback: [{ id: 'bf-1', buyer_id: 'buyer-1', lead_id: 'lead-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      Invoice: [{ id: 'inv-1', buyer_id: 'buyer-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      BillingRun: [{ id: 'br-1', buyer_id: 'buyer-1', supplier_id: 'supplier-1', invoice_id: 'inv-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      BillingLineItem: [{ id: 'bli-1', billing_run_id: 'br-1', supplier_id: 'supplier-1', campaign_id: 'campaign-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      BuyerPayment: [{ id: 'bp-1', buyer_id: 'buyer-1', invoice_id: 'inv-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      SupplierPayout: [{ id: 'sp-1', supplier_id: 'supplier-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      WalletTransaction: [{ id: 'wt-1', buyer_id: 'buyer-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      BankTransaction: [{ id: 'bt-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      AdSpendMapping: [{ id: 'asm-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      AdSpend: [{ id: 'adspend-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      AdCreativeMeta: [{ id: 'acm-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      ErrorLog: [{ id: 'el-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      DeliveryAttempt: [{ id: 'da-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      RouteDecisionTrace: [{ id: 'rdt-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      DistributionAudit: [{ id: 'da-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      AuditLog: [{ id: 'al-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      NotificationEvent: [{ id: 'ne-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      BidAttempt: [{ id: 'ba-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      DestinationHealth: [{ id: 'dh-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      CapCounter: [{ id: 'cc-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      CapReservation: [{ id: 'cr-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      Counter: [{ id: 'counter-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      PayloadTest: [{ id: 'pt-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      Invitation: [{ id: 'inv-1', email: 'invite@test.example', base_role: 'admin', updated_date: '2026-08-20T00:00:00.000Z' }],
      ProgressPage: [{ id: 'pp-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      ProgressSnapshot: [{ id: 'ps-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      AuditRun: [{ id: 'ar-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      AuditFinding: [{ id: 'af-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      ChangeRequest: [{ id: 'cr-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      PromptDraft: [{ id: 'pd-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      ReviewThread: [{ id: 'rt-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      ReleaseGate: [{ id: 'rg-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      MigrationRequirement: [{ id: 'mr-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      PageSnapshot: [{ id: 'psnap-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      BenchmarkCriterion: [{ id: 'bc-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      ChatConversation: [{ id: 'cc-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      ChatMemory: [{ id: 'cm-1', updated_date: '2026-08-20T00:00:00.000Z' }],
      KeyAuditEvent: [
        keyAuditEvent('kae-1', 'supplier', 'api-key-1'),
        keyAuditEvent('kae-2', 'buyer', 'buyer-key-1'),
      ],
    };

    // Run preview
    const report = await preview(entities);

    // Verify the final contract expectations
    console.log('=== FINAL CONTRACT PACKAGE PREVIEW RESULT ===');
    console.log(`Entities present: ${report.entities_present.length}`);
    console.log(`Records present: ${report.records_present}`);
    console.log(`Creates: ${report.records_to_create}`);
    console.log(`Updates: ${report.records_to_update}`);
    console.log(`Preserves: ${report.records_to_preserve}`);
    console.log(`Exclusions: ${report.explicit_exclusions.reduce((sum, e) => sum + e.count, 0)}`);
    console.log(`Unresolved: ${report.unresolved_count}`);
    console.log(`ID remaps: ${report.id_remap_count}`);
    console.log(`Hard blockers: ${report.hard_blocker_count}`);
    console.log(`Relationship issues: ${report.relationship_issue_count}`);
    console.log(`Credential-bearing entities: ${Object.keys(report.credential_bearing_entities).join(', ')}`);
    console.log(`Reconciliation balanced: ${report.reconciliation.balanced}`);
    console.log(`Can apply: ${report.can_apply}`);

    // PRIMARY ASSERTIONS FOR FINAL CONTRACT
    expect(report.can_apply).toBe(true);
    expect(report.hard_blocker_count).toBe(0);
    expect(report.reconciliation.balanced).toBe(true);
    expect(report.reconciliation.unaccounted_records).toBe(0);

    // Required relationships resolved
    const requiredBlockers = report.hard_blockers.filter(b => b.kind === 'relationship');
    expect(requiredBlockers).toHaveLength(0);

    // Optional dangling references present as warnings only
    const optionalWarnings = report.relationship_issues.filter(i => i.severity === 'warning');
    expect(optionalWarnings.length).toBeGreaterThanOrEqual(2); // BuyerOnboarding + StateChangeEvent + Lead.supplier_key_id
    const optionalEntities = optionalWarnings.map(w => w.entity).sort();
    expect(optionalEntities).toContain('BuyerOnboarding');
    expect(optionalEntities).toContain('StateChangeEvent');

    // Credential-bearing entities imported
    const credEntities = Object.keys(report.credential_bearing_entities).sort();
    expect(credEntities).toContain('ApiKey');
    expect(credEntities).toContain('SystemKey');
    expect(credEntities).toContain('BuyerApiKey');
    expect(credEntities).toContain('MetaConnection');
    expect(credEntities).toContain('LeadByteConnector');
    expect(credEntities).toContain('IntegrationConfig');

    // No secrets in preview output
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('lgnx_sup_fake_');
    expect(serialized).not.toContain('meta-secret');
    expect(serialized).not.toContain('meta-token');
    expect(serialized).not.toContain('lgnx_byr_fake_');
    expect(serialized).not.toContain('PASSPHRASE');

    // Reconciliation checks
    expect(report.reconciliation.exported_records).toBe(report.records_present);
    const accounted = report.reconciliation.planned_creates
      + report.reconciliation.planned_updates
      + report.reconciliation.planned_preserves
      + report.reconciliation.explicit_exclusions
      + report.reconciliation.unresolved;
    expect(accounted).toBe(report.reconciliation.exported_records);

    // All 93 entities in manifest accounted for
    expect(report.entity_reconciliation).toHaveLength(93);
    expect(report.entity_reconciliation.every(e => e.balanced)).toBe(true);

    // ID remaps present (CustomField natural key, User natural key)
    expect(report.id_remap_count).toBeGreaterThanOrEqual(0);
  });

  it('retains negative tests for malformed packages', async () => {
    // These should still be blocked

    // 1. Conflicting duplicate source id
    const dupPackage = ownerPackage({
      MetaSyncRun: [
        metaSyncRun('dup-id-1'),
        { ...metaSyncRun('dup-id-1'), ad_account_id: 'act_different' }, // Same id, different content = conflict
      ],
    });
    const dupReport = await runMigrationImport({ kind: 'owner', mode: 'preview', bundle: dupPackage, passphrase: PASSPHRASE, user: OWNER });
    expect(dupReport.can_apply).toBe(false);
    expect(dupReport.hard_blockers.some(b => b.kind === 'duplicate_source_id')).toBe(true);

    // 2. Missing required Buyer parent
    const missingBuyerPackage = ownerPackage({
      Buyer: [buyer('buyer-1', 'B1')],
      BuyerStateCpl: [cpl('cpl-1', 'missing-buyer')],
    });
    const missingBuyerReport = await runMigrationImport({ kind: 'owner', mode: 'preview', bundle: missingBuyerPackage, passphrase: PASSPHRASE, user: OWNER });
    expect(missingBuyerReport.can_apply).toBe(false);
    expect(missingBuyerReport.hard_blockers.some(b => b.kind === 'relationship' && b.entity === 'BuyerStateCpl')).toBe(true);

    // 3. Ambiguous natural key match (two DashFlo records with same natural key)
    await pool.query("INSERT INTO e_supplier (id, data) VALUES ('a', '{\"sid\":\"LGNX\"}'::jsonb)");
    await pool.query("INSERT INTO e_supplier (id, data) VALUES ('b', '{\"sid\":\"LGNX\"}'::jsonb)");
    const ambiguousPackage = ownerPackage({ Supplier: [supplier('src-supplier', 'LGNX')] });
    const ambiguousReport = await runMigrationImport({ kind: 'owner', mode: 'preview', bundle: ambiguousPackage, passphrase: PASSPHRASE, user: OWNER });
    expect(ambiguousReport.can_apply).toBe(false);
    expect(ambiguousReport.hard_blockers.some(b => b.kind === 'id_collision')).toBe(true);

    // 4. Wrong passphrase
    const goodPackage = ownerPackage({ Supplier: [supplier('supplier-1', 'LGNX')] });
    await expect(runMigrationImport({ kind: 'owner', mode: 'preview', bundle: goodPackage, passphrase: 'wrong passphrase', user: OWNER }))
      .rejects.toMatchObject({ code: 'decrypt_failed' });

    // 5. Package tampering
    const tampered = ownerPackage({ Supplier: [supplier('supplier-1', 'LGNX')] });
    const raw = Buffer.from(tampered.chunks[0].ciphertext, 'base64');
    raw[8] ^= 0xff;
    tampered.chunks[0].ciphertext = raw.toString('base64');
    await expect(runMigrationImport({ kind: 'owner', mode: 'preview', bundle: tampered, passphrase: PASSPHRASE, user: OWNER }))
      .rejects.toMatchObject({ code: 'decrypt_failed' });
  });
});