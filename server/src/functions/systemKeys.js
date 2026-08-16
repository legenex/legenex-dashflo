import crypto from 'node:crypto';
import { resolveRoleClass, ROLE } from '../lib/entityPolicy.js';
import { resolveMetaAppCreds } from '../lib/metaAppCreds.js';

const ADMIN_ROLES = new Set([ROLE.OWNER, ROLE.ADMIN]);
const SYSTEM_PROVIDERS = new Set(['openai', 'anthropic', 'gemini', 'meta', 'mcp_server', 'other']);

function ownerOnly(user) {
  return resolveRoleClass(user) === ROLE.OWNER;
}

function adminOrOwner(user) {
  return ADMIN_ROLES.has(resolveRoleClass(user));
}

function mask(value) {
  const s = String(value || '');
  return s ? `${'•'.repeat(8)}${s.slice(-4)}` : '';
}

function systemProjection(row) {
  const { secret: _secret, key_prefix: _keyPrefix, ...safe } = row;
  return {
    ...safe,
    secret_set: Boolean(row.secret),
    secret_masked: mask(row.secret),
    last4: row.last4 || String(row.secret || '').slice(-4),
  };
}

function buyerProjection(row) {
  const { key: _key, ...safe } = row;
  return {
    ...safe,
    key_set: Boolean(row.key),
    key_masked: mask(row.key),
  };
}

async function audit(db, caller, fields) {
  await db.entities.KeyAuditEvent.create({
    ...fields,
    actor_email: caller.email || '',
    actor_role: caller.base_role || caller.role || '',
    at: new Date().toISOString(),
  }).catch(() => {});
}

function mintBuyerKey() {
  return `lgnx_byr_${crypto.randomBytes(24).toString('base64url')}`;
}

export default async function systemKeys(ctx) {
  const caller = ctx.user;
  const body = ctx.body || {};
  const op = String(body.op || 'system_list');
  const db = ctx.db;

  try {
    if (op.startsWith('system_')) {
      if (!ownerOnly(caller)) return ctx.json({ error: 'System Keys are owner only' }, 403);

      if (op === 'system_list') {
        const rows = await db.entities.SystemKey.list('-updated_date', 250);
        return { success: true, keys: rows.map(systemProjection) };
      }

      if (op === 'system_save') {
        const id = String(body.id || '').trim();
        const existing = id ? await db.entities.SystemKey.get(id) : null;
        const name = String(body.name || existing?.name || '').trim();
        const provider = SYSTEM_PROVIDERS.has(body.provider) ? body.provider : (existing?.provider || 'other');
        if (!name) return ctx.json({ error: 'A key name is required' }, 400);

        const suppliedSecret = String(body.secret || '').trim();
        const finalSecret = suppliedSecret || String(existing?.secret || '');
        const patch = {
          name,
          provider,
          purpose: String(body.purpose ?? existing?.purpose ?? ''),
          env_var: String(body.env_var ?? existing?.env_var ?? ''),
          client_id: String(body.client_id ?? existing?.client_id ?? ''),
          server_url: String(body.server_url ?? existing?.server_url ?? ''),
          scopes: typeof body.scopes === 'string' ? body.scopes : (existing?.scopes || ''),
          notes: String(body.notes ?? existing?.notes ?? ''),
          active: body.active == null ? (existing?.active ?? true) : body.active === true,
          secret: finalSecret,
          last4: finalSecret ? finalSecret.slice(-4) : '',
          key_prefix: finalSecret ? finalSecret.slice(0, Math.min(8, finalSecret.length)) : '',
          rotated_at: suppliedSecret ? new Date().toISOString() : (existing?.rotated_at || null),
          created_by_email: existing?.created_by_email || caller.email || '',
          owner_user_id: existing?.owner_user_id || caller.id || '',
        };

        const saved = existing
          ? await db.entities.SystemKey.update(existing.id, patch)
          : await db.entities.SystemKey.create(patch);
        await audit(db, caller, {
          subject_type: 'system', subject_id: saved.id, subject_name: saved.name,
          action: existing ? (suppliedSecret ? 'rotated' : 'updated') : 'created',
          detail: `${provider} system credential ${existing ? 'updated' : 'created'}; no credential value recorded`,
        });
        return { success: true, key: systemProjection(saved) };
      }

      if (op === 'system_meta_save') {
        const current = await resolveMetaAppCreds(db, ctx.env);
        const appId = String(body.app_id || current.appId || '').trim();
        const appSecret = String(body.app_secret || current.appSecret || '').trim();
        if (!appId) return ctx.json({ error: 'Meta App ID is required' }, 400);
        if (!appSecret) return ctx.json({ error: 'Meta App Secret is required' }, 400);

        const existing = current.systemKeyId
          ? await db.entities.SystemKey.get(current.systemKeyId)
          : (await db.entities.SystemKey.filter({ provider: 'meta' }, '-updated_date', 20))[0];
        const suppliedSecret = String(body.app_secret || '').trim();
        const patch = {
          name: existing?.name || 'Meta App Credentials',
          provider: 'meta',
          purpose: 'Meta Ads OAuth application credentials',
          env_var: 'META_APP_SECRET',
          client_id: appId,
          secret: appSecret,
          key_prefix: appSecret.slice(0, Math.min(8, appSecret.length)),
          last4: appSecret.slice(-4),
          active: true,
          rotated_at: suppliedSecret ? new Date().toISOString() : (existing?.rotated_at || null),
          created_by_email: existing?.created_by_email || caller.email || '',
          owner_user_id: existing?.owner_user_id || caller.id || '',
        };
        const saved = existing
          ? await db.entities.SystemKey.update(existing.id, patch)
          : await db.entities.SystemKey.create(patch);
        await audit(db, caller, {
          subject_type: 'system', subject_id: saved.id, subject_name: saved.name,
          action: existing ? (suppliedSecret ? 'rotated' : 'updated') : 'created',
          detail: 'Meta application credential saved to the authoritative SystemKey location; no credential value recorded',
        });
        return {
          success: true,
          configured: true,
          app_id: appId,
          secret_last4: appSecret.slice(-4),
          source: 'system_key',
        };
      }

      return ctx.json({ error: `Unknown operation: ${op}` }, 400);
    }

    if (!adminOrOwner(caller)) return ctx.json({ error: 'Not permitted to manage buyer API keys' }, 403);

    if (op === 'buyer_list') {
      const [rows, buyers] = await Promise.all([
        db.entities.BuyerApiKey.list('-created_date', 500),
        db.entities.Buyer.list('-created_date', 500),
      ]);
      const legacy = buyers
        .filter((buyer) => Boolean(buyer.buyer_api_key))
        .map((buyer) => ({
          id: `legacy:${buyer.id}`,
          buyer_id: buyer.id,
          buyer_name: buyer.company_name || buyer.buyer_code || '',
          name: 'Legacy buyer delivery credential',
          key_set: true,
          key_masked: mask(buyer.buyer_api_key),
          active: buyer.active !== false,
          legacy: true,
          created_date: buyer.created_date,
        }));
      return { success: true, keys: [...rows.map(buyerProjection), ...legacy] };
    }

    if (op === 'buyer_create') {
      const buyerId = String(body.buyer_id || '').trim();
      const buyer = buyerId ? await db.entities.Buyer.get(buyerId) : null;
      if (!buyer) return ctx.json({ error: 'A valid buyer is required' }, 400);
      const raw = mintBuyerKey();
      const created = await db.entities.BuyerApiKey.create({
        buyer_id: buyer.id,
        buyer_name: buyer.company_name || buyer.buyer_code || '',
        name: String(body.name || '').trim() || `${buyer.company_name || buyer.buyer_code || 'Buyer'} API key`,
        key: raw,
        key_prefix: raw.slice(0, 16),
        scopes: typeof body.scopes === 'string' ? body.scopes : JSON.stringify(['feedback', 'returns']),
        active: true,
        request_count: 0,
        notes: String(body.notes || ''),
        created_by_email: caller.email || '',
      });
      await audit(db, caller, {
        subject_type: 'buyer', subject_id: created.id, subject_name: created.name,
        action: 'created', detail: `Buyer API key created for buyer ${buyer.id}; no credential value recorded`,
      });
      return { success: true, key: raw, record: buyerProjection(created), warning: 'This is the only time the full key is shown.' };
    }

    if (op === 'buyer_update') {
      const id = String(body.id || '').trim();
      const existing = await db.entities.BuyerApiKey.get(id);
      if (!existing) return ctx.json({ error: 'Unknown buyer API key' }, 404);
      const saved = await db.entities.BuyerApiKey.update(id, {
        name: String(body.name ?? existing.name),
        active: body.active == null ? existing.active : body.active === true,
        notes: String(body.notes ?? existing.notes ?? ''),
        scopes: typeof body.scopes === 'string' ? body.scopes : existing.scopes,
      });
      await audit(db, caller, {
        subject_type: 'buyer', subject_id: saved.id, subject_name: saved.name,
        action: 'updated', detail: 'Buyer API key metadata updated; no credential value recorded',
      });
      return { success: true, record: buyerProjection(saved) };
    }

    if (op === 'buyer_rotate') {
      const id = String(body.id || '').trim();
      const existing = await db.entities.BuyerApiKey.get(id);
      if (!existing) return ctx.json({ error: 'Unknown buyer API key' }, 404);
      const raw = mintBuyerKey();
      const saved = await db.entities.BuyerApiKey.update(id, {
        key: raw,
        key_prefix: raw.slice(0, 16),
        request_count: 0,
        last_used_at: null,
        rotated_at: new Date().toISOString(),
      });
      await audit(db, caller, {
        subject_type: 'buyer', subject_id: saved.id, subject_name: saved.name,
        action: 'rotated', detail: 'Buyer API key rotated by explicit operator action; no credential value recorded',
      });
      return { success: true, key: raw, record: buyerProjection(saved), warning: 'This is the only time the full key is shown.' };
    }

    return ctx.json({ error: `Unknown operation: ${op}` }, 400);
  } catch (error) {
    return ctx.json({ success: false, error: error?.message || 'API key operation failed' }, 500);
  }
}
