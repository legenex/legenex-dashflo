// GENERATED FILE. Do not edit.
// Source: src/lib/systemTransfer.js
// Regenerate: node scripts/generate-transfer-catalog.mjs

// System Transfer catalog.
//
// Single source of truth for what a system export bundle contains, how records
// reference each other across entities, and what must never leave the app.
//
// Consumed by the Settings > Export / Import panel and, via
// scripts/generate-transfer-catalog.mjs, by the systemExport and systemImport
// backend functions (Deno functions cannot import outside their own folder, so
// they receive a generated copy). Edit here, then regenerate.

export const BUNDLE_VERSION = 1;
export const REDACTED = '__REDACTED__';

// ---------------------------------------------------------------------------
// Sections: what the operator ticks in the UI. Every entity appears exactly once.
// ---------------------------------------------------------------------------

export const SECTIONS = [
  {
    key: 'schemas',
    label: 'Entity schemas',
    group: 'Foundation',
    description: 'The entity definitions themselves. Required first when seeding an empty app.',
    entities: [],
    isSchemas: true,
  },
  {
    key: 'settings',
    label: 'Settings and workspace',
    group: 'Foundation',
    description: 'Workspace defaults, brands, verticals, dispositions, notification rules, templates.',
    entities: ['AppSettings', 'Brand', 'Vertical', 'Disposition', 'ReferenceKey', 'EmailValidationSettings',
      'HlrSettings', 'NotificationRule', 'OnboardingEmailTemplate', 'ImportTemplate', 'Report', 'BotConfig',
      'KnowledgeDoc'],
  },
  {
    key: 'fields',
    label: 'Fields and calculations',
    group: 'Foundation',
    description: 'Custom field catalog, inbound field mapping, calculated fields, response mapping.',
    entities: ['CustomField', 'FieldMapping', 'CustomCalculation', 'ResponseMapping'],
  },
  {
    key: 'buyers',
    label: 'Buyers',
    group: 'Commercial',
    description: 'Buyer records, CPL rules, per state pricing, wallets, onboarding, contracts.',
    entities: ['Buyer', 'BuyerCplRule', 'BuyerStateCpl', 'BuyerWallet', 'BuyerOnboarding', 'ContractVersion'],
  },
  {
    key: 'suppliers',
    label: 'Suppliers',
    group: 'Commercial',
    description: 'Supplier records, sources, state coverage, ad accounts, lead sources, API keys.',
    entities: ['Supplier', 'SupplierSource', 'SupplierStateCoverage', 'SupplierAdAccount', 'LeadSource', 'ApiKey'],
  },
  {
    key: 'distribution',
    label: 'Lead distribution',
    group: 'Routing',
    description: 'Campaigns, route groups and members, deliveries and endpoint tiers, published config, state status.',
    entities: ['Campaign', 'RouteGroup', 'RouteMember', 'Delivery', 'SubDelivery', 'RouteConfigVersion', 'StateStatus'],
  },
  {
    key: 'connectors',
    label: 'Connectors and integrations',
    group: 'Routing',
    description: 'Outbound connectors, webhooks, pull sources, integrations. Always imported disabled.',
    entities: ['LeadByteConnector', 'ApiConnector', 'Webhook', 'OutboundWebhook', 'InboundWebhookRoute',
      'PullSource', 'IntegrationConfig', 'MetaConnection', 'MetaLeadFormMapping', 'AdSpendMapping'],
  },
  {
    key: 'leads',
    label: 'Leads and calls',
    group: 'Transactional',
    description: 'Lead records, call records, verification, returns, buyer feedback.',
    entities: ['Lead', 'CallRecord', 'VerificationRecord', 'ReturnRequest', 'BuyerFeedback', 'CertBackupStore'],
  },
  {
    key: 'finance',
    label: 'Finance',
    group: 'Transactional',
    description: 'Invoices, billing runs and line items, payments, payouts, wallet ledger, bank feed, ad spend.',
    entities: ['Invoice', 'BillingRun', 'BillingLineItem', 'BuyerPayment', 'SupplierPayout', 'WalletTransaction',
      'BankTransaction', 'AdSpend', 'AdCreativeMeta'],
  },
  {
    key: 'logs',
    label: 'Logs and traces',
    group: 'Transactional',
    description: 'Delivery attempts, routing traces, error logs, audit trail, counters. Usually not worth moving.',
    entities: ['ErrorLog', 'DeliveryAttempt', 'RouteDecisionTrace', 'DistributionAudit', 'AuditLog',
      'NotificationEvent', 'MetaSyncRun', 'StateChangeEvent', 'BidAttempt', 'DestinationHealth', 'CapCounter',
      'CapReservation', 'Counter', 'PayloadTest'],
  },
  {
    key: 'users',
    label: 'Users and roles',
    group: 'Access',
    description: 'User records with their permission maps, and pending invitations.',
    entities: ['User', 'Invitation'],
  },
  {
    key: 'progress',
    label: 'Progress control centre',
    group: 'Internal',
    description: 'Findings, change requests, prompts, review threads, release gates, assistant memory.',
    entities: ['ProgressPage', 'ProgressSnapshot', 'AuditRun', 'AuditFinding', 'ChangeRequest', 'PromptDraft',
      'ReviewThread', 'ReleaseGate', 'MigrationRequirement', 'PageSnapshot', 'BenchmarkCriterion',
      'ChatConversation', 'ChatMemory'],
  },
];

export const ALL_SECTION_KEYS = SECTIONS.map((s) => s.key);
export const ALL_ENTITIES = SECTIONS.flatMap((s) => s.entities);

export function entitiesForSections(keys) {
  const set = new Set(keys || []);
  return SECTIONS.filter((s) => set.has(s.key)).flatMap((s) => s.entities);
}

// ---------------------------------------------------------------------------
// Secrets. Never leave the app, in any bundle, for any operator.
// ---------------------------------------------------------------------------

// Exact field names whose value is replaced with REDACTED.
export const SECRET_FIELDS = {
  ApiKey: ['key'],
  ApiConnector: ['fb_access_token'],
  Buyer: ['buyer_api_key'],
  BotConfig: ['bot_key'],
  InboundWebhookRoute: ['token_hash'],
  LeadSource: ['webhook_key'],
  MetaConnection: ['token'],
  OutboundWebhook: ['api_key'],
  PullSource: ['api_key'],
  Webhook: ['secret'],
};

// Free text blobs that in practice carry Authorization bearers and API keys.
// Values are parsed and scrubbed key by key rather than dropped wholesale, so
// the shape of the config survives the move.
export const SECRET_BLOB_FIELDS = {
  ApiConnector: ['headers'],
  LeadByteConnector: ['headers'],
  Webhook: ['headers'],
  OutboundWebhook: ['headers'],
  IntegrationConfig: ['config'],
};

// URL fields where credentials commonly ride in the query string.
export const SECRET_URL_FIELDS = {
  ApiConnector: ['target_url'],
  LeadByteConnector: ['target_url'],
  Webhook: ['url'],
  OutboundWebhook: ['url'],
  PullSource: ['url'],
  SubDelivery: ['url'],
};

export const SECRET_KEY_PATTERN = /(auth|key|secret|token|password|passwd|pwd|bearer|sig|signature|credential)/i;

// Fields stripped entirely: operational state that must never be carried into
// another app. distribution_mode is set only by distributionSetMode, never by
// an import.
export const FIELD_STRIP = {
  AppSettings: ['distribution_mode'],
};

// Imported records of these entities are forced to these values regardless of
// what the bundle says, so nothing starts firing at a live endpoint on arrival.
export const IMPORT_FORCE = {
  LeadByteConnector: { enabled: false, is_default: false },
  ApiConnector: { enabled: false },
  Webhook: { enabled: false },
  OutboundWebhook: { enabled: false },
  PullSource: { enabled: false },
  InboundWebhookRoute: { enabled: false },
  Campaign: { status: 'draft' },
  SubDelivery: { active: false },
  Delivery: { active: false },
};

// ---------------------------------------------------------------------------
// Reference graph. Import rewrites these before insert, in ENTITY_ORDER.
//
// kind 'id'        single record id, remapped old -> new
// kind 'idsJson'   JSON array of record ids held in a string field
// kind 'code'      NOT a record id. A natural key or an external system id.
//                  Never remapped. Listed so the importer can validate it
//                  resolves, and so nobody later mistakes it for a reference.
//
// Verified against live data 14 August 2026: Lead.buyer_id holds buyer CODES
// (T1, AG1, AG2) despite its schema description claiming a record reference.
// Remapping it would destroy attribution.
// ---------------------------------------------------------------------------

export const REFS = {
  ApiKey: { supplier_id: { kind: 'id', target: 'Supplier' } },
  BillingLineItem: {
    billing_run_id: { kind: 'id', target: 'BillingRun' },
    supplier_id: { kind: 'id', target: 'Supplier' },
    campaign_id: { kind: 'id', target: 'Campaign' },
  },
  BillingRun: {
    buyer_id: { kind: 'id', target: 'Buyer' },
    supplier_id: { kind: 'id', target: 'Supplier' },
    invoice_id: { kind: 'id', target: 'Invoice' },
  },
  Buyer: { campaign_ids: { kind: 'idsJson', target: 'Campaign' } },
  BuyerCplRule: {
    buyer_id: { kind: 'id', target: 'Buyer' },
    campaign_id: { kind: 'id', target: 'Campaign' },
  },
  BuyerFeedback: {
    buyer_id: { kind: 'id', target: 'Buyer' },
    lead_id: { kind: 'id', target: 'Lead' },
  },
  BuyerOnboarding: { buyer_id: { kind: 'id', target: 'Buyer' } },
  BuyerPayment: {
    buyer_id: { kind: 'id', target: 'Buyer' },
    invoice_id: { kind: 'id', target: 'Invoice' },
  },
  BuyerStateCpl: { buyer_id: { kind: 'id', target: 'Buyer' } },
  BuyerWallet: { buyer_id: { kind: 'id', target: 'Buyer' } },
  CallRecord: {
    lead_id: { kind: 'id', target: 'Lead' },
    source_id: { kind: 'id', target: 'PullSource' },
    call_id: { kind: 'code' },
    caller_id: { kind: 'code' },
  },
  Campaign: {
    supplier_ids: { kind: 'idsJson', target: 'Supplier' },
    campaign_id: { kind: 'code' },
  },
  ContractVersion: { campaign_id: { kind: 'id', target: 'Campaign' } },
  Delivery: {
    buyer_id: { kind: 'id', target: 'Buyer' },
    vertical_id: { kind: 'id', target: 'Vertical' },
  },
  DeliveryAttempt: {
    lead_id: { kind: 'id', target: 'Lead' },
    sub_delivery_id: { kind: 'id', target: 'SubDelivery' },
    destination_id: { kind: 'id', target: 'LeadByteConnector' },
  },
  InboundWebhookRoute: { api_key_id: { kind: 'id', target: 'ApiKey' } },
  Invoice: { buyer_id: { kind: 'id', target: 'Buyer' } },
  Lead: {
    buyer_id: { kind: 'code' },
    // Task R1. Added additively beside the overloaded legacy buyer_id, and
    // unlike it this one is always a Buyer record id, so it is remapped.
    buyer_record_id: { kind: 'id', target: 'Buyer' },
    campaign_id: { kind: 'code' },
    supplier_key_id: { kind: 'id', target: 'ApiKey' },
    lead_id: { kind: 'code' },
    leadbyte_lead_id: { kind: 'code' },
    leadbyte_queue_id: { kind: 'code' },
    leadbyte_rejection_id: { kind: 'code' },
    import_batch_id: { kind: 'code' },
  },
  LeadSource: {
    api_key_id: { kind: 'id', target: 'ApiKey' },
    campaign_id: { kind: 'id', target: 'Campaign' },
    sheet_id: { kind: 'code' },
  },
  MetaLeadFormMapping: {
    supplier_id: { kind: 'id', target: 'Supplier' },
    connection_id: { kind: 'id', target: 'MetaConnection' },
    campaign_id: { kind: 'code' },
    form_id: { kind: 'code' },
    page_id: { kind: 'code' },
  },
  ReturnRequest: {
    buyer_id: { kind: 'id', target: 'Buyer' },
    lead_id: { kind: 'id', target: 'Lead' },
  },
  RouteConfigVersion: {
    campaign_id: { kind: 'id', target: 'Campaign' },
    route_group_id: { kind: 'id', target: 'RouteGroup' },
  },
  RouteGroup: {
    campaign_id: { kind: 'id', target: 'Campaign' },
    config_version_id: { kind: 'id', target: 'RouteConfigVersion' },
  },
  RouteMember: {
    route_group_id: { kind: 'id', target: 'RouteGroup' },
    buyer_id: { kind: 'id', target: 'Buyer' },
    sub_delivery_id: { kind: 'id', target: 'SubDelivery' },
    destination_id: { kind: 'id', target: 'LeadByteConnector' },
  },
  SubDelivery: { delivery_id: { kind: 'id', target: 'Delivery' } },
  Supplier: { campaign_ids: { kind: 'idsJson', target: 'Campaign' } },
  SupplierAdAccount: {
    supplier_id: { kind: 'id', target: 'Supplier' },
    connection_id: { kind: 'id', target: 'MetaConnection' },
    ad_account_id: { kind: 'code' },
    business_id: { kind: 'code' },
  },
  SupplierSource: { supplier_id: { kind: 'id', target: 'Supplier' } },
  SupplierStateCoverage: { supplier_id: { kind: 'id', target: 'Supplier' } },
  User: {
    linked_buyer_id: { kind: 'id', target: 'Buyer' },
    linked_supplier_id: { kind: 'id', target: 'Supplier' },
  },
  WalletTransaction: { buyer_id: { kind: 'id', target: 'Buyer' } },

  // ── References that exist so remapping stays transitive ───────────────────
  //
  // A record id only ever changes when the importer matches a source record to
  // an existing DashFlo record through a natural key, so the entities whose ids
  // can move are exactly the ones in NATURAL_KEYS. Every field anywhere in the
  // catalog that points at one of those entities has to be declared here, or
  // remapping the parent leaves the child pointing at an id that no longer
  // exists. The block above was written for parent/child structure; this one is
  // written for that specific transitive property.
  //
  // Deliberately NOT declared: polymorphic id fields whose target depends on a
  // sibling column (KeyAuditEvent.subject_id with subject_type,
  // DistributionAudit.entity_id, CapCounter.scope_id), and external system
  // identifiers that merely end in _id (Meta ad_account_id, Stripe and Xero
  // customer ids, Meta campaign ids). Neither is a DashFlo record id and
  // rewriting either would corrupt attribution.
  AdSpend: { supplier_id: { kind: 'id', target: 'Supplier' } },
  BuyerApiKey: { buyer_id: { kind: 'id', target: 'Buyer' } },
  ChatConversation: { user_id: { kind: 'id', target: 'User' } },
  ChatMemory: { user_id: { kind: 'id', target: 'User' } },
  MetaSyncRun: { supplier_id: { kind: 'id', target: 'Supplier' } },
  SystemKey: { owner_user_id: { kind: 'id', target: 'User' } },
  StateChangeEvent: {
    triggered_by_buyer_id: { kind: 'id', target: 'Buyer' },
    triggered_by_user_id: { kind: 'id', target: 'User' },
    notified_supplier_ids: { kind: 'idsJson', target: 'Supplier' },
  },
};

// Natural keys give idempotent re-import: match on these before creating, so a
// second import updates rather than duplicates.
export const NATURAL_KEYS = {
  Brand: 'brand_code',
  Buyer: 'buyer_code',
  Campaign: 'campaign_id',
  CustomField: 'field_name',
  Disposition: 'name',
  // The stable Meta identifier from GET /me, not a secret: SECRET_FIELDS and
  // MIGRATION_SECRETS_EXPECTED name only MetaConnection.token. A production
  // MetaConnection is one durable relationship with one real Meta Business
  // Manager account, and this is that account's own external id, the same
  // role Supplier.sid plays for a real-world supplier.
  MetaConnection: 'connected_account_id',
  Supplier: 'sid',
  SupplierSource: 'source_code',
  User: 'email',
  Vertical: 'name',
};

// Additional deterministic identity fields for a relationship reference only,
// tried strictly after the primary NATURAL_KEYS field above and never for
// record identity or collision detection. In priority order per entity, and
// a value is accepted only when it names exactly one candidate: a value
// matching more than one record fails closed exactly like a NATURAL_KEYS
// collision does, at whichever field found the ambiguity.
//
// Buyer.leadbyte_bid is the one entry, and it is not a guess: the Buyer
// schema itself documents the exact ambiguity this exists for -- "LeadByte
// buyer id. Nullable. Defaults to the buyer_code value when a code is
// allocated" -- meaning it usually equals buyer_code and sometimes does not,
// which is precisely the shape of drift a relationship reference can be
// written against. It is the same field lib/buyerIdentity.js already
// resolves through for Lead.buyer_id, in the same priority position (after
// the record id, after the primary code): reused here, not reinvented. It is
// not secret: SECRET_FIELDS and MIGRATION_SECRETS_EXPECTED name only
// Buyer.buyer_api_key.
export const LEGACY_IDENTITY_ALIASES = {
  Buyer: ['leadbyte_bid'],
};

// Import order. Parents before children so every reference resolves.
export const ENTITY_ORDER = [
  'AppSettings', 'Brand', 'Vertical', 'Disposition', 'ReferenceKey', 'EmailValidationSettings', 'HlrSettings',
  'NotificationRule', 'OnboardingEmailTemplate', 'ImportTemplate', 'Report', 'BotConfig', 'KnowledgeDoc',
  'CustomField', 'FieldMapping', 'CustomCalculation', 'ResponseMapping',
  'Supplier', 'Buyer',
  'MetaConnection', 'IntegrationConfig',
  'ApiKey', 'SupplierSource', 'SupplierStateCoverage', 'SupplierAdAccount', 'LeadSource',
  'BuyerWallet', 'BuyerOnboarding',
  'Campaign', 'ContractVersion', 'BuyerCplRule', 'BuyerStateCpl',
  'Delivery', 'SubDelivery',
  'LeadByteConnector', 'ApiConnector', 'Webhook', 'OutboundWebhook', 'InboundWebhookRoute', 'PullSource',
  'MetaLeadFormMapping', 'AdSpendMapping',
  'RouteConfigVersion', 'RouteGroup', 'RouteMember', 'StateStatus',
  'Lead', 'CallRecord', 'VerificationRecord', 'CertBackupStore', 'ReturnRequest', 'BuyerFeedback',
  'Invoice', 'BillingRun', 'BillingLineItem', 'BuyerPayment', 'SupplierPayout', 'WalletTransaction',
  'BankTransaction', 'AdSpend', 'AdCreativeMeta',
  'ErrorLog', 'DeliveryAttempt', 'RouteDecisionTrace', 'DistributionAudit', 'AuditLog', 'NotificationEvent',
  'MetaSyncRun', 'StateChangeEvent', 'BidAttempt', 'DestinationHealth', 'CapCounter', 'CapReservation',
  'Counter', 'PayloadTest',
  'User', 'Invitation',
  'ProgressPage', 'ProgressSnapshot', 'AuditRun', 'AuditFinding', 'ChangeRequest', 'PromptDraft', 'ReviewThread',
  'ReleaseGate', 'MigrationRequirement', 'PageSnapshot', 'BenchmarkCriterion', 'ChatConversation', 'ChatMemory',
];

// the backend assigns these. They are exported for reference resolution and audit,
// and dropped on insert.
export const SYSTEM_FIELDS = ['id', 'created_date', 'updated_date', 'created_by', 'created_by_id', 'is_sample'];

export function sortForImport(entityNames) {
  const rank = new Map(ENTITY_ORDER.map((n, i) => [n, i]));
  return [...entityNames].sort((a, b) => (rank.get(a) ?? 999) - (rank.get(b) ?? 999));
}

// Owner-only encrypted Base44 migration bundle. Generated from the same
// catalog as the Base44 exporter; durable credentials travel only here.
export const MIGRATION_ONLY_ENTITIES = ['SystemKey', 'BuyerApiKey', 'KeyAuditEvent'];

export const MIGRATION_ENTITY_ORDER = [
  ...ENTITY_ORDER.slice(0, ENTITY_ORDER.indexOf('ApiKey')),
  'ApiKey', 'SystemKey', 'BuyerApiKey', 'KeyAuditEvent',
  ...ENTITY_ORDER.slice(ENTITY_ORDER.indexOf('ApiKey') + 1),
];

export const MIGRATION_DROP_RECORD = {
  IntegrationConfig: (row) => String(row?.name || '') === 'meta_oauth_state',
};

export const MIGRATION_DROP_FIELDS = {
  // Distribution mode is set by distributionSetMode and by nothing else. It was
  // already stripped from an outgoing export by FIELD_STRIP, but that is the
  // wrong end: it is the incoming direction that could flip a live DashFlo
  // instance into another system's distribution state. Dropped here so neither
  // bundle kind can carry it, on a create or on an update.
  AppSettings: ['distribution_mode'],
  Invitation: ['token', 'invite_token', 'accept_token'],
  User: ['password', 'password_hash', 'session_token', 'refresh_token'],
};

// ── Target state the migration is never allowed to overwrite ────────────────
//
// These fields belong to the DashFlo record, not to the source record. When the
// importer matches a source record onto an existing DashFlo row, the DashFlo
// value wins for every field named here and the source value is discarded.
//
// User is the case that matters. middleware/auth.js resolves the caller with
// repo('User').get(sub), so base_role, role and permissions on the User entity
// row ARE the live authorization, and linked_buyer_id / linked_supplier_id are
// what scope a portal account to one party. A source row carrying a different
// base_role would silently demote or promote a real account the moment identity
// matching found it, which is precisely what lib/googleAccountLink.js refuses to
// let a Google login do. The migration gets the same rule.
//
// Everything else about the user still migrates: name, timezone, and any
// profile field the source carries. Only the authorization surface is pinned.
// email is here for a different reason than the rest. It is mirrored in the
// auth_credentials table, which the importer cannot touch, so letting a source
// record rewrite the entity row would leave one half of a two-place identity
// pointing at a different address from the other. lib/googleAccountLink.js
// refuses to let a Google login rewrite it for the same reason. A user the
// package creates still gets the address the package carries.
export const MIGRATION_TARGET_PROTECTED_FIELDS = {
  User: ['email', 'role', 'base_role', 'permissions', 'linked_buyer_id', 'linked_supplier_id'],
};

// ── Explicit exclusions ─────────────────────────────────────────────────────
//
// Every record or field the migration deliberately leaves behind, with the rule
// that authorises it. The preview reports from this table, so an exclusion
// cannot be silent: if something is dropped it is named here with a count and a
// reason, and if it is not named here it is not dropped.
//
// scope 'record' removes whole records and therefore changes the reconciliation
// totals. scope 'field' removes named fields and leaves the record itself fully
// accounted for.
export const MIGRATION_EXCLUSION_RULES = [
  {
    key: 'integration_config.meta_oauth_state',
    entity: 'IntegrationConfig',
    scope: 'record',
    reason: 'Transient Meta OAuth handshake state. It expires in minutes and describes a browser round trip that has already finished.',
    rule: 'docs/BASE44-BOUNDARY.md: the encrypted migration export drops meta_oauth_state records.',
  },
  {
    key: 'user.authentication',
    entity: 'User',
    scope: 'field',
    fields: ['password', 'password_hash', 'session_token', 'refresh_token'],
    reason: 'Authentication material is DashFlo owned. Sessions and password hashes from the source system are not portable and must never be reinstated by an import.',
    rule: 'docs/BASE44-BOUNDARY.md: user password, hash, session and refresh fields are dropped. AGENTS.md section 19.',
  },
  {
    key: 'invitation.tokens',
    entity: 'Invitation',
    scope: 'field',
    fields: ['token', 'invite_token', 'accept_token'],
    reason: 'An acceptance token is a live authorization grant. Imported invitations are history and are additionally marked as such so they cannot authorize a sign in.',
    rule: 'docs/BASE44-BOUNDARY.md: invitation tokens are dropped. AGENTS.md section 19.',
  },
  {
    key: 'app_settings.distribution_mode',
    entity: 'AppSettings',
    scope: 'field',
    fields: ['distribution_mode'],
    reason: 'Distribution mode is live operational control of this instance and is set only by distributionSetMode.',
    rule: 'AGENTS.md section 25: distribution mode control is an integrator-only surface.',
  },
];

export const MIGRATION_SECRETS_EXPECTED = {
  ApiKey: ['key'],
  SystemKey: ['secret', 'client_id'],
  BuyerApiKey: ['key'],
  Buyer: ['buyer_api_key'],
  MetaConnection: ['token'],
  IntegrationConfig: ['config'],
  LeadByteConnector: ['headers', 'target_url'],
  ApiConnector: ['fb_access_token', 'headers', 'target_url'],
  PullSource: ['api_key', 'url'],
  Webhook: ['secret', 'headers', 'url'],
  OutboundWebhook: ['api_key', 'headers', 'url'],
  InboundWebhookRoute: ['token_hash'],
  LeadSource: ['webhook_key'],
  SubDelivery: ['url'],
  BotConfig: ['bot_key'],
};

export const MIGRATION_CRYPTO = {
  format: 'legenex-migration-v1',
  kdf: 'PBKDF2-SHA256',
  iterations: 600000,
  cipher: 'AES-GCM',
  key_bits: 256,
  salt_bytes: 16,
  iv_bytes: 12,
};

// The canonical migration envelope contract.
//
// MIGRATION_CRYPTO above is what a DashFlo-written export would emit. It is not
// the same question as what the importer must accept, and conflating the two is
// what broke owner migration import: the importer demanded exact equality with
// every value above, including iterations, while the only thing that actually
// produces these packages is the legacy Legenex dashboard exporter, which seals
// them at 100000 iterations. No package in circulation has ever carried 600000,
// so the importer could not accept any real export.
//
// So the two questions are separated here. Structure and algorithm are matched
// exactly, because accepting a different cipher or a shorter key would be a
// downgrade. The PBKDF2 work factor is matched against a policy range instead,
// because it is a cost parameter the exporter records in the package and the
// importer must reproduce to derive the same key. Reading it from the package
// is what makes an older legitimate export importable; bounding it is what
// keeps that from becoming a downgrade or a denial of service.
//
// iterations.min is the floor a package must meet to be considered safe. It is
// deliberately set at the supported exporter's value rather than below it, so
// the range admits real packages and nothing weaker. iterations.max bounds the
// work a single upload can ask the server to perform.
export const MIGRATION_FORMAT = {
  // Envelope versions this importer understands. Add a version here rather than
  // loosening a rule when the format genuinely changes.
  formats: ['legenex-migration-v1'],

  // Matched exactly. A package disagreeing on any of these is refused.
  kdf: 'PBKDF2-SHA256',
  cipher: 'AES-GCM',
  key_bits: 256,
  salt_bytes: 16,
  iv_bytes: 12,

  // Matched against a range, and the package's own value is what derives the key.
  iterations: { min: 100000, max: 10000000, preferred: 600000 },

  // Every key the crypto block may carry. An unrecognised key is refused rather
  // than ignored, so a package cannot smuggle an unreviewed crypto directive
  // past a validator that only checks the fields it happens to know about.
  crypto_keys_required: ['format', 'kdf', 'iterations', 'cipher', 'key_bits', 'salt_bytes', 'iv_bytes', 'salt'],
  crypto_keys_optional: [],
};
