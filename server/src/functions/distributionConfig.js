import { requireUser, HttpError } from './_runtime.js';
import * as engine from './routingEngine.generated.js';

// Caller model: OPERATOR-ONLY. Route configuration lifecycle: create_draft,
// update_draft, validate, publish, pause, archive, rollback. Authorization runs
// BEFORE any read/write via the shared isOperator predicate. Publish is
// fail-closed (server-side validation) and creates an IMMUTABLE
// RouteConfigVersion plus a DistributionAudit record. Published configs are never
// hard deleted (archive only, with a referential check).

export default async function distributionConfig(ctx) {
  const db = ctx.db;
  try {
    const user = requireUser(ctx);

    const record = await db.entities.User.get(user.id).catch(() => null);
    if (!engine.isOperator(record || user)) return ctx.json({ error: 'Forbidden' }, 403);

    const body = ctx.body || {};
    const action = String(body.action || '');
    const groupId = body.route_group_id || null;
    const nowIso = new Date().toISOString();
    const audit = (a) => db.entities.DistributionAudit.create({ actor_id: user.id, created_at: nowIso, ...a });

    async function loadConfig(gid) {
      const groups = await db.entities.RouteGroup.filter({ id: gid });
      const group = groups[0];
      if (!group) return null;
      const members = await db.entities.RouteMember.filter({ route_group_id: gid }, 'priority', 500, 0);
      const buyerIds = [...new Set(members.map((m) => m.buyer_id).filter(Boolean))];
      const destIds = [...new Set(members.map((m) => m.destination_id).filter(Boolean))];
      const buyers = []; for (const id of buyerIds) { const r = await db.entities.Buyer.filter({ id }); if (r[0]) buyers.push(r[0]); }
      const destinations = []; for (const id of destIds) { const r = await db.entities.LeadByteConnector.filter({ id }); if (r[0]) destinations.push(r[0]); }
      return { group, members, buyers, destinations };
    }

    if (action === 'create_draft') {
      const g = await db.entities.RouteGroup.create({ ...body.group, lifecycle: 'draft', active: false });
      await audit({ action: 'create_draft', entity_type: 'RouteGroup', entity_id: g.id });
      return ctx.json({ ok: true, route_group_id: g.id });
    }
    if (action === 'update_draft') {
      const groups = await db.entities.RouteGroup.filter({ id: groupId });
      if (!groups[0]) return ctx.json({ error: 'not found' }, 404);
      if (groups[0].lifecycle === 'archived') return ctx.json({ error: 'archived config is immutable' }, 409);
      await db.entities.RouteGroup.update(groupId, { ...body.group });
      await audit({ action: 'update_draft', entity_type: 'RouteGroup', entity_id: groupId });
      return ctx.json({ ok: true });
    }
    if (action === 'validate') {
      const cfg = await loadConfig(groupId);
      if (!cfg) return ctx.json({ error: 'not found' }, 404);
      return ctx.json(engine.validateConfigForPublish(cfg, Date.now()));
    }
    if (action === 'publish') {
      const cfg = await loadConfig(groupId);
      if (!cfg) return ctx.json({ error: 'not found' }, 404);
      const result = engine.validateConfigForPublish(cfg, Date.now());
      if (!result.valid) return ctx.json({ ok: false, errors: result.errors }, 422);
      const version = await db.entities.RouteConfigVersion.create({
        route_group_id: groupId, campaign_id: cfg.group.campaign_id, config_hash: result.configHash,
        snapshot: engine.buildVersionSnapshot(cfg.group, cfg.members),
        published_by: user.id, published_at: nowIso, change_reason: String(body.change_reason || ''), status: 'published',
      });
      await db.entities.RouteGroup.update(groupId, {
        lifecycle: 'active', active: true, config_version_id: version.id, config_hash: result.configHash,
        published_by: user.id, published_at: nowIso, change_reason: String(body.change_reason || ''),
      });
      await audit({ action: 'publish', entity_type: 'RouteGroup', entity_id: groupId, to_value: result.configHash, reason: String(body.change_reason || '') });
      return ctx.json({ ok: true, config_version_id: version.id, config_hash: result.configHash });
    }
    if (action === 'pause') {
      await db.entities.RouteGroup.update(groupId, { lifecycle: 'paused', active: false });
      await audit({ action: 'pause', entity_type: 'RouteGroup', entity_id: groupId });
      return ctx.json({ ok: true });
    }
    if (action === 'archive') {
      // No hard delete. Archive only. (Referential history preserved in RouteConfigVersion.)
      await db.entities.RouteGroup.update(groupId, { lifecycle: 'archived', active: false });
      await audit({ action: 'archive', entity_type: 'RouteGroup', entity_id: groupId });
      return ctx.json({ ok: true });
    }
    if (action === 'rollback') {
      const versions = await db.entities.RouteConfigVersion.filter({ route_group_id: groupId }, '-published_at', 50, 0);
      const target = versions.find((v) => String(v.config_hash) === String(body.config_hash)) || versions[1];
      if (!target) return ctx.json({ error: 'no prior version' }, 404);
      await db.entities.RouteGroup.update(groupId, { config_version_id: target.id, config_hash: target.config_hash, lifecycle: 'active', active: true });
      await audit({ action: 'rollback', entity_type: 'RouteGroup', entity_id: groupId, to_value: target.config_hash });
      return ctx.json({ ok: true, rolled_back_to: target.config_hash });
    }
    return ctx.json({ error: 'unknown action' }, 400);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return ctx.json({ error: error.message }, 500);
  }
}
