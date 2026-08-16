# DashFlo locked requirements

Version: 15 August 2026

Owner: Bru

Cutover target: 28 August 2026

## Outcome

Replace LeadByte and the Base44-hosted application with a self-hosted system that reliably receives, validates, suppresses, routes, delivers, bills, and reports on paid leads. Preserve the path to a dynamic multi-tenant SaaS without putting that full vision on the two-week critical path.

## Operational profile

- Current volume is below 100 leads per day.
- Observed peak requirement is 180 leads per day. Test above this level.
- Losing a paid lead is catastrophic.
- Intake must remain available during downstream timeouts and recoverable after application restart.
- Supplier response target is under five seconds and must preserve the current accepted or rejected contract unless Gate B approves a change.
- Initial verticals are MVA and Workers Compensation. More verticals must be configurable later.

## P0 cutover requirements

### Security and access

- Registration is invite-only in production and enforced server-side.
- Initial owner bootstrap is explicit and race-safe.
- Production refuses default or missing auth secrets.
- HTTP-only secure cookie sessions, CSRF protection, rate limits, bounded request bodies, and no persistent JWT in browser local storage.
- Generic entity access denies by default and applies explicit action, field, and row policies.
- Generic function invocation requires authentication by default. Public functions use a reviewed allowlist and their own signature or API-key checks.
- Buyer and supplier portals are server-scoped and cannot override their linked identity.
- Supplier API keys are hash-only. Buyer delivery credentials are encrypted or externally stored and represented by opaque references.
- Audit logs do not contain secrets or unnecessary PII.

### Intake durability

- All real sources reach one canonical processing service: supplier HTTP, Meta, owned forms, calls, CSV, and recovery jobs.
- Source authentication occurs before normal receipt capture unless a reviewed ADR creates a quarantined unauthenticated channel.
- A sanitized receipt commits before enrichment, business validation, delivery, or billing.
- Database constraints enforce transport idempotency and safe worker claiming.
- Every committed receipt reaches exactly one terminal business outcome or remains visibly retryable.
- Replay after crash cannot double-deliver or double-bill.
- External dependencies have explicit timeouts and bounded retry classes.
- Simulations, validations, and dry runs never create live receipts, deliveries, conversion events, or billing entries unless their contract explicitly calls for a sandbox receipt type.

### Global do-not-contact

- Global DNC is the first business validation after durable capture.
- Match normalized phone and email with keyed hashes.
- Support required scope, status, effective dates, reason, source, actor, and immutable history.
- Support operator search, controlled add or expire, bulk import, and audited export.
- Suppressed leads are retained with a stable rejection reason and never contacted or delivered.
- Enforcement is identical across every real intake source.

### Validation and response

- Required fields, duplicate, phone, email, state or ZIP, and TrustedForm rules are configurable by campaign.
- Every rejection is retained with a stable machine reason and useful human explanation.
- Never silently drop invalid or failed leads.
- Never mint a TrustedForm certificate.

### Routing and delivery

- Route order is configurable per campaign.
- Support direct post and ping-post.
- Support exclusive, shared, and resale behavior.
- Support optional caps by buyer, campaign, state, day, week, month, and lifetime where configured.
- Support schedules, priority, weights, bid floors, fixed prices, and buyer status.
- Support HTTP, email, CRM, live-transfer metadata, and portal-pull destinations as required by configured buyers.
- Response parsing is destination-configurable and fixture-tested.
- Unsold leads can enter internal hold or retry and approved inbound resale flows.
- Buyer rejection, timeout, network failure, malformed response, duplicate, and acceptance remain distinct outcomes.
- Delivery attempts are immutable and idempotent.

### Identity and portals

- Add `buyer_record_id` and `buyer_code` without deleting or redefining legacy `buyer_id` during cutover.
- Reconcile and backfill legacy and native leads with an exception report.
- Buyer portal shows only that buyer's approved leads, delivery detail, feedback, and return actions.
- Supplier portal shows only that supplier's approved leads, volume, acceptance, conversion, payout, and approved profit view.
- Raw payloads, secrets, internal routing traces, other parties, and unapproved margin fields are withheld by default.

### Billing and money

- Preserve existing prepay, wallet, post-pay, net 7, net 15, net 30, credit-limit, and Xero-link behavior where proven.
- Buyer charges and supplier earnings use immutable ledger entries and idempotency keys.
- Support fixed, revenue-share, and profit-share supplier payouts.
- Returns adjust reporting and ledgers through explicit auditable entries, never silent mutation.
- Live invoice, payment, balance, and payout actions require Gate C or D approval.

### Data and configuration migration

- Recover existing buyers, suppliers, sources, campaigns, routes, destinations, caps, prices, schedules, mappings, and response rules automatically where possible.
- Ask Bru only about unresolved exceptions and credential references.
- Migrate twelve months of BigQuery reporting history with restartable batches and reconciliation.
- Preserve source identifiers and maintain an id map.
- Report source count, imported count, rejected count, duplicates, monetary totals, and sampled field parity.
- No migration artifact contains a live secret.

### Reliability and cutover

- Legacy remains authoritative in shadow mode.
- Native shadow is inert and cannot deliver, bill, or emit conversion events.
- Compare buyer, reason, price, cap, schedule, DNC, and outcome.
- Daily encrypted backups and a successful disposable restore drill.
- Health and readiness endpoints distinguish process health, database health, and backlog health.
- Alert on receipt backlog, queue age, delivery failure, auth anomalies, disk, database, backup, and reconciliation errors.
- Cut over one supplier at a time with a tested kill switch and rollback.

## P1 immediately after cutover

- Better revenue, margin, source, CPL, campaign, state, rejection, buyer-rate, and call reporting.
- App, email, and Slack notifications. WhatsApp can follow once credentials and message policy are approved.
- Bank reconciliation, ad-spend reconciliation, P and L, supplier payout workflow, and Xero invoice automation.
- Meta conversion reporting with replay-safe event ids.
- Configurable buyer and supplier onboarding improvements.

## P2 wider product

- Dynamic metric, table, chart, and dashboard builder backed by BigQuery.
- Tenant isolation and SaaS provisioning.
- Authenticator-app 2FA with recovery codes.
- Call routing and live transfers.
- Advanced aged-lead resale.
- Second-server design after 30 days of measured failure data or a business continuity requirement.

## Global acceptance rules

- Tests use disposable databases and local mock endpoints.
- No test sends email, messages, conversion events, buyer delivery, accounting calls, or bank calls to a live service.
- Every P0 path has positive, negative, timeout, retry, authorization, idempotency, and restart coverage where applicable.
- Migrations are additive and restartable.
- Every production change has rollback steps and observable success criteria.
- No claim is marked complete without a commit, command output, and behavior evidence.
