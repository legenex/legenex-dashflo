import { authorizeProgressCtx } from '../lib/progressAccess.js';
import {
  pageReadiness,
  weightedAverage,
  sectionBreakdown,
  migrationReadiness,
  evaluateGates,
  gateSummary,
  recommend,
  verificationStateFor,
} from './_readiness.js';

// Recalculates readiness across every ProgressPage, capability and release gate,
// then writes the day's ProgressSnapshot.
//
// This is the only writer of readiness_score, verification_status and
// ProgressSnapshot. Nothing in the UI may set those by hand, which is what keeps
// the number honest: a page becomes verified because evidence exists, not
// because somebody ticked a box.
//
// Idempotent. Running it twice on the same day updates the same snapshot row.
//
// Access: the DashFlo owner alone. See lib/progressAccess.js.
// Writes: ProgressPage (computed fields only), ReleaseGate status for automatic
// gates, ProgressSnapshot. Never touches operational records.

const TZ = 'America/Regina';

function dayKey(date = new Date()) {
  // Regina is UTC-6 with no DST, so a fixed offset is correct here and avoids
  // depending on Intl timezone data inside the function runtime.
  const shifted = new Date(date.getTime() - 6 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

async function loadAll(entity) {
  const pageSize = 500;
  const out = [];
  let skip = 0;
  while (true) {
    const batch = (await entity.list('-created_date', pageSize, skip)) || [];
    out.push(...batch);
    if (batch.length < pageSize) break;
    skip += pageSize;
  }
  return out;
}

const groupBy = (list, key) => {
  const out = {};
  list.forEach((item) => {
    const k = item[key];
    if (!k) return;
    if (!out[k]) out[k] = [];
    out[k].push(item);
  });
  return out;
};

export default async function progressReadiness(ctx) {
  try {
    const db = ctx.db;

    // Owner only. Progress moved to its own hostname as internal owner tooling,
    // so an admin role and a progress_* permission key no longer qualify.
    const decision = await authorizeProgressCtx(ctx);
    if (!decision.allowed) {
      return ctx.json({ error: decision.status === 401 ? 'Unauthorized' : 'Forbidden' }, decision.status);
    }

    const body = ctx.body || {};
    const persist = body?.persist !== false; // default true
    const snapshot = body?.snapshot !== false; // default true

    const svc = db.entities;
    const [pages, findings, verifications, gates, requirements] = await Promise.all([
      loadAll(svc.ProgressPage),
      loadAll(svc.AuditFinding),
      loadAll(svc.VerificationRecord),
      loadAll(svc.ReleaseGate),
      loadAll(svc.MigrationRequirement),
    ]);

    const findingsByPage = groupBy(findings, 'page_key');
    const verificationsByPage = groupBy(
      verifications.filter((v) => v.subject_type === 'page'),
      'subject_key',
    );

    // 1. Per page readiness.
    const results = pages.map((p) => pageReadiness(p, {
      findings: findingsByPage[p.page_key] || [],
      verifications: verificationsByPage[p.page_key] || [],
    }));
    const resultByKey = new Map(results.map((r) => [r.page_key, r]));

    // 2. Write computed fields back. Only the computed ones.
    let written = 0;
    if (persist) {
      for (const page of pages) {
        const r = resultByKey.get(page.page_key);
        if (!r) continue;
        const vstate = verificationStateFor(verificationsByPage[page.page_key] || []);
        const open = (findingsByPage[page.page_key] || []).filter((f) => ['open', 'acknowledged'].includes(f.status || 'open'));
        const patch = {
          readiness_score: r.score,
          verification_status: vstate.status,
          open_findings_count: open.length,
          p0_findings_count: open.filter((f) => f.priority === 'P0').length,
          readiness_explanation: JSON.stringify(r.explanation),
        };
        const changed = Object.keys(patch).some((k) => (page[k] ?? null) !== (patch[k] ?? null));
        if (changed) {
          await svc.ProgressPage.update(page.id, patch);
          written += 1;
        }
      }
    }

    // 3. Aggregates.
    const platform = weightedAverage(results);
    const sections = sectionBreakdown(results, pages);
    const migration = migrationReadiness(requirements);

    // 4. Release gates. Automatic ones are computed from records, never asserted.
    const evaluated = evaluateGates(gates, {
      findings,
      pageResults: results,
      pages,
      requirements,
    });
    const gateStats = gateSummary(evaluated);

    if (persist) {
      for (const g of evaluated) {
        if (!g.auto) continue;
        if (g.status === g.computed_status && g.evidence === g.computed_evidence) continue;
        await svc.ReleaseGate.update(g.id, {
          status: g.computed_status,
          evidence: g.computed_evidence,
          evidence_source: 'data',
          last_evaluated_at: new Date().toISOString(),
        });
      }
    }

    // 5. Recommendation.
    const verdict = recommend({
      platform,
      migration,
      gates: gateStats,
      findings,
      pages,
      requirements,
    });

    const scored = results.filter((r) => r.scored);
    const verifiedCount = scored.filter((r) => r.verification_status === 'verified').length;
    const implementedOrBetter = scored.filter((r) => ['implemented_unverified', 'verified'].includes(r.lifecycle)).length;
    const today = dayKey();
    const openFindings = findings.filter((f) => ['open', 'acknowledged'].includes(f.status || 'open'));

    const snapshotPayload = {
      snapshot_date: today,
      platform_readiness: platform.value,
      migration_readiness: migration.value,
      page_completion: scored.length ? Math.round((implementedOrBetter / scored.length) * 1000) / 10 : 0,
      verified_pages: scored.length ? Math.round((verifiedCount / scored.length) * 1000) / 10 : 0,
      pages_total: scored.length,
      pages_verified: verifiedCount,
      pages_blocked: scored.filter((r) => r.blocked).length,
      findings_open: openFindings.length,
      findings_p0: openFindings.filter((f) => f.priority === 'P0').length,
      findings_opened_today: findings.filter((f) => (f.created_date || '').slice(0, 10) === today).length,
      findings_resolved_today: findings.filter((f) => (f.resolved_at || '').slice(0, 10) === today).length,
      gates_passing: gateStats.passing,
      gates_total: gateStats.total,
      gates_blocking_failing: gateStats.blocking_failing,
      recommendation: verdict.recommendation,
      confidence: verdict.confidence,
      section_readiness: JSON.stringify(Object.fromEntries(sections.map((s) => [s.section_key, s.readiness]))),
      capability_readiness: JSON.stringify(Object.fromEntries(migration.by_group.map((g) => [g.group_key, g.readiness]))),
      evidence_coverage: migration.evidence_coverage,
    };

    let snapshotId = null;
    if (persist && snapshot) {
      const todays = (await svc.ProgressSnapshot.filter({ snapshot_date: today })) || [];
      if (todays.length > 0) {
        await svc.ProgressSnapshot.update(todays[0].id, snapshotPayload);
        snapshotId = todays[0].id;
      } else {
        const createdRec = await svc.ProgressSnapshot.create(snapshotPayload);
        snapshotId = createdRec?.id || null;
      }
    }

    return ctx.json({
      ok: true,
      timezone: TZ,
      snapshot_date: today,
      snapshot_id: snapshotId,
      persisted: persist,
      pages_written: written,
      platform,
      migration,
      sections,
      gates: gateStats,
      verdict,
      totals: {
        pages: pages.length,
        scored_pages: scored.length,
        findings: findings.length,
        open_findings: openFindings.length,
        verifications: verifications.length,
        gates: gates.length,
        requirements: requirements.length,
      },
    });
  } catch (err) {
    return ctx.json({ error: String(err?.message || err) }, 500);
  }
}
