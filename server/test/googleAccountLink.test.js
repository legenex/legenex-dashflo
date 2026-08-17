// Google account linking policy.
//
// Authentication is not authorization. Google proving an identity says nothing
// about whether that person may use this instance. These tests are mostly
// about refusals, because the expensive mistakes here are all "somebody got in
// who should not have" or "somebody became an owner by signing in".

import { describe, it, expect } from 'vitest';
import { decideGoogleLink, LINK_ACTION, LINK_REFUSAL } from '../src/lib/googleAccountLink.js';

const IDENTITY = { sub: 'google-sub-1', email: 'operator@example.test', hostedDomain: '' };

const credential = (over = {}) => ({
  user_id: 'user-1',
  email: 'operator@example.test',
  password_hash: null,
  google_sub: null,
  disabled: false,
  ...over,
});

describe('an already linked Google account', () => {
  it('signs in as the account the subject is linked to', () => {
    const decision = decideGoogleLink({
      identity: IDENTITY,
      credentialBySub: credential({ google_sub: 'google-sub-1' }),
    });
    expect(decision.action).toBe(LINK_ACTION.LOGIN_LINKED);
    expect(decision.userId).toBe('user-1');
  });

  it('does not copy a changed Google email onto the DashFlo account', () => {
    // An address can be reassigned inside a Workspace domain. Rewriting the
    // DashFlo email from Google would hand the account's history to whoever
    // holds the address next.
    const decision = decideGoogleLink({
      identity: { ...IDENTITY, email: 'new.address@example.test' },
      credentialBySub: credential({ google_sub: 'google-sub-1', email: 'operator@example.test' }),
    });
    expect(decision.action).toBe(LINK_ACTION.LOGIN_LINKED);
    expect(decision.email).toBe('operator@example.test');
    expect(decision.emailChangedAtGoogle).toBe(true);
  });

  it('refuses when the linked account is disabled', () => {
    const decision = decideGoogleLink({
      identity: IDENTITY,
      credentialBySub: credential({ google_sub: 'google-sub-1', disabled: true }),
    });
    expect(decision.action).toBe(LINK_ACTION.REFUSE);
    expect(decision.reason).toBe(LINK_REFUSAL.ACCOUNT_DISABLED);
  });

  it('prefers the subject over the email when the two disagree', () => {
    // Someone else's row happens to hold this email. The subject link wins,
    // because it is the stronger claim.
    const decision = decideGoogleLink({
      identity: IDENTITY,
      credentialBySub: credential({ user_id: 'user-linked', google_sub: 'google-sub-1' }),
      credentialsByEmail: [credential({ user_id: 'user-other' })],
    });
    expect(decision.userId).toBe('user-linked');
  });
});

describe('a verified email matching an existing account', () => {
  it('links the Google identity and signs the existing account in', () => {
    const decision = decideGoogleLink({ identity: IDENTITY, credentialsByEmail: [credential()] });
    expect(decision.action).toBe(LINK_ACTION.LINK_AND_LOGIN);
    expect(decision.userId).toBe('user-1');
  });

  it('reports that the account had a password, which keeps working afterwards', () => {
    const decision = decideGoogleLink({
      identity: IDENTITY,
      credentialsByEmail: [credential({ password_hash: '$2a$10$hash' })],
    });
    expect(decision.action).toBe(LINK_ACTION.LINK_AND_LOGIN);
    expect(decision.hadPassword).toBe(true);
  });

  it('never carries a role of its own, so linking cannot promote anybody', () => {
    const decision = decideGoogleLink({ identity: IDENTITY, credentialsByEmail: [credential()] });
    expect(decision.role).toBeUndefined();
    expect(decision.baseRole).toBeUndefined();
  });

  it('refuses when the account already belongs to a different Google identity', () => {
    const decision = decideGoogleLink({
      identity: IDENTITY,
      credentialsByEmail: [credential({ google_sub: 'a-different-google-account' })],
    });
    expect(decision.action).toBe(LINK_ACTION.REFUSE);
    expect(decision.reason).toBe(LINK_REFUSAL.IDENTITY_CONFLICT);
  });

  it('refuses a disabled account', () => {
    const decision = decideGoogleLink({ identity: IDENTITY, credentialsByEmail: [credential({ disabled: true })] });
    expect(decision.reason).toBe(LINK_REFUSAL.ACCOUNT_DISABLED);
  });

  it('refuses rather than guessing when two accounts hold the same email', () => {
    const decision = decideGoogleLink({
      identity: IDENTITY,
      credentialsByEmail: [credential({ user_id: 'user-1' }), credential({ user_id: 'user-2' })],
    });
    expect(decision.reason).toBe(LINK_REFUSAL.AMBIGUOUS_ACCOUNT);
  });
});

describe('an address with no account', () => {
  it('activates a pending invitation and takes the role from it', () => {
    const decision = decideGoogleLink({
      identity: IDENTITY,
      invitation: { id: 'inv-1', status: 'pending', role: 'admin', base_role: 'admin', permissions: '{"leads":true}' },
    });
    expect(decision.action).toBe(LINK_ACTION.ACTIVATE_INVITATION);
    expect(decision.role).toBe('admin');
    expect(decision.baseRole).toBe('admin');
    expect(decision.permissions).toBe('{"leads":true}');
    expect(decision.invitationId).toBe('inv-1');
  });

  it('refuses a cancelled invitation', () => {
    const decision = decideGoogleLink({
      identity: IDENTITY,
      invitation: { id: 'inv-1', status: 'cancelled', role: 'admin' },
    });
    expect(decision.action).toBe(LINK_ACTION.REFUSE);
    expect(decision.reason).toBe(LINK_REFUSAL.INVITATION_CANCELLED);
  });

  it('refuses an uninvited account by default', () => {
    const decision = decideGoogleLink({ identity: IDENTITY });
    expect(decision.action).toBe(LINK_ACTION.REFUSE);
    expect(decision.reason).toBe(LINK_REFUSAL.NOT_REGISTERED);
  });

  it('creates only an ordinary user when open sign-up is switched on', () => {
    const decision = decideGoogleLink({ identity: IDENTITY, allowSelfSignup: true });
    expect(decision.action).toBe(LINK_ACTION.PROVISION_NEW);
    expect(decision.role).toBe('user');
    expect(decision.base_role).toBe('manager');
  });

  it('cannot be talked into minting an owner or admin, whatever it is handed', () => {
    // The failure this guards against: an arbitrary Gmail account becoming an
    // owner because something in the input said so.
    for (const identity of [
      { ...IDENTITY, role: 'owner', base_role: 'owner' },
      { ...IDENTITY, email: 'owner@example.test', hostedDomain: 'example.test' },
    ]) {
      const decision = decideGoogleLink({ identity, allowSelfSignup: true });
      expect(decision.action).toBe(LINK_ACTION.PROVISION_NEW);
      expect(decision.role).toBe('user');
      expect(decision.base_role).toBe('manager');
      expect(decision.base_role).not.toBe('owner');
    }
  });
});

describe('hosted domain restriction', () => {
  it('allows an account inside an allowed domain', () => {
    const decision = decideGoogleLink({
      identity: { ...IDENTITY, email: 'ops@dashflo.io', hostedDomain: 'dashflo.io' },
      credentialsByEmail: [credential({ email: 'ops@dashflo.io' })],
      allowedDomains: ['dashflo.io'],
    });
    expect(decision.action).toBe(LINK_ACTION.LINK_AND_LOGIN);
  });

  it('refuses an outside account before disclosing whether it has an account here', () => {
    const decision = decideGoogleLink({
      identity: { ...IDENTITY, email: 'someone@gmail.com', hostedDomain: '' },
      // Even with a matching credential present, the domain check fires first.
      credentialsByEmail: [credential({ email: 'someone@gmail.com' })],
      allowedDomains: ['dashflo.io'],
    });
    expect(decision.action).toBe(LINK_ACTION.REFUSE);
    expect(decision.reason).toBe(LINK_REFUSAL.DOMAIN_NOT_ALLOWED);
  });

  it('applies no restriction when the list is empty', () => {
    const decision = decideGoogleLink({
      identity: { ...IDENTITY, email: 'someone@gmail.com' },
      credentialsByEmail: [credential({ email: 'someone@gmail.com' })],
      allowedDomains: [],
    });
    expect(decision.action).toBe(LINK_ACTION.LINK_AND_LOGIN);
  });
});

describe('refusal messages', () => {
  it('does not disclose whether an unknown address has an account here', () => {
    const notRegistered = decideGoogleLink({ identity: IDENTITY });
    const cancelled = decideGoogleLink({ identity: IDENTITY, invitation: { id: 'i', status: 'cancelled' } });
    // Same message to the caller; the distinguishing detail is in the audit
    // trail, where only an operator sees it.
    expect(notRegistered.message).toBe(cancelled.message);
    expect(notRegistered.reason).not.toBe(cancelled.reason);
  });

  it('carries no credential material in any refusal', () => {
    const decisions = [
      decideGoogleLink({ identity: IDENTITY }),
      decideGoogleLink({ identity: IDENTITY, credentialsByEmail: [credential({ password_hash: '$2a$10$secret' })], allowedDomains: ['other.test'] }),
    ];
    for (const decision of decisions) {
      expect(JSON.stringify(decision)).not.toContain('$2a$10$');
    }
  });
});
