import { requireUser, HttpError } from './_runtime.js';

// Operator-only, audited distribution_mode transition. This is the only
// sanctioned way to change AppSettings.distribution_mode: it validates the
// transition, writes a DistributionAudit record (who/when/from/to/reason),
// then updates the setting. Authorization runs before any data mutation.

// Known distribution modes for the routing engine, in rollout order. Must
// match client/src/lib/distribution/modeControl.js's MODES and the inline
// allowlist processLead.js checks distribution_mode against exactly - this
// list had drifted to 'dual' where the other two say
// 'new_primary_with_legacy_fallback', which meant an operator could set
// mode:'dual' here (accepted, audited, and persisted) while processLead.js
// silently fell back to legacy_only on every subsequent lead, since 'dual'
// matched nothing in its own allowlist.
const DISTRIBUTION_MODES = ['legacy_only', 'shadow', 'canary', 'new_primary_with_legacy_fallback', 'new_only'];

function isOperator(u) {
  if (!u) return false;
  if (u.role === 'admin') return true;
  if (u.is_operator === true || u.operator === true) return true;
  const appRole = String(u.app_role || u.dashboard_role || '').toLowerCase();
  return appRole === 'operator' || appRole === 'admin';
}

function validateModeTransition(from, to) {
  if (!to) return { valid: false, error: 'Missing target distribution_mode' };
  if (!DISTRIBUTION_MODES.includes(to)) {
    return { valid: false, error: `Unknown distribution_mode: ${to}` };
  }
  return { valid: true };
}

function buildModeAudit({ from, to, actorId, reason, nowMs }) {
  return {
    action: 'distribution_mode_change',
    from_mode: from,
    to_mode: to,
    actor_id: actorId,
    reason: reason || '',
    changed_at: new Date(nowMs).toISOString(),
  };
}

export default async function distributionSetMode(ctx) {
  try {
    const user = requireUser(ctx);
    const db = ctx.db;

    const record = await db.entities.User.get(user.id).catch(() => null);
    if (!isOperator(record || user)) return ctx.json({ error: 'Forbidden' }, 403);

    const body = ctx.body || {};
    const to = String(body.mode || '');
    const settingsArr = await db.entities.AppSettings.list();
    const settings = settingsArr[0] || null;
    const from = String((settings && settings.distribution_mode) || 'legacy_only');

    const check = validateModeTransition(from, to);
    if (!check.valid) return ctx.json({ ok: false, error: check.error }, 400);

    const nowIso = new Date().toISOString();
    await db.entities.DistributionAudit.create(
      buildModeAudit({ from, to, actorId: user.id, reason: String(body.reason || ''), nowMs: Date.parse(nowIso) }),
    );
    if (settings) await db.entities.AppSettings.update(settings.id, { distribution_mode: to });
    else await db.entities.AppSettings.create({ distribution_mode: to });
    return { ok: true, from, to };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return ctx.json({ error: error.message }, 500);
  }
}
