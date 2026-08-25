import { requireUser } from './_runtime.js';
import * as engine from './routingEngine.generated.js';
import { makeTargetValidator } from '../lib/ssrfGuard.js';

const validateTarget = makeTargetValidator();

// Caller model: OPERATOR-ONLY. Live outbound test of a single SubDelivery endpoint.
//
// SAFETY GATES (all enforced BEFORE any send):
//  1. Authorization: operator-only (isOperator), checked before service-role use.
//  2. Mode gate: disabled entirely unless AppSettings.distribution_mode is past
//     'legacy_only'. In production default (legacy_only) this always refuses.
//  3. Approval gate: the request MUST carry confirm === true. Without it, refused.
//  4. Audit: every live test writes a DistributionAudit record (who/when/target).
//
// Dry-run payload previews and response-mapping tests happen entirely in the
// browser and never call this function. This function is the ONLY path that
// performs a real outbound request, and only for an explicitly confirmed test.
//
// CREDENTIAL HARD RULE: the outbound secret is resolved server-side here from the
// sub-delivery's opaque credential_ref via secret storage. It is never accepted
// from the browser, never logged, and never returned in the response.

// Resolve credential_ref -> real auth headers from server-side secret storage.
// Wired to the deployment secret store. Returns {} when unavailable so the test
// still runs (unauthenticated) rather than leaking or crashing.
async function resolveCredential(db, ref) {
  if (!ref) return {};
  try {
    const rows = await db.entities.IntegrationConfig.filter({ key: ref });
    const val = rows && rows[0] && rows[0].value;
    if (val && typeof val === 'string') return { Authorization: val };
  } catch { /* secret store not configured in this env */ }
  return {};
}

export default async function campaignDeliveryTest(ctx) {
  const user = requireUser(ctx);
  const db = ctx.db;
  try {
    const record = await db.entities.User.get(user.id).catch(() => null);
    if (!engine.isOperator(record || user)) return ctx.json({ error: 'Forbidden' }, 403);

    // Mode gate: live tests are disabled unless distribution is past legacy_only.
    const settingsArr = await db.entities.AppSettings.list();
    const mode = String((settingsArr[0] && settingsArr[0].distribution_mode) || 'legacy_only');
    if (mode === 'legacy_only') {
      return ctx.json({ ok: false, error: 'Live delivery tests are disabled while distribution_mode is legacy_only.' }, 409);
    }

    const body = ctx.body || {};
    if (body.confirm !== true) {
      return ctx.json({ ok: false, error: 'Live test requires explicit operator confirmation (confirm=true).' }, 428);
    }
    const subId = String(body.sub_delivery_id || '');
    if (!subId) return ctx.json({ ok: false, error: 'sub_delivery_id required' }, 400);

    const sd = await db.entities.SubDelivery.get(subId).catch(() => null);
    if (!sd) return ctx.json({ ok: false, error: 'sub-delivery not found' }, 404);
    const parent = await db.entities.Delivery.get(sd.delivery_id).catch(() => null);

    // Audit the live test BEFORE sending.
    const nowIso = new Date().toISOString();
    await db.entities.DistributionAudit.create({
      action: 'delivery_live_test', entity_type: 'SubDelivery', entity_id: subId,
      to_value: sd.target_url || '', reason: String(body.reason || 'operator live test'),
      actor_id: user.id, created_at: nowIso,
    });

    const cfg = engine.resolveSubDeliveryCfg(sd);
    const result = await engine.deliverDirectPost(
      {
        ...cfg,
        idempotencyKey: `test:${subId}:${Date.parse(nowIso)}`,
        leadId: String(body.lead_id || 'TEST-LEAD'),
        leadData: body.sample_lead && typeof body.sample_lead === 'object' ? body.sample_lead : {},
        isPrimary: false, trigger: 'operator_test',
      },
      {
        // Fixed: engine.makeDbAttemptStore does not exist (the real export
        // is makeEntityAttemptStore) - this made every live delivery test
        // throw and return a 500 whenever db.entities.DeliveryAttempt
        // exists, which is always true in a real deployment.
        store: db.entities.DeliveryAttempt
          ? engine.makeEntityAttemptStore(db)
          : engine.makeInMemoryAttemptStore(),
        nowMs: Date.parse(nowIso), fetchImpl: globalThis.fetch, testMode: false,
        resolveCredential: (ref) => resolveCredential(db, ref),
        // SSRF guard: this is a REAL outbound send (an operator-confirmed
        // live test), not testMode, so it must carry the same production
        // target validation as processLead.js/nativeRetryRunner.js - this
        // call site was the one real gap an adversarial review found: an
        // operator-editable SubDelivery.target_url could be pointed at an
        // internal host or the cloud metadata endpoint and reached through
        // this confirmed-test path with zero validation.
        validateTarget,
      },
    );

    // Return ONLY a masked outcome. Never echo credentials or the raw request.
    return {
      ok: true, mode, buyer_id: parent ? parent.buyer_id : null,
      result: {
        status: result.status, http_status: result.httpStatus, revenue: result.revenue,
        buyer_lead_id: result.buyerLeadId, error_class: result.errorClass || null,
      },
    };
  } catch (error) {
    return ctx.json({ error: error.message }, 500);
  }
}
