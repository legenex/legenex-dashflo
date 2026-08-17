import { MANIFEST } from './_pageManifest.js';
import { authorizeProgressCtx } from '../lib/progressAccess.js';

// Synchronises the generated page inventory into ProgressPage records.
//
// The manifest is machine owned and comes from scripts/generate-page-inventory.mjs,
// which reads the real router, nav and permission sources. This function copies
// the GENERATED fields onto records and leaves every HUMAN field alone. Running
// it twice in a row changes nothing, which is the point: adding a route must not
// cost anyone their notes, owners, criticality or lifecycle judgements.
//
// Access: the DashFlo owner alone. See lib/progressAccess.js.
// Writes: ProgressPage only. Never touches operational records.

const HUMAN_OWNED_FIELDS = [
  'criticality', 'readiness_weight', 'business_owner', 'technical_owner',
  'lifecycle_status', 'blocked_reason', 'dimension_scores',
  'migration_required', 'leadbyte_equivalent', 'leadbyte_parity',
  'purpose', 'strengths', 'gaps', 'human_notes', 'needs_human_review',
  'known_risks', 'last_reviewed_at',
];

const GENERATED_FIELDS = [
  'section_key', 'section_label', 'title', 'route', 'parent_route', 'tab',
  'host_scope', 'portal_scope', 'route_type', 'redirect_to',
  'component', 'component_path', 'layouts', 'auth', 'nav_visibility',
  'permission_key', 'roles', 'entity_dependencies', 'function_dependencies',
  'component_dependencies',
];

async function loadAll(entity) {
  // Pull the full ProgressPage set in one read. The data layer paginates by a
  // limit alone, so request a ceiling comfortably above the inventory size.
  return (await entity.list('-created_date', 100000)) || [];
}

// Stable fingerprint of what a page depends on. When this changes, any prior
// review of the page is potentially stale. Unrelated commits do not move it,
// which is what stops every page going stale on every push.
function dependencyFingerprint(page) {
  const parts = [
    page.component_path || '',
    (page.entity_dependencies || []).join(','),
    (page.function_dependencies || []).join(','),
    (page.component_dependencies || []).length,
    (page.layout_files || []).length,
  ];
  return parts.join('|');
}

const toJson = (value) => (value == null ? null : JSON.stringify(value));

export default async function progressSync(ctx) {
  try {
    const db = ctx.db;

    // Owner only. Progress moved to its own hostname as internal owner tooling,
    // so an admin role and a progress_* permission key no longer qualify.
    const decision = await authorizeProgressCtx(ctx);
    if (!decision.allowed) {
      return ctx.json({ error: decision.status === 401 ? 'Unauthorized' : 'Forbidden' }, decision.status);
    }

    const body = ctx.body || {};
    const dryRun = body?.dry_run === true;

    const svc = db.entities;
    const existing = await loadAll(svc.ProgressPage);

    // ---- de-duplication pass ----
    // Two writers racing on the same page_key (a sync while records are being
    // seeded, or two operators pressing Sync at once) can leave more than one
    // record per key. The UI would then pick an arbitrary one and show the wrong
    // assessment. Collapse them here rather than leaving it to discipline:
    // keep the OLDEST record as canonical, fold any human field that is set on a
    // duplicate but empty on the canonical one, then remove the duplicates.
    const HUMAN_MERGE_FIELDS = HUMAN_OWNED_FIELDS;
    const groups = new Map();
    existing.forEach((rec) => {
      const list = groups.get(rec.page_key) || [];
      list.push(rec);
      groups.set(rec.page_key, list);
    });

    const deduped = [];
    const dedupeFailures = [];
    for (const [key, list] of groups) {
      if (list.length < 2) continue;
      list.sort((a, b) => String(a.created_date || '').localeCompare(String(b.created_date || '')));
      const canonical = list[0];
      const extras = list.slice(1);

      const merge = {};
      for (const field of HUMAN_MERGE_FIELDS) {
        const currentValue = canonical[field];
        const isEmpty = currentValue == null || currentValue === '' || currentValue === false
          || (field === 'criticality' && currentValue === 'normal')
          || (field === 'lifecycle_status' && currentValue === 'not_started')
          || (field === 'leadbyte_parity' && currentValue === 'not_assessed');
        if (!isEmpty) continue;
        const donor = extras.find((e) => {
          const v = e[field];
          if (v == null || v === '') return false;
          if (field === 'criticality' && v === 'normal') return false;
          if (field === 'lifecycle_status' && v === 'not_started') return false;
          if (field === 'leadbyte_parity' && v === 'not_assessed') return false;
          return true;
        });
        if (donor) merge[field] = donor[field];
      }

      if (!dryRun && Object.keys(merge).length > 0) {
        await svc.ProgressPage.update(canonical.id, merge);
        Object.assign(canonical, merge);
      }
      for (const extra of extras) {
        if (dryRun) { deduped.push(key); continue; }
        try {
          await svc.ProgressPage.delete(extra.id);
          deduped.push(key);
        } catch (e) {
          // Never leave a silent duplicate. If the delete is not permitted,
          // park the record loudly so it is visible rather than confusing.
          await svc.ProgressPage.update(extra.id, {
            page_key: `${extra.page_key}__duplicate_${extra.id.slice(-6)}`,
            lifecycle_status: 'blocked',
            blocked_reason: `Duplicate of ${key}. Could not be deleted automatically: ${String(e?.message || e)}. Delete it by hand.`,
            needs_human_review: true,
          });
          dedupeFailures.push(key);
        }
      }
    }

    const live = dryRun
      ? existing
      : await loadAll(svc.ProgressPage);
    const byKey = new Map(live.map((p) => [p.page_key, p]));

    const now = new Date().toISOString();
    const created = [];
    const updated = [];
    const staleMarked = [];
    const unchanged = [];
    const retired = [];

    for (const page of MANIFEST.pages) {
      const current = byKey.get(page.page_key);
      const generated = {
        section_key: page.section_key,
        section_label: page.section_label,
        title: page.title,
        route: page.route,
        parent_route: page.parent_route || null,
        tab: page.tab || null,
        host_scope: page.host_scope,
        portal_scope: page.portal_scope,
        route_type: page.route_type,
        redirect_to: page.redirect_to || null,
        component: page.component || null,
        component_path: page.component_path || null,
        layouts: toJson(page.layouts),
        auth: page.auth,
        nav_visibility: page.nav_visibility,
        permission_key: page.permission_key || null,
        roles: toJson(page.roles),
        entity_dependencies: toJson([...(page.entity_dependencies || []), ...(page.layout_entity_dependencies || [])]),
        function_dependencies: toJson([...(page.function_dependencies || []), ...(page.layout_function_dependencies || [])]),
        component_dependencies: toJson([...(page.component_dependencies || []), ...(page.layout_files || [])]),
        inventory_synced_at: now,
      };

      const fingerprint = dependencyFingerprint(page);

      if (!current) {
        // New surface. Seeded as not_started so it drags the average down until
        // somebody actually looks at it, rather than quietly counting as fine.
        if (!dryRun) {
          await svc.ProgressPage.create({
            page_key: page.page_key,
            ...generated,
            criticality: 'normal',
            lifecycle_status: 'not_started',
            verification_status: 'unverified',
            readiness_score: 0,
            migration_required: null,
            needs_human_review: true,
            open_findings_count: 0,
            p0_findings_count: 0,
            human_notes: '',
          });
        }
        created.push(page.page_key);
        continue;
      }

      // Only write when a generated field genuinely differs. Human fields are
      // never included in the patch, so they cannot be clobbered.
      const patch = {};
      for (const field of GENERATED_FIELDS) {
        if ((current[field] ?? null) !== (generated[field] ?? null)) patch[field] = generated[field];
      }

      const priorFingerprint = dependencyFingerprint({
        component_path: current.component_path,
        entity_dependencies: JSON.parse(current.entity_dependencies || '[]'),
        function_dependencies: JSON.parse(current.function_dependencies || '[]'),
        component_dependencies: JSON.parse(current.component_dependencies || '[]'),
        layout_files: [],
      });

      const dependenciesMoved = priorFingerprint !== fingerprint;
      const wasReviewed = Boolean(current.last_reviewed_at);
      if (dependenciesMoved && wasReviewed && !current.review_stale) {
        patch.review_stale = true;
        patch.last_code_change = now;
        staleMarked.push(page.page_key);
      }

      if (Object.keys(patch).length === 0) {
        unchanged.push(page.page_key);
        continue;
      }
      patch.inventory_synced_at = now;
      if (!dryRun) await svc.ProgressPage.update(current.id, patch);
      updated.push(page.page_key);
    }

    // Surfaces that no longer exist in the router. Flagged rather than deleted,
    // because the review history attached to them still matters.
    const manifestKeys = new Set(MANIFEST.pages.map((p) => p.page_key));
    for (const rec of existing) {
      if (manifestKeys.has(rec.page_key)) continue;
      if (rec.page_key?.includes('__duplicate_')) continue;
      if (rec.lifecycle_status === 'blocked' && rec.blocked_reason?.startsWith('Route removed')) continue;
      if (!dryRun) {
        await svc.ProgressPage.update(rec.id, {
          lifecycle_status: 'blocked',
          blocked_reason: `Route removed from the router on ${now.slice(0, 10)}. Retained for history; delete only when the removal is intentional and final.`,
          needs_human_review: true,
        });
      }
      retired.push(rec.page_key);
    }

    return {
      ok: true,
      dry_run: dryRun,
      manifest_generated_at: MANIFEST.generated_at,
      manifest_commit: MANIFEST.app_commit,
      totals: {
        in_manifest: MANIFEST.pages.length,
        existing_records: existing.length,
        created: created.length,
        updated: updated.length,
        unchanged: unchanged.length,
        marked_stale: staleMarked.length,
        retired: retired.length,
        duplicates_removed: deduped.length,
        duplicates_parked: dedupeFailures.length,
      },
      created,
      updated,
      marked_stale: staleMarked,
      retired,
      duplicates_removed: deduped,
      duplicates_parked: dedupeFailures,
    };
  } catch (err) {
    return ctx.json({ error: String(err?.message || err) }, 500);
  }
}
