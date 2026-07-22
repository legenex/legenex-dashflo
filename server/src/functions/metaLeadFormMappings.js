const OPERATOR_PERMISSION_KEYS = ['leads', 'reports', 'overview', 'finances', 'distribution', 'operations'];

function isOperator(caller) {
  if (!caller) return false;
  if (caller.base_role === 'supplier' || caller.base_role === 'buyer') return false;
  if (caller.linked_buyer_id || caller.linked_supplier_id) return false;
  let permissions = {};
  try { permissions = typeof caller.permissions === 'string' ? JSON.parse(caller.permissions || '{}') : (caller.permissions || {}); } catch { permissions = {}; }
  return caller.role === 'admin' || OPERATOR_PERMISSION_KEYS.some((k) => permissions[k] === true);
}

// Operator only. CRUD for Meta lead form mappings (form -> Legenex campaign +
// source + field map). Storage only: this function never ingests leads. The
// ingest_mode field defaults to 'disabled' and any mode other than 'disabled'
// is inert until lead ingestion is wired as its own reviewed change.
// Payload: { action: 'list' | 'save' | 'delete', ... }
//   list:   { }                      -> all mappings
//   save:   { form_id, form_name, page_id, page_name, connection_id,
//             campaign_id?, supplier_id?, field_map?, enabled? }
//   delete: { id }
export default async function metaLeadFormMappings(ctx) {
  try {
    const user = ctx.user;
    if (!isOperator(user)) return ctx.json({ error: 'Unauthorized' }, 401);

    const db = ctx.db;
    const body = ctx.body || {};
    const action = String(body.action || 'list');

    if (action === 'list') {
      const rows = (await db.entities.MetaLeadFormMapping.filter({ platform: 'meta' })) || [];
      return ctx.json({ success: true, mappings: rows });
    }

    if (action === 'delete') {
      const id = String(body.id || '');
      if (!id) return ctx.json({ error: 'id is required' }, 400);
      await db.entities.MetaLeadFormMapping.delete(id);
      return ctx.json({ success: true, deleted: true });
    }

    if (action === 'save') {
      const formId = String(body.form_id || '');
      const pageId = String(body.page_id || '');
      const connectionId = String(body.connection_id || '');
      if (!formId || !pageId || !connectionId) {
        return ctx.json({ error: 'form_id, page_id and connection_id are required' }, 400);
      }

      // Resolve denormalized snapshots so the UI and any later ingestion have
      // stable names even if the source records are renamed.
      let campaignName = '';
      let vertical = '';
      let brand = '';
      if (body.campaign_id) {
        const c = await db.entities.Campaign.get(String(body.campaign_id)).catch(() => null);
        if (c) { campaignName = c.name || ''; vertical = c.vertical || ''; brand = c.brand || ''; }
      }
      let supplierName = '';
      if (body.supplier_id) {
        const s = await db.entities.Supplier.get(String(body.supplier_id)).catch(() => null);
        if (s) supplierName = s.name || '';
      }

      let fieldMap = '';
      if (body.field_map != null) {
        fieldMap = typeof body.field_map === 'string' ? body.field_map : JSON.stringify(body.field_map);
      }

      const fields = {
        platform: 'meta',
        connection_id: connectionId,
        page_id: pageId,
        page_name: String(body.page_name || ''),
        form_id: formId,
        form_name: String(body.form_name || formId),
        campaign_id: String(body.campaign_id || ''),
        campaign_name: campaignName,
        vertical,
        brand,
        supplier_id: String(body.supplier_id || ''),
        supplier_name: supplierName,
        enabled: body.enabled !== false,
      };
      if (fieldMap) fields.field_map = fieldMap;

      const existing = await db.entities.MetaLeadFormMapping.filter({ platform: 'meta', form_id: formId });
      if (existing && existing.length) {
        await db.entities.MetaLeadFormMapping.update(existing[0].id, fields);
        const updated = await db.entities.MetaLeadFormMapping.get(existing[0].id).catch(() => null);
        return ctx.json({ success: true, mapping: updated, created: false });
      }

      // ingest_mode intentionally left at its 'disabled' default on create.
      const created = await db.entities.MetaLeadFormMapping.create(fields);
      return ctx.json({ success: true, mapping: created, created: true });
    }

    return ctx.json({ error: `Unknown action: ${action}` }, 400);
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
