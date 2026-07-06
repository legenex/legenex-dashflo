import { requireUser } from './_runtime.js';

// Authenticated supplier-portal data endpoint. Returns everything the supplier
// portal needs, strictly scoped to a single Supplier record. Reads Lead
// (admin-only) but never returns another supplier's data, another supplier's
// leads, buyer identities, or operator-only sections.
//
// Scoping rules:
// - A supplier-role user is scoped to their own user.linked_supplier_id.
// - An operator (admin) may pass supplier_id to PREVIEW a supplier's portal.
//   Non-admin callers cannot override their linked supplier.

async function resolveSupplierScope(user, requestedSupplierId) {
  const isOperator = user.role === 'admin';
  if (isOperator && requestedSupplierId) return requestedSupplierId;
  if (user.linked_supplier_id) return user.linked_supplier_id;
  return null;
}

function parseArr(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
}

export default async function supplierPortalData(ctx) {
  try {
    const user = requireUser(ctx);
    const db = ctx.db;

    const body = ctx.body || {};
    const requestedSupplierId = body.supplier_id || null;
    const supplierId = await resolveSupplierScope(user, requestedSupplierId);
    if (!supplierId) return ctx.json({ error: 'No supplier linked to this account' }, 403);

    const supplier = await db.entities.Supplier.get(supplierId).catch(() => null);
    if (!supplier) return ctx.json({ error: 'Supplier not found' }, 404);
    if (!supplier.portal_enabled && user.role !== 'admin') {
      return ctx.json({ error: 'Portal is not enabled for this supplier' }, 403);
    }

    // Only leads this supplier sent (matched by supplier_name).
    const leads = await db.entities.Lead.filter({ supplier_name: supplier.name }, '-created_date', 3000);

    // Returns for this supplier's leads.
    const leadIds = new Set(leads.map((l) => l.id));
    let returns = [];
    try {
      const allReturns = await db.entities.ReturnRequest.list('-created_date', 3000);
      returns = allReturns.filter((r) => leadIds.has(r.lead_id));
    } catch { returns = []; }

    // Trim lead payloads to supplier-safe fields. Never expose buyer identity,
    // other suppliers' data, raw payloads, or operator-only traces.
    const safeLeads = leads.map((l) => ({
      id: l.id,
      lead_id: l.lead_id,
      first_name: l.first_name,
      last_name: l.last_name,
      mobile: l.mobile,
      email: l.email,
      final_status: l.final_status,
      revenue: l.revenue,
      cost: l.cost,
      created_date: l.created_date,
    }));

    // Their API key(s).
    let apiKey = null;
    try {
      const keys = await db.entities.ApiKey.filter({ supplier_id: supplier.id });
      const byName = keys.length ? keys : await db.entities.ApiKey.filter({ supplier_name: supplier.name });
      const active = byName.find((k) => k.active) || byName[0];
      if (active) apiKey = { key: active.key, key_prefix: active.key_prefix, name: active.name };
    } catch { apiKey = null; }

    // Ad reporting — ONLY for internal sources connected through Facebook.
    // External suppliers never receive any ad reporting.
    const isInternalFacebook = supplier.supplier_type === 'Internal';
    let adReporting = null;
    if (isInternalFacebook) {
      try {
        const mappings = await db.entities.AdSpendMapping.filter({ supplier_name: supplier.name });
        const mappingIds = new Set(mappings.map((m) => m.id));
        const allSpend = await db.entities.AdSpend.filter({ supplier_name: supplier.name }, '-date', 3000);
        const spendRows = allSpend.filter((s) => !s.mapping_id || mappingIds.has(s.mapping_id));
        adReporting = {
          enabled: true,
          mappings: mappings.map((m) => ({
            id: m.id,
            platform: m.platform,
            ad_account_name: m.ad_account_name,
            meta_campaign_name: m.meta_campaign_name,
            match_level: m.match_level,
            last_synced_at: m.last_synced_at,
          })),
          spend: spendRows.map((s) => ({
            date: s.date,
            spend: s.spend,
            impressions: s.impressions,
            clicks: s.clicks,
            leads: s.leads,
            meta_campaign_id: s.meta_campaign_id,
            ad_account_id: s.ad_account_id,
          })),
        };
      } catch {
        adReporting = { enabled: true, mappings: [], spend: [] };
      }
    }

    void parseArr;

    return {
      supplier: {
        id: supplier.id,
        name: supplier.name,
        sid: supplier.sid,
        email: supplier.email,
        phone: supplier.phone,
        supplier_type: supplier.supplier_type,
        vertical: supplier.vertical,
        brand: supplier.brand,
        landing_page_url: supplier.landing_page_url,
        portal_enabled: supplier.portal_enabled,
        is_internal_facebook: isInternalFacebook,
      },
      leads: safeLeads,
      returns,
      apiKey,
      adReporting,
    };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
