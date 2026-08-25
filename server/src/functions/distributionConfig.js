import { requireUser, HttpError } from './_runtime.js';
import * as engine from './routingEngine.generated.js';

// Caller model: OPERATOR-ONLY. Route configuration lifecycle: create_draft,
// update_draft, validate, publish, pause, archive, rollback. Authorization runs
// BEFORE any service-role read/write via the shared isOperator predicate. Publish
// is fail-closed (server-side validation) and creates an IMMUTABLE
// RouteConfigVersion plus a DistributionAudit record. Published configs are never
// hard deleted (archive only, with a referential check).

export default async function distributionConfig(ctx) {
  const user = requireUser(ctx);
  const svc = ctx.db;

  try {
    const record = await svc.entities.User.get(user.id).catch(() => null);
    if (!engine.isOperator(record || user)) return ctx.json({ error: 'Forbidden' }, 403);

    const body = ctx.body || {};
    const action = String(body.action || '');
    const groupId = body.route_group_id || null;
    const nowIso = new Date().toISOString();
    const audit = (a) => svc.entities.DistributionAudit.create({ actor_id: user.id, created_at: nowIso, ...a });

    async function loadConfig(gid) {
      const groups = await svc.entities.RouteGroup.filter({ id: gid });
      const group = groups[0];
      if (!group) return null;
      const members = await svc.entities.RouteMember.filter({ route_group_id: gid }, 'priority', 500, 0);
      const buyerIds = [...new Set(members.map((m) => m.buyer_id).filter(Boolean))];
      const destIds = [...new Set(members.map((m) => m.destination_id).filter(Boolean))];
      // Canonical (native) members reference sub_delivery_id, not destination_id
      // (deprecated legacy path). validateConfigForPublish needs the real
      // SubDelivery/parent-Delivery rows to check them - without these, every
      // member on the native path was silently reported "sub-delivery not
      // found" regardless of how it was actually configured.
      const subDeliveryIds = [...new Set(members.map((m) => m.sub_delivery_id).filter(Boolean))];
      const buyers = []; for (const id of buyerIds) { const r = await svc.entities.Buyer.filter({ id }); if (r[0]) buyers.push(r[0]); }
      const destinations = []; for (const id of destIds) { const r = await svc.entities.LeadByteConnector.filter({ id }); if (r[0]) destinations.push(r[0]); }
      const subDeliveries = []; for (const id of subDeliveryIds) { const r = await svc.entities.SubDelivery.filter({ id }); if (r[0]) subDeliveries.push(r[0]); }
      const deliveryIds = [...new Set(subDeliveries.map((s) => s.delivery_id).filter(Boolean))];
      const deliveries = []; for (const id of deliveryIds) { const r = await svc.entities.Delivery.filter({ id }); if (r[0]) deliveries.push(r[0]); }
      // Needed only to validate a price_mode:'rule' member has any active
      // per-state pricing configured at all (see configPublish.js). Loaded
      // for exactly the referenced buyers, never a full-table read.
      const buyerStateCpls = [];
      if (svc.entities.BuyerStateCpl && members.some((m) => m.price_mode === 'rule')) {
        for (const id of buyerIds) {
          const r = await svc.entities.BuyerStateCpl.filter({ buyer_id: id });
          buyerStateCpls.push(...(r || []));
        }
      }
      return { group, members, buyers, destinations, subDeliveries, deliveries, buyerStateCpls };
    }

    if (action === 'create_draft') {
      const g = await svc.entities.RouteGroup.create({ ...body.group, lifecycle: 'draft', active: false });
      await audit({ action: 'create_draft', entity_type: 'RouteGroup', entity_id: g.id });
      return { ok: true, route_group_id: g.id };
    }
    if (action === 'update_draft') {
      const groups = await svc.entities.RouteGroup.filter({ id: groupId });
      if (!groups[0]) return ctx.json({ error: 'not found' }, 404);
      if (groups[0].lifecycle === 'archived') return ctx.json({ error: 'archived config is immutable' }, 409);
      await svc.entities.RouteGroup.update(groupId, { ...body.group });
      await audit({ action: 'update_draft', entity_type: 'RouteGroup', entity_id: groupId });
      return { ok: true };
    }
    if (action === 'validate') {
      const cfg = await loadConfig(groupId);
      if (!cfg) return ctx.json({ error: 'not found' }, 404);
      const result = engine.validateConfigForPublish(cfg, Date.now());
      // Member-level diff against the last published version, for the
      // operator confirmation dialog. Without this, the dialog could only
      // ever show group-level field changes (its own local DIFF_FIELDS
      // comparison) - a RouteMember repointed to a different SubDelivery, or
      // any other member-level change, was published with no visible diff
      // at all, even though computeConfigHash (used above) already reflects
      // it. Absent when this is the first-ever publish (no prior version).
      let diff = [];
      if (cfg.group.config_version_id) {
        const versions = await svc.entities.RouteConfigVersion.filter({ id: cfg.group.config_version_id });
        const prior = versions[0];
        if (prior && prior.snapshot) {
          try {
            const oldCfg = JSON.parse(prior.snapshot);
            diff = engine.diffConfig(oldCfg, { group: cfg.group, members: cfg.members });
          } catch { /* corrupt/legacy snapshot: no diff, not a validation failure */ }
        }
      }
      return { ...result, diff };
    }
    if (action === 'publish') {
      const cfg = await loadConfig(groupId);
      if (!cfg) return ctx.json({ error: 'not found' }, 404);
      const result = engine.validateConfigForPublish(cfg, Date.now());
      if (!result.valid) return ctx.json({ ok: false, errors: result.errors }, 422);
      const version = await svc.entities.RouteConfigVersion.create({
        route_group_id: groupId, campaign_id: cfg.group.campaign_id, config_hash: result.configHash,
        snapshot: engine.buildVersionSnapshot(cfg.group, cfg.members),
        published_by: user.id, published_at: nowIso, change_reason: String(body.change_reason || ''), status: 'published',
      });
      await svc.entities.RouteGroup.update(groupId, {
        lifecycle: 'active', active: true, config_version_id: version.id, config_hash: result.configHash,
        published_by: user.id, published_at: nowIso, change_reason: String(body.change_reason || ''),
      });
      await audit({ action: 'publish', entity_type: 'RouteGroup', entity_id: groupId, to_value: result.configHash, reason: String(body.change_reason || '') });
      return { ok: true, config_version_id: version.id, config_hash: result.configHash };
    }
    if (action === 'pause') {
      await svc.entities.RouteGroup.update(groupId, { lifecycle: 'paused', active: false });
      await audit({ action: 'pause', entity_type: 'RouteGroup', entity_id: groupId });
      return { ok: true };
    }
    if (action === 'archive') {
      // No hard delete. Archive only. (Referential history preserved in RouteConfigVersion.)
      await svc.entities.RouteGroup.update(groupId, { lifecycle: 'archived', active: false });
      await audit({ action: 'archive', entity_type: 'RouteGroup', entity_id: groupId });
      return { ok: true };
    }
    if (action === 'rollback') {
      const versions = await svc.entities.RouteConfigVersion.filter({ route_group_id: groupId }, '-published_at', 50, 0);
      const target = versions.find((v) => String(v.config_hash) === String(body.config_hash)) || versions[1];
      if (!target) return ctx.json({ error: 'no prior version' }, 404);
      await svc.entities.RouteGroup.update(groupId, { config_version_id: target.id, config_hash: target.config_hash, lifecycle: 'active', active: true });
      await audit({ action: 'rollback', entity_type: 'RouteGroup', entity_id: groupId, to_value: target.config_hash });
      return { ok: true, rolled_back_to: target.config_hash };
    }
    return ctx.json({ error: 'unknown action' }, 400);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return ctx.json({ error: error.message }, 500);
  }
}
