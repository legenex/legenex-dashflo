// Google account linking policy.
//
// Authentication is not authorization. Google proving who somebody is says
// nothing about whether that person may use this DashFlo instance or what they
// may do inside it. This module is the single place that decides, and it is
// written as a pure function over already-gathered state so the decision can be
// tested exhaustively without a database.
//
// The rules, and why each one is what it is:
//
//   LOGIN_LINKED
//     The Google `sub` is already recorded against a credential. Log that
//     account in. The email on the DashFlo account is NOT updated from Google,
//     because an email can be reassigned inside a Workspace domain and silently
//     rewriting it would let a new holder of an old address inherit the
//     account's history.
//
//   LINK_AND_LOGIN
//     A verified Google email matches exactly one existing DashFlo credential
//     that carries no Google identity yet. Record `sub` against it and log in.
//     Role, base_role and permissions are read from the existing account and
//     never rewritten, so a Google login cannot promote anyone.
//
//   ACTIVATE_INVITATION
//     No credential, but an operator has issued a pending invitation to this
//     address. This is the intended way a new person joins: the invitation is
//     the authorization decision, made earlier by a human, and Google merely
//     proves the person holds the address it was sent to. Role and permissions
//     come from the invitation.
//
//   PROVISION_NEW
//     No credential and no invitation, and the installation has explicitly
//     opted into open Google sign-up. Off by default. The created account is
//     always an ordinary user: `role: 'user'`, `base_role: 'manager'`. There is
//     no input to this function that can produce an owner or an admin.
//
//   REFUSE
//     Everything else. Each refusal carries a stable code.
//
// The refusals matter more than the approvals, so they are enumerated:
//
//   NOT_REGISTERED       no account, no invitation, sign-up closed
//   ACCOUNT_DISABLED     the credential is disabled
//   INVITATION_CANCELLED the only invitation for this address was revoked
//   IDENTITY_CONFLICT    this Google account is linked to a different DashFlo
//                        account, or this DashFlo account is already linked to
//                        a different Google account
//   AMBIGUOUS_ACCOUNT    more than one credential holds this email
//   DOMAIN_NOT_ALLOWED   hosted domain restriction is on and this is not one
//
// IDENTITY_CONFLICT is refused rather than resolved on purpose. Both shapes of
// it are ambiguous merges, and guessing wrong hands one person another
// person's account. An operator unlinks deliberately instead.

export const LINK_ACTION = {
  LOGIN_LINKED: 'login_linked',
  LINK_AND_LOGIN: 'link_and_login',
  ACTIVATE_INVITATION: 'activate_invitation',
  PROVISION_NEW: 'provision_new',
  REFUSE: 'refuse',
};

export const LINK_REFUSAL = {
  NOT_REGISTERED: 'NOT_REGISTERED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  INVITATION_CANCELLED: 'INVITATION_CANCELLED',
  IDENTITY_CONFLICT: 'IDENTITY_CONFLICT',
  AMBIGUOUS_ACCOUNT: 'AMBIGUOUS_ACCOUNT',
  DOMAIN_NOT_ALLOWED: 'DOMAIN_NOT_ALLOWED',
};

// Messages are deliberately uniform where they would otherwise disclose
// whether an address has an account here. "Not registered" and "disabled" are
// distinguishable to the operator in the audit trail, not to the caller.
const REFUSAL_MESSAGE = {
  [LINK_REFUSAL.NOT_REGISTERED]: 'This Google account is not registered with DashFlo. Ask an operator for an invitation.',
  [LINK_REFUSAL.ACCOUNT_DISABLED]: 'This account is not able to sign in. Contact an operator.',
  [LINK_REFUSAL.INVITATION_CANCELLED]: 'This Google account is not registered with DashFlo. Ask an operator for an invitation.',
  [LINK_REFUSAL.IDENTITY_CONFLICT]: 'This Google account cannot be linked automatically. Contact an operator.',
  [LINK_REFUSAL.AMBIGUOUS_ACCOUNT]: 'This Google account cannot be linked automatically. Contact an operator.',
  [LINK_REFUSAL.DOMAIN_NOT_ALLOWED]: 'This Google account is not in an allowed domain for this instance.',
};

function refuse(reason, detail = '') {
  return {
    action: LINK_ACTION.REFUSE,
    reason,
    message: REFUSAL_MESSAGE[reason] || 'Google sign-in was refused.',
    detail,
  };
}

// Roles a Google sign-in may never mint for itself. An invitation may still
// carry them, because an operator created that invitation deliberately.
const SELF_PROVISION_ROLE = { role: 'user', base_role: 'manager' };

/**
 * Decide what a verified Google identity is allowed to do.
 *
 * @param identity           { sub, email, hostedDomain } from verifyGoogleIdToken
 * @param credentialBySub    credential row already linked to this Google sub, or null
 * @param credentialsByEmail every credential row holding this email (usually 0 or 1)
 * @param invitation         the most relevant Invitation for this email, or null
 * @param allowSelfSignup    whether an unknown, uninvited address may create an account
 * @param allowedDomains     hosted domains permitted, empty means no restriction
 */
export function decideGoogleLink({
  identity,
  credentialBySub = null,
  credentialsByEmail = [],
  invitation = null,
  allowSelfSignup = false,
  allowedDomains = [],
} = {}) {
  const email = String(identity?.email || '').trim().toLowerCase();
  const sub = String(identity?.sub || '').trim();
  if (!sub || !email) return refuse(LINK_REFUSAL.NOT_REGISTERED, 'identity incomplete');

  // Domain restriction is checked first so a restricted instance never even
  // discloses whether an outside address has an account.
  const domains = (allowedDomains || []).map((d) => String(d).trim().toLowerCase()).filter(Boolean);
  if (domains.length) {
    const hosted = String(identity.hostedDomain || '').toLowerCase();
    const emailDomain = email.split('@')[1] || '';
    if (!domains.includes(hosted) && !domains.includes(emailDomain)) {
      return refuse(LINK_REFUSAL.DOMAIN_NOT_ALLOWED, emailDomain);
    }
  }

  // 1. Already linked. The strongest signal available, so it wins over email.
  if (credentialBySub) {
    if (credentialBySub.disabled) return refuse(LINK_REFUSAL.ACCOUNT_DISABLED, 'linked credential disabled');
    return {
      action: LINK_ACTION.LOGIN_LINKED,
      userId: credentialBySub.user_id,
      // The account's own email, not Google's. See the header note.
      email: String(credentialBySub.email || '').toLowerCase(),
      emailChangedAtGoogle: String(credentialBySub.email || '').toLowerCase() !== email,
    };
  }

  // 2. Match by verified email. More than one match is a data problem, not a
  // login: picking one would be a coin flip over whose account this becomes.
  const matches = (credentialsByEmail || []).filter(Boolean);
  if (matches.length > 1) return refuse(LINK_REFUSAL.AMBIGUOUS_ACCOUNT, `${matches.length} credentials`);

  if (matches.length === 1) {
    const credential = matches[0];
    if (credential.disabled) return refuse(LINK_REFUSAL.ACCOUNT_DISABLED, 'credential disabled');
    // The account already belongs to a different Google identity. Refuse
    // rather than re-point it: whoever holds the old identity would lose the
    // account without anybody noticing.
    if (credential.google_sub && credential.google_sub !== sub) {
      return refuse(LINK_REFUSAL.IDENTITY_CONFLICT, 'credential already linked to another Google account');
    }
    return {
      action: LINK_ACTION.LINK_AND_LOGIN,
      userId: credential.user_id,
      email,
      // True when this person has been signing in with a password until now.
      // Password login keeps working afterwards; linking adds a method, it
      // does not replace one.
      hadPassword: Boolean(credential.password_hash),
    };
  }

  // 3. No credential. An invitation is a human authorization decision made
  // earlier, so it is honoured; a cancelled one is not.
  if (invitation) {
    const status = String(invitation.status || 'pending').toLowerCase();
    if (status === 'cancelled') return refuse(LINK_REFUSAL.INVITATION_CANCELLED, 'invitation cancelled');
    return {
      action: LINK_ACTION.ACTIVATE_INVITATION,
      email,
      invitationId: invitation.id,
      role: invitation.role || 'user',
      baseRole: invitation.base_role || 'manager',
      permissions: invitation.permissions || undefined,
      fullName: invitation.full_name || '',
    };
  }

  // 4. Open sign-up, off unless an operator switched it on. Never privileged.
  if (allowSelfSignup) {
    return {
      action: LINK_ACTION.PROVISION_NEW,
      email,
      ...SELF_PROVISION_ROLE,
    };
  }

  return refuse(LINK_REFUSAL.NOT_REGISTERED, 'no credential and no invitation');
}

export default { LINK_ACTION, LINK_REFUSAL, decideGoogleLink };
