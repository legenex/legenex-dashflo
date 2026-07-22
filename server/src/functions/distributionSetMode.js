import { requireUser } from './_runtime.js';
import * as engine from './routingEngine.generated.js';

// Caller model: OPERATOR-ONLY. Audited distribution_mode transition. This is the
// ONLY sanctioned way to change AppSettings.distribution_mode: it validates the
// transition, writes a DistributionAudit record (who/when/from/to/reason), then
// updates the setting. Authorization runs BEFORE any service-role access.

export default async function distributionSetMode(ctx) {
  const user = requireUser(ctx);
  const db = ctx.db;

  try {
    const record = await db.entities.User.get(user.id).catch(() => null);
    if (!engine.isOperator(record || user)) return ctx.json({ error: 'Forbidden' }, 403);

    const body = ctx.body || {};
    const to = String(body.mode || '');
    const settingsArr = await db.entities.AppSettings.list();
    const settings = settingsArr[0] || null;
    const from = String((settings && settings.distribution_mode) || 'legacy_only');

    const check = engine.validateModeTransition(from, to);
    if (!check.valid) return ctx.json({ ok: false, error: check.error }, 400);

    const nowIso = new Date().toISOString();
    await db.entities.DistributionAudit.create(
      engine.buildModeAudit({ from, to, actorId: user.id, reason: String(body.reason || ''), nowMs: Date.parse(nowIso) }),
    );
    if (settings) await db.entities.AppSettings.update(settings.id, { distribution_mode: to });
    else await db.entities.AppSettings.create({ distribution_mode: to });
    return ctx.json({ ok: true, from, to });
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
