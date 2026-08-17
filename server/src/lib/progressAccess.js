// Progress Control Center authorization.
//
// Progress is internal owner tooling. It carries readiness findings, migration
// risk, code review state, release gates, internal notes and generated
// implementation prompts. None of that is customer data and none of it is
// something a customer, supplier, buyer or portal account has any business
// reading.
//
// The rule is one line and there are no exceptions to it: the caller must be
// the DashFlo owner. Being authenticated is not enough. Admin is not enough.
// A progress_* permission key is not enough, because permission keys are
// assignable by an admin and would let the owner-only boundary be granted away
// from inside the application.
//
// This is the single decision point. Every Progress surface, whether it is
// reached through the generic entity route, a backend function, or the
// hostname-scoped frontend, resolves the question here so there is exactly one
// definition of who the owner is.

import { ROLE, resolveRoleClass } from './entityPolicy.js';

// The entities that make up the Progress Control Center. Named here so the
// entity policy table, the tests, and any future surface all agree on the set
// rather than each keeping their own list that can drift.
export const PROGRESS_ENTITIES = Object.freeze([
  'ProgressPage',
  'ProgressSnapshot',
  'ReleaseGate',
  'ReviewThread',
  'ChangeRequest',
  'PromptDraft',
  'MigrationRequirement',
  'VerificationRecord',
]);

// The backend functions that read or write Progress state.
export const PROGRESS_FUNCTIONS = Object.freeze([
  'progressSync',
  'progressReadiness',
  'progressPrompt',
]);

/* Is this user the owner?
 *
 * resolveRoleClass is reused deliberately. It already resolves a linked buyer
 * or supplier id to a portal account before it looks at any role field, so an
 * account that carries base_role owner but is linked to a party cannot pass
 * here. That ordering is the property that matters, and duplicating the check
 * would risk losing it.
 */
export function isOwner(user) {
  return resolveRoleClass(user) === ROLE.OWNER;
}

/* Decide whether a caller may use a Progress surface.
 *
 * Anonymous callers get 401 so the client knows to authenticate. Everyone else
 * gets 403 with no detail about what would have been required, because the
 * reply is read by accounts that are not supposed to know this surface exists.
 */
export function authorizeProgress(user) {
  if (!user) {
    return { allowed: false, status: 401, reason: 'Authentication required' };
  }
  if (!isOwner(user)) {
    return { allowed: false, status: 403, reason: 'Forbidden' };
  }
  return { allowed: true };
}

/* Resolve the caller against the stored user record, then authorize.
 *
 * ctx.user comes from the session token. The stored record is authoritative for
 * role fields: a token minted before a role changed must not keep its old
 * standing. When the record cannot be read the token's own claims are used,
 * which is the conservative direction because a token never carries a role that
 * the record did not have when it was issued.
 */
export async function authorizeProgressCtx(ctx) {
  const claimed = ctx?.user || null;
  if (!claimed) return { allowed: false, status: 401, reason: 'Authentication required' };

  const record = await ctx.db?.entities?.User?.get(claimed.id).catch(() => null);
  return authorizeProgress(record || claimed);
}

export default {
  PROGRESS_ENTITIES,
  PROGRESS_FUNCTIONS,
  isOwner,
  authorizeProgress,
  authorizeProgressCtx,
};
