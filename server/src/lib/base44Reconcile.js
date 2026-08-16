// Base44 to DashFlo reconciliation.
//
// Count equality is not proof of a correct migration. Two systems can hold the
// same number of records and disagree about every one of them, and a migration
// that loses one paid lead and gains one junk row reconciles perfectly on
// counts alone. So this compares identifiers, not totals.
//
// What it produces, per entity:
//   - source and local counts
//   - ids present only in Base44   (never imported, or imported then deleted)
//   - ids present only in DashFlo  (created natively, or deleted upstream)
//   - records whose source updated_date is newer than the last import
//   - records flagged as conflicts by the sync
//
// Output safety
// -------------
// The `ids` op returns only { id, updated_date }, so no field value is ever
// pulled here. Nothing in this module reads a credential field, and the report
// carries identifiers and counts only. That is deliberate: a reconciliation
// report is a file that gets pasted into issues and sent to people.

import { pool } from '../db/pool.js';
import { tableName, entityNames } from '../schemas/index.js';
import { Base44Source, base44ConfigFromEnv, isConfigured } from './base44Source.js';
import { syncableEntities, NEVER_SYNCED_ENTITIES, DASHFLO_OWNED_ENTITIES } from './base44Sync.js';
import { ensureBase44SyncSchema } from '../db/base44SyncSchema.js';

const PAGE = 500;
// Beyond this an entity is summarised by counts rather than by a full id set,
// so reconciliation cannot itself become an unbounded memory consumer.
const MAX_IDS = 50_000;

// Only non-secret, migration-significant fields are compared. Reconciliation
// reports are routinely pasted into tickets, so credential fields and freeform
// connector blobs are intentionally absent even when they are durable.
const IMPORTANT_FIELDS = {
  Lead: ['status', 'supplier_key_id', 'buyer_id', 'campaign_id', 'lead_id'],
  Supplier: ['name', 'sid', 'active', 'vertical'],
  Buyer: ['company_name', 'buyer_code', 'active', 'status'],
  ApiKey: ['supplier_id', 'type', 'active'],
  SystemKey: ['name', 'provider', 'env_var', 'active'],
  BuyerApiKey: ['buyer_id', 'name', 'active'],
  Campaign: ['campaign_id', 'name', 'status', 'active'],
  RouteGroup: ['campaign_id', 'name', 'status', 'active', 'config_version_id'],
  RouteMember: ['route_group_id', 'buyer_id', 'sub_delivery_id', 'destination_id', 'active'],
  RouteConfigVersion: ['campaign_id', 'route_group_id', 'version', 'status'],
  Delivery: ['buyer_id', 'vertical_id', 'active'],
  SubDelivery: ['delivery_id', 'name', 'active'],
  IntegrationConfig: ['name'],
  LeadByteConnector: ['name', 'enabled', 'is_default'],
  MetaConnection: ['name', 'platform', 'auth_type', 'status', 'connected_account_id'],
  Invoice: ['buyer_id', 'status', 'total', 'invoice_number'],
  BillingRun: ['buyer_id', 'supplier_id', 'invoice_id', 'status'],
  BillingLineItem: ['billing_run_id', 'supplier_id', 'campaign_id', 'amount'],
  BuyerPayment: ['buyer_id', 'invoice_id', 'status', 'amount'],
  SupplierPayout: ['supplier_id', 'status', 'amount'],
  WalletTransaction: ['buyer_id', 'type', 'amount'],
  ReturnRequest: ['buyer_id', 'lead_id', 'status'],
  BuyerFeedback: ['buyer_id', 'lead_id', 'status'],
};

const RELATIONSHIP_FIELDS = {
  Lead: ['supplier_key_id'],
  ApiKey: ['supplier_id'],
  BuyerApiKey: ['buyer_id'],
  RouteGroup: ['campaign_id', 'config_version_id'],
  RouteMember: ['route_group_id', 'buyer_id', 'sub_delivery_id', 'destination_id'],
  RouteConfigVersion: ['campaign_id', 'route_group_id'],
  Delivery: ['buyer_id', 'vertical_id'],
  SubDelivery: ['delivery_id'],
  Invoice: ['buyer_id'],
  BillingRun: ['buyer_id', 'supplier_id', 'invoice_id'],
  BillingLineItem: ['billing_run_id', 'supplier_id', 'campaign_id'],
  BuyerPayment: ['buyer_id', 'invoice_id'],
  SupplierPayout: ['supplier_id'],
  WalletTransaction: ['buyer_id'],
  ReturnRequest: ['buyer_id', 'lead_id'],
  BuyerFeedback: ['buyer_id', 'lead_id'],
};

const comparable = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

function statusCounts(rows) {
  const counts = {};
  for (const row of rows) {
    const status = String((row.data || row).status || 'unset');
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

async function sourceIdIndex(source, entity) {
  const index = new Map();
  let skip = 0;
  for (let page = 0; page * PAGE < MAX_IDS; page += 1) {
    const rows = await source.ids(entity, { skip, limit: PAGE });
    for (const r of rows) {
      if (r && r.id) index.set(String(r.id), r.updated_date || null);
    }
    if (rows.length < PAGE) return { index, truncated: false };
    skip += PAGE;
  }
  return { index, truncated: true };
}

export async function reconcileEntity(source, entity) {
  const table = tableName(entity);
  const out = {
    entity,
    sourceCount: null,
    localCount: null,
    onlyInBase44: [],
    onlyInDashFlo: [],
    staleInDashFlo: [],
    importantFieldMismatches: [],
    relationshipMismatches: [],
    sourceStatusCounts: null,
    localStatusCounts: null,
    conflicts: 0,
    truncated: false,
    notInSource: false,
    error: null,
  };

  try {
    const { rows: exists } = await pool.query('SELECT to_regclass($1) AS t', [`public.${table}`]);
    if (!exists[0]?.t) throw new Error(`No local table ${table}`);

    const { index: srcIndex, truncated } = await sourceIdIndex(source, entity);
    out.truncated = truncated;
    out.sourceCount = srcIndex.size;

    const { rows: localRows } = await pool.query(`SELECT id, updated_date, data FROM ${table}`);
    out.localCount = localRows.length;
    const localIds = new Set(localRows.map((r) => String(r.id)));
    const localById = new Map(localRows.map((r) => [String(r.id), r.data || {}]));

    for (const id of srcIndex.keys()) {
      if (!localIds.has(id)) out.onlyInBase44.push(id);
    }
    for (const id of localIds) {
      if (!srcIndex.has(id)) out.onlyInDashFlo.push(id);
    }

    // Imported records the source has changed since we last synced them.
    const { rows: prov } = await pool.query(
      `SELECT base44_id, source_updated_date FROM base44_record_provenance WHERE entity = $1`,
      [entity],
    );
    for (const p of prov) {
      const srcUpdated = srcIndex.get(String(p.base44_id));
      if (!srcUpdated || !p.source_updated_date) continue;
      if (new Date(srcUpdated) > new Date(p.source_updated_date)) out.staleInDashFlo.push(String(p.base44_id));
    }

    const { rows: conf } = await pool.query(
      `SELECT count(*)::int AS n FROM base44_record_provenance WHERE entity = $1 AND conflict = true`,
      [entity],
    );
    out.conflicts = conf[0]?.n || 0;

    const fields = IMPORTANT_FIELDS[entity] || [];
    if (fields.length && !truncated) {
      const sourceRows = await source.readAll(entity, { fields: ['id', 'status', ...fields] });
      const relationshipFields = new Set(RELATIONSHIP_FIELDS[entity] || []);
      for (const sourceRow of sourceRows) {
        const id = String(sourceRow.id || '');
        const local = localById.get(id);
        if (!id || !local) continue;
        for (const field of fields) {
          if (comparable(sourceRow[field]) === comparable(local[field])) continue;
          const mismatch = { id, field };
          out.importantFieldMismatches.push(mismatch);
          if (relationshipFields.has(field)) out.relationshipMismatches.push(mismatch);
        }
      }
      if (entity === 'Lead') {
        out.sourceStatusCounts = statusCounts(sourceRows);
        out.localStatusCounts = statusCounts(localRows);
      }
    }
  } catch (err) {
    // A DashFlo-native entity has nothing to reconcile against. Report it as a
    // known state so it does not permanently colour the report as dirty.
    if (err?.notInSource) {
      out.notInSource = true;
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`).catch(() => ({ rows: [{ n: null }] }));
      out.localCount = rows[0]?.n ?? null;
      out.sourceCount = 0;
    } else {
      out.error = String(err?.message || 'unknown error').slice(0, 300);
    }
  }

  return out;
}

export async function reconcile({ entities = null, sampleLimit = 25 } = {}) {
  await ensureBase44SyncSchema();
  const cfg = base44ConfigFromEnv();
  if (!isConfigured(cfg)) {
    return { configured: false, reason: 'Base44 source is not configured', entities: [] };
  }

  const source = new Base44Source(cfg);
  await source.ping();

  const explicitlyRequested = Boolean(entities && entities.length);
  const targets = (explicitlyRequested ? entities : syncableEntities())
    .filter((n) => entityNames.includes(n) && !NEVER_SYNCED_ENTITIES.has(n) && !DASHFLO_OWNED_ENTITIES.has(n));

  const results = [];
  for (const entity of targets) {
    const r = await reconcileEntity(source, entity);
    results.push({
      ...r,
      // Full id lists can be very long. The report carries a bounded sample
      // plus the true totals, so it stays readable without lying about scale.
      onlyInBase44Count: r.onlyInBase44.length,
      onlyInDashFloCount: r.onlyInDashFlo.length,
      staleInDashFloCount: r.staleInDashFlo.length,
      importantFieldMismatchCount: r.importantFieldMismatches.length,
      relationshipMismatchCount: r.relationshipMismatches.length,
      onlyInBase44: r.onlyInBase44.slice(0, sampleLimit),
      onlyInDashFlo: r.onlyInDashFlo.slice(0, sampleLimit),
      staleInDashFlo: r.staleInDashFlo.slice(0, sampleLimit),
      importantFieldMismatches: r.importantFieldMismatches.slice(0, sampleLimit),
      relationshipMismatches: r.relationshipMismatches.slice(0, sampleLimit),
    });
  }

  const clean = results.every((r) => !r.error
    && r.onlyInBase44Count === 0 && r.staleInDashFloCount === 0 && r.conflicts === 0
    && r.importantFieldMismatchCount === 0 && r.relationshipMismatchCount === 0);

  return {
    configured: true,
    generatedAt: new Date().toISOString(),
    clean,
    entities: results,
    summary: {
      entities: results.length,
      withErrors: results.filter((r) => r.error).length,
      missingLocally: results.reduce((n, r) => n + r.onlyInBase44Count, 0),
      localOnly: results.reduce((n, r) => n + r.onlyInDashFloCount, 0),
      stale: results.reduce((n, r) => n + r.staleInDashFloCount, 0),
      conflicts: results.reduce((n, r) => n + r.conflicts, 0),
      importantFieldMismatches: results.reduce((n, r) => n + r.importantFieldMismatchCount, 0),
      relationshipMismatches: results.reduce((n, r) => n + r.relationshipMismatchCount, 0),
    },
  };
}

export default reconcile;
