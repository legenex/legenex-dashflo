// Generic function route authorization.
//
// POST /api/functions/:name used to run any of the 94 loaded functions with no
// check at the route at all. Whether a caller needed to be authenticated
// depended entirely on whether that particular function remembered to call
// requireUser. A function that forgot was reachable by anyone on the internet.
//
// This inverts the default. Authentication is required unless the function is
// named in the public allowlist below, and being on that list is a deliberate,
// reviewed decision.
//
// Being public here means only that the route does not demand a session. Each
// public function still has to authenticate its own caller: a supplier API key,
// a webhook signature, a one-time onboarding token, or a shared secret.

// ── Public allowlist ────────────────────────────────────────────────────────
//
// Every entry records why it is public and what authenticates it instead. An
// entry with "none yet" is a known gap, tracked in STATE.md, not an approval.

export const PUBLIC_FUNCTIONS = {
  // Liveness. Returns no data about the system beyond that it is running.
  health: { reason: 'liveness probe', authenticatedBy: 'nothing to protect' },

  // The documented supplier posting surface. Suppliers post from their own
  // servers and cannot hold a browser session.
  leads: { reason: 'documented supplier intake endpoint', authenticatedBy: 'supplier API key header' },
  validate: { reason: 'dry run of supplier intake', authenticatedBy: 'supplier API key header' },
  spec: { reason: 'documented posting spec for a supplier', authenticatedBy: 'signed spec token' },

  // Inbound webhooks. The caller is a third party, not a logged in user.
  webhook: { reason: 'inbound webhook', authenticatedBy: 'per route key' },
  leadbyteWebhook: { reason: 'inbound LeadByte webhook', authenticatedBy: 'none yet, see STATE.md' },
  callWebhook: { reason: 'inbound call webhook', authenticatedBy: 'per route key' },
  buyerFeedbackWebhook: { reason: 'inbound buyer feedback', authenticatedBy: 'none yet, see STATE.md' },

  // Public buyer onboarding form. Reached from an emailed link before the
  // person has an account.
  getOnboardingContext: { reason: 'public onboarding form context', authenticatedBy: 'onboarding link token' },
  submitBuyerOnboarding: { reason: 'public onboarding form submission', authenticatedBy: 'onboarding link token' },

  // Browser redirect from Meta. It consumes the single-use state created by
  // an authenticated operator before performing any write.
  metaOauthCallback: { reason: 'Meta OAuth browser callback', authenticatedBy: 'single-use OAuth state' },

  // Read-only migration mirror. Guarded by its own environment secret, which
  // fails closed when unset.
  migrateSource: { reason: 'migration mirror', authenticatedBy: 'MIGRATE_SOURCE_SECRET, fails closed' },
};

// Public functions that do not yet verify their own caller. These are listed
// so the gap is visible and testable rather than implicit. Adding signature
// verification needs the supplier and buyer contracts, which is Gate B work.
export const PUBLIC_WITHOUT_OWN_VERIFICATION = ['leadbyteWebhook', 'buyerFeedbackWebhook'];

export function isPublicFunction(name) {
  return Object.prototype.hasOwnProperty.call(PUBLIC_FUNCTIONS, name);
}

// Decide whether a call may proceed. Deny by default: an unknown function or
// an unauthenticated caller for a non-public function is refused before the
// handler runs.
export function authorizeFunction(user, name) {
  if (isPublicFunction(name)) return { allowed: true, public: true };
  if (!user) {
    return {
      allowed: false,
      status: 401,
      reason: 'Authentication required',
    };
  }
  return { allowed: true, public: false };
}

export default { PUBLIC_FUNCTIONS, PUBLIC_WITHOUT_OWN_VERIFICATION, isPublicFunction, authorizeFunction };
