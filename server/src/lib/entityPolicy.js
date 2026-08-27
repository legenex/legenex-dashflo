// Generic entity route authorization.
//
// The route used to allow any authenticated user whenever an entity schema
// carried no row-level rule. Sixty of the ninety schemas carry no rule, so a
// buyer portal login could read and write buyers, suppliers, bank
// transactions, invoices, wallets, delivery credentials, raw supplier API keys
// and the user table through the generic route.
//
// This module inverts that. An entity that is not listed here is denied for
// everyone, on every action. Being listed grants exactly the actions named for
// exactly the role classes named, and nothing else.
//
// Backend functions are unaffected: they reach entities through
// createServerClient, not through this route, and carry their own checks.

// ── Role classes ────────────────────────────────────────────────────────────
//
// Portal accounts are their own class and are denied the generic route
// outright. The buyer and supplier portal pages never call it: they read
// through portalData and supplierPortalData, which apply their own server-side
// projections. Denying the class closes the cross-tenant hole without removing
// anything the portals actually use.

export const ROLE = {
  ANONYMOUS: 'anonymous',
  PORTAL: 'portal',
  MANAGER: 'manager',
  ADMIN: 'admin',
  OWNER: 'owner',
  UNKNOWN: 'unknown',
};

export function resolveRoleClass(user) {
  if (!user) return ROLE.ANONYMOUS;

  // A linked party id makes an account a portal account regardless of what
  // its role fields say. This is checked first so that a portal account which
  // also carries an operator role cannot escape its scope.
  if (user.linked_buyer_id || user.linked_supplier_id) return ROLE.PORTAL;

  const baseRole = String(user.base_role || '').toLowerCase();
  if (baseRole === 'buyer' || baseRole === 'supplier') return ROLE.PORTAL;
  if (baseRole === 'owner') return ROLE.OWNER;
  if (baseRole === 'admin') return ROLE.ADMIN;
  if (baseRole === 'manager') return ROLE.MANAGER;

  // Fall back to the platform role only when base_role says nothing.
  if (!baseRole && String(user.role || '').toLowerCase() === 'admin') return ROLE.ADMIN;

  return ROLE.UNKNOWN;
}

const OWNER_ADMIN = [ROLE.OWNER, ROLE.ADMIN];
const OPERATORS = [ROLE.OWNER, ROLE.ADMIN, ROLE.MANAGER];

// ── Policy profiles ─────────────────────────────────────────────────────────

// Day to day operational records: operators may do everything.
const operatorFull = () => ({
  read: OPERATORS, create: OPERATORS, update: OPERATORS, delete: OPERATORS,
});

// Operators may read and write, but only owner and admin may delete. Used
// where a delete destroys audit value or money history.
const operatorNoDelete = () => ({
  read: OPERATORS, create: OPERATORS, update: OPERATORS, delete: OWNER_ADMIN,
});

// Everyone operational may read, but only owner and admin may change it.
const readOperatorWriteAdmin = () => ({
  read: OPERATORS, create: OWNER_ADMIN, update: OWNER_ADMIN, delete: OWNER_ADMIN,
});

// Configuration and credential adjacent records: owner and admin only.
const adminOnly = () => ({
  read: OWNER_ADMIN, create: OWNER_ADMIN, update: OWNER_ADMIN, delete: OWNER_ADMIN,
});

// Internal owner tooling. Not admin, not a permission key, owner alone. Used by
// the Progress Control Center, which holds findings, migration risk, review
// state and internal notes. See lib/progressAccess.js for why the boundary is
// the owner rather than a grantable permission.
const ownerOnly = () => ({
  read: [ROLE.OWNER], create: [ROLE.OWNER], update: [ROLE.OWNER], delete: [ROLE.OWNER],
});

// Read only for everyone operational. Written by backend functions.
const operatorReadOnly = () => ({
  read: OPERATORS, create: [], update: [], delete: [],
});

// ── The policy table ────────────────────────────────────────────────────────
//
// Anything absent from this table is denied. Adding an entity here is a
// deliberate act that should be reviewed.

export const ENTITY_POLICY = {
  // Leads and lead flow.
  Lead: operatorNoDelete(),
  LeadSource: operatorFull(),
  CallRecord: operatorNoDelete(),
  Delivery: operatorNoDelete(),
  SubDelivery: operatorNoDelete(),

  // Routing configuration.
  Campaign: operatorFull(),
  RouteGroup: operatorFull(),
  RouteMember: operatorFull(),
  Vertical: operatorFull(),
  Brand: operatorFull(),
  FieldMapping: operatorFull(),
  ResponseMapping: operatorFull(),
  CustomCalculation: operatorFull(),
  CustomField: operatorFull(),
  StateStatus: operatorFull(),

  // Counterparties.
  Buyer: operatorNoDelete(),
  Supplier: operatorNoDelete(),
  SupplierSource: operatorFull(),
  BuyerOnboarding: operatorFull(),
  BuyerStateCpl: operatorFull(),

  // Money. Readable by operators, written by owner and admin, never deletable
  // through the generic route.
  Invoice: readOperatorWriteAdmin(),
  BuyerPayment: readOperatorWriteAdmin(),
  SupplierPayout: readOperatorWriteAdmin(),
  WalletTransaction: operatorReadOnly(),
  BillingRun: readOperatorWriteAdmin(),
  BankTransaction: { read: OWNER_ADMIN, create: [], update: OWNER_ADMIN, delete: [] },

  // Advertising.
  AdSpend: operatorFull(),
  AdSpendMapping: operatorFull(),
  AdCreativeMeta: operatorFull(),

  // Operational visibility. Written by backend functions.
  ErrorLog: operatorReadOnly(),
  NotificationEvent: operatorFull(),
  AuditRun: operatorReadOnly(),
  AuditFinding: operatorReadOnly(),
  Report: operatorFull(),

  // ── Progress Control Center. Owner only. ──────────────────────────────────
  //
  // These were absent from this table, which denied them to everyone including
  // the owner, so the Control Center could not read its own records through
  // this route. Listing them owner-only restores the surface for the one
  // account that is meant to have it and keeps it closed to every other role.
  //
  // The set is defined in lib/progressAccess.js so the policy, the backend
  // functions and the tests cannot drift apart.
  ProgressPage: ownerOnly(),
  ProgressSnapshot: ownerOnly(),
  ReleaseGate: ownerOnly(),
  ReviewThread: ownerOnly(),
  ChangeRequest: ownerOnly(),
  PromptDraft: ownerOnly(),
  MigrationRequirement: ownerOnly(),
  VerificationRecord: ownerOnly(),

  // Screenshots of internal application pages, captured for owner review. The
  // images themselves are internal material, so this moved from operator read
  // to owner only alongside the rest of the Control Center.
  PageSnapshot: ownerOnly(),

  // Operator tooling.
  ImportTemplate: operatorFull(),
  PayloadTest: operatorFull(),
  KnowledgeDoc: operatorFull(),
  ChatConversation: operatorFull(),
  ChatMemory: operatorFull(),
  OnboardingEmailTemplate: operatorFull(),

  // Configuration, integration and credential adjacent. Owner and admin only.
  AppSettings: adminOnly(),
  ApiConnector: adminOnly(),
  LeadByteConnector: adminOnly(),
  HlrSettings: adminOnly(),
  EmailValidationSettings: adminOnly(),
  BotConfig: adminOnly(),
  NotificationRule: adminOnly(),
  Webhook: adminOnly(),
  OutboundWebhook: adminOnly(),
  InboundWebhookRoute: adminOnly(),
  PullSource: adminOnly(),
  ReferenceKey: adminOnly(),

  // Secret bearing. Owner and admin only, and the secret material itself is
  // stripped from every response by the field projection below.
  ApiKey: adminOnly(),
  IntegrationConfig: adminOnly(),

  // Do-not-contact. Task I2. Operators run the list day to day, so they can
  // read and search it, but nobody deletes through this route: the requirement
  // is immutable history, and an entry is retired by expiring it, not by
  // removing the evidence that it existed. Creating and expiring go through
  // the dncManage service function, which hashes the contact server-side, so
  // create and update are closed here too.
  DncEntry: { read: OPERATORS, create: [], update: [], delete: [] },

  // The user table. Owner and admin only, and role escalation fields are not
  // writable through the generic route.
  User: adminOnly(),
};

// ── Field projections ───────────────────────────────────────────────────────
//
// Fields that must never leave the server through the generic route, even for
// an owner. Reading a credential back out of the database is not a thing this
// route does; rotating one is a deliberate action through a service function.

export const READ_DENY_FIELDS = {
  // The raw supplier key and its hash. The UI lists key_prefix and sees the
  // full value once, in the response to issueApiKey, which mints it. The hash
  // is withheld too: it is offline-attackable credential material, and the
  // public posting spec derives its access token from it.
  ApiKey: ['key', 'key_hash'],
  Buyer: ['buyer_api_key'],
  // The credential blob for an integration. Read it back through no route.
  // Writes go to the saveIntegrationConfig service function, which merges.
  IntegrationConfig: ['config'],
  // A suppression list is a list of people who asked not to be contacted, so
  // it is exactly the population that must not leak. The hash is withheld
  // because it is a stable per-person identifier: anyone holding it can
  // correlate the same person across exports even without reversing it.
  // Operators see contact_display, which is masked.
  DncEntry: ['contact_hash'],
};

// Fields whose VALUE must be redacted (not deleted outright) before leaving
// the server: the field is legitimately needed by the UI (an operator edits
// their own delivery's headers), but a HISTORICAL row could carry a real
// secret typed into it by mistake, since the contract (credential_ref stays
// server-side, resolved only at send time) is a convention, not a runtime
// guarantee for rows written before it existed. This is a defense-in-depth
// backstop, not the primary control - the primary control is that a
// credential never has a reason to be typed into a header in the first
// place - so it deliberately errs toward over-redacting a plausible secret
// key name rather than under-redacting one.
// "x_key" covers LeadByte's own X_KEY outbound auth header by name (see
// docs/BASE44-BOUNDARY.md).
const HEADER_SECRET_KEYS = ['authorization', 'api_key', 'apikey', 'x-api-key', 'x_key', 'password', 'secret', 'token', 'bearer', 'cookie'];
const isSecretHeaderKey = (k) => HEADER_SECRET_KEYS.some((s) => String(k || '').toLowerCase().includes(s));
function redactHeaderSecrets(raw) {
  if (raw == null || raw === '') return raw;
  let parsed;
  // A malformed (non-JSON) string is exactly the historical-row case this
  // function exists to guard: fail CLOSED (a safe placeholder), not open
  // (the original, unexamined string) - the whole point is that this value
  // cannot be trusted to be free of secret material.
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return '[unreadable, redacted for safety]'; }
  if (!parsed || typeof parsed !== 'object') return '[unreadable, redacted for safety]';

  let out;
  if (Array.isArray(parsed)) {
    // LeadByteConnector.headers shape: [{key, value}, ...]. Anything that
    // does not actually match that shape is not a recognized header list -
    // fail closed the same as any other unrecognized value, rather than
    // passing an unvalidated array element through untouched.
    const isKeyValueRow = (row) => row && typeof row === 'object' && !Array.isArray(row) && 'key' in row;
    if (!parsed.every(isKeyValueRow)) return '[unreadable, redacted for safety]';
    out = parsed.map((row) => (isSecretHeaderKey(row.key) ? { ...row, value: '[redacted]' } : row));
  } else {
    // SubDelivery.headers shape: { headerName: value, ... }.
    out = {};
    for (const [k, v] of Object.entries(parsed)) {
      out[k] = isSecretHeaderKey(k) ? '[redacted]' : v;
    }
  }
  return typeof raw === 'string' ? JSON.stringify(out) : out;
}

export const READ_TRANSFORM_FIELDS = {
  SubDelivery: { headers: redactHeaderSecrets },
  LeadByteConnector: { headers: redactHeaderSecrets },
};

// Fields that cannot be set or changed through the generic route, because
// doing so would let a caller escalate their own privileges or rewrite an
// audit trail.
export const WRITE_DENY_FIELDS = {
  User: ['role', 'base_role', 'permissions', 'linked_buyer_id', 'linked_supplier_id'],
  Lead: ['created_by'],
  // Task S4. Read-denying a credential while leaving it writable is not
  // protection: a caller that cannot read the stored value can still overwrite
  // it, and the settings dialogs did exactly that by accident, saving a form
  // they had loaded blank and destroying the stored secret.
  //
  // Secret material is now write-denied here and owned by service functions
  // that read, merge, and write server-side:
  //   ApiKey.key / key_hash   -> issueApiKey
  //   IntegrationConfig.config -> saveIntegrationConfig
  ApiKey: ['key', 'key_hash'],
  Buyer: ['buyer_api_key'],
  IntegrationConfig: ['config'],
};

// ── Decisions ───────────────────────────────────────────────────────────────

export function authorizeEntity(user, entityName, action) {
  const roleClass = resolveRoleClass(user);

  if (roleClass === ROLE.ANONYMOUS) {
    return { allowed: false, status: 401, reason: 'Authentication required' };
  }
  if (roleClass === ROLE.PORTAL) {
    return {
      allowed: false,
      status: 403,
      reason: 'Portal accounts cannot use the generic entity route',
    };
  }
  if (roleClass === ROLE.UNKNOWN) {
    return { allowed: false, status: 403, reason: 'Role is not permitted on this route' };
  }

  const policy = ENTITY_POLICY[entityName];
  if (!policy) {
    return { allowed: false, status: 403, reason: 'Entity is not exposed on the generic route' };
  }

  const allowedRoles = policy[action];
  if (!Array.isArray(allowedRoles) || !allowedRoles.includes(roleClass)) {
    return { allowed: false, status: 403, reason: `Not permitted to ${action} ${entityName}` };
  }

  return { allowed: true, roleClass };
}

// Strip fields that must not leave the server, and redact fields whose value
// (not the whole field) must never carry a secret. Accepts a record or array.
export function projectRead(entityName, payload) {
  const denied = READ_DENY_FIELDS[entityName];
  const transforms = READ_TRANSFORM_FIELDS[entityName];
  if (!denied && !transforms) return payload;
  if (payload == null) return payload;
  if (Array.isArray(payload)) return payload.map((row) => projectRead(entityName, row));
  if (typeof payload !== 'object') return payload;
  const out = { ...payload };
  if (denied) for (const field of denied) delete out[field];
  if (transforms) {
    for (const [field, transform] of Object.entries(transforms)) {
      if (Object.prototype.hasOwnProperty.call(out, field)) out[field] = transform(out[field]);
    }
  }
  return out;
}

// Strip fields that must not be written. Accepts a record or an array.
export function sanitizeWrite(entityName, payload) {
  const denied = WRITE_DENY_FIELDS[entityName];
  if (!denied || payload == null) return payload;
  if (Array.isArray(payload)) return payload.map((row) => sanitizeWrite(entityName, row));
  if (typeof payload !== 'object') return payload;
  const out = { ...payload };
  for (const field of denied) delete out[field];
  return out;
}

export default {
  ROLE,
  resolveRoleClass,
  ENTITY_POLICY,
  READ_DENY_FIELDS,
  READ_TRANSFORM_FIELDS,
  WRITE_DENY_FIELDS,
  authorizeEntity,
  projectRead,
  sanitizeWrite,
};
