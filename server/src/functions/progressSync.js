import { requireUser, HttpError } from './_runtime.js';
import { MANIFEST } from './pageManifest.js';

// Synchronises the generated page inventory into ProgressPage records.
//
// The manifest is machine owned and comes from scripts/generate-page-inventory.mjs,
// which reads the real router, nav and permission sources. This function copies
// the GENERATED fields onto records and leaves every HUMAN field alone. Running
// it twice in a row changes nothing, which is the point: adding a route must not
// cost anyone their notes, owners, criticality or lifecycle judgements.
//
// Access: operator session, admin role or the progress_admin permission.
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

    const user = requireUser(ctx);

    const record = await db.entities.User.get(user.id).catch(() => null);
    const caller = record || user;

    // Portal accounts never reach the Progress Control Center.
    if (caller.base_role === 'supplier' || caller.base_role === 'buyer') {
      return ctx.json({ error: 'Forbidden' }, 403);
    }
    if (caller.linked_buyer_id || caller.linked_supplier_id) {
      return ctx.json({ error: 'Forbidden' }, 403);
    }

    let permissions = {};
    try {
      permissions = typeof caller.permissions === 'string'
        ? JSON.parse(caller.permissions || '{}')
        : (caller.permissions || {});
    } catch { permissions = {}; }
    if (caller.role !== 'admin' && permissions.progress_admin !== true) {
      return ctx.json({ error: 'Forbidden' }, 403);
    }

    const body = ctx.body || {};
    const dryRun = body?.dry_run === true;

    const svc = db.entities;
    const existing = await loadAll(svc.ProgressPage);
    const byKey = new Map(existing.map((p) => [p.page_key, p]));

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

    return ctx.json({
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
      },
      created,
      updated,
      marked_stale: staleMarked,
      retired,
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return ctx.json({ error: String(err?.message || err) }, 500);
  }
}
