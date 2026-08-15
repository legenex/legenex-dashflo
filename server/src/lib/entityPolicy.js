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
  PageSnapshot: operatorReadOnly(),

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

// Strip fields that must not leave the server. Accepts a record or an array.
export function projectRead(entityName, payload) {
  const denied = READ_DENY_FIELDS[entityName];
  if (!denied || payload == null) return payload;
  if (Array.isArray(payload)) return payload.map((row) => projectRead(entityName, row));
  if (typeof payload !== 'object') return payload;
  const out = { ...payload };
  for (const field of denied) delete out[field];
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
  WRITE_DENY_FIELDS,
  authorizeEntity,
  projectRead,
  sanitizeWrite,
};
