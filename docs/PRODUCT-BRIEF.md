# DashFlo product brief from Bru

Consolidated from the completed planning answers supplied on 15 August 2026. `docs/REQUIREMENTS.md` turns these answers into delivery constraints. If the two files appear to conflict, stop only the affected decision and record it for the next human gate.

## Product and deadline

- Build a fully self-hosted DashFlo lead distribution, operations, billing, portal, and reporting system.
- Replace LeadByte and retire the Base44-hosted application.
- The critical order is: off LeadByte, off Base44 onto the self-hosted server, then stronger reporting.
- Target the cutover within two weeks.
- Bru wants the engineering and verification automated as far as safely possible.
- Losing a paid lead is catastrophic. Intake cannot depend on one downstream service being healthy.
- Current volume is under 100 leads per day, with a stated peak of 180 per day.

## Verticals and sources

- Initial verticals: Motor Vehicle Accident and Workers Compensation.
- More verticals must be configurable later.
- Intake sources: supplier HTTP posts, Meta lead ads, owned forms, calls, and CSV imports.
- Every real source must use the same canonical processing rules.
- Supplier API keys are required.

## Intake behavior

- Checks include duplicates, phone validation, required fields, state or ZIP rules, TrustedForm, and email validation where configured.
- Every rejected lead must be retained with its reason.
- Supplier response can be simple accepted or rejected, but the current integration contract must be preserved and measured.
- Desired response time is under five seconds.
- Custom calculations and supplier-specific field mappings are required.

## Suppression and consent

- LeadByte currently supplies suppression or do-not-contact behavior that must be replaced.
- Global suppression must cover every intake path.
- TrustedForm certificates must be stored and retrievable for consent evidence.
- The system must never generate or substitute a certificate.

## Routing and distribution

- Route order varies by campaign.
- Required modes include direct post, ping-post, exclusive, shared, and resale.
- All cap types should be available and optional per configured buyer or campaign.
- Relevant cap dimensions include buyer, campaign, state, daily, weekly, monthly, and lifetime.
- Unsold leads go to internal hold or retry and approved inbound resale flows.
- External returns and buyer feedback are routine and must be auditable.
- Routing must remain configurable rather than hard-coded to MVA.

## Buyer delivery

- There are more than 30 buyer destinations.
- Destination types include HTTP, email, CRM, live-transfer metadata, and portal pull.
- Each destination needs configurable field mapping, authentication reference, timeout, retry, and response parsing.
- Buyer response formats vary.
- Destination configuration must be recoverable and bulk-importable.
- Live credentials must not be put in import spreadsheets.

## Buyers and pricing

- Pricing varies by buyer, campaign, state, and arrangement.
- Buyer terms include upfront or prepay, net 15, and net 30. The current code also has net 7 and wallet modes that should be preserved if valid.
- Credit limits, wallets, invoices, payments, and returns must reconcile to lead outcomes.
- Buyer portal isolation is important.

## Suppliers and payouts

- Supplier payouts include fixed price, revenue share, and profit share.
- Supplier portal requirements include leads, volume, acceptance, conversion, and profit or payout visibility approved for that supplier.
- Supplier attribution and source-code compatibility must be preserved during migration.

## Calls

- Calls need reporting, billing, and lead matching.
- Call routing and live transfers can follow the core cutover unless a current buyer flow requires them.

## Reporting

Highest-value reports include:

- revenue and margin;
- lead volume by source;
- cost per lead and ad campaign performance;
- rejection reasons;
- buyer acceptance and conversion rates;
- call reporting;
- state and coverage reporting.

Longer-term DashFlo must support user-configurable metrics, tables, saved views, charts, and overview components rather than a fixed dashboard. BigQuery is the intended analytics foundation. The product should eventually be usable by other lead generators as SaaS.

## Money and accounting

- Required domains include buyer invoicing, ad spend, bank reconciliation, profit and loss, supplier payouts, and return adjustments.
- Xero invoice and payment links already exist in part and should be verified before building replacements.
- Money actions require immutable audit and explicit production approval.

## Advertising and notifications

- Meta conversion reporting is critical and must be idempotent.
- Desired operational notifications include in-app, email, Slack, and eventually WhatsApp.
- Alert destinations that need live credentials remain human-gated.

## Users and authentication

- Buyer and supplier portals are important.
- Stronger authentication is required. Email verification exists in part. Authenticator-app 2FA is a later requirement unless needed by the production security gate.
- Portal accounts must not access operator data or another party's data.

## Migration

- Import twelve months of BigQuery history.
- Move current application data and configuration completely enough to retire Base44.
- LeadByte history itself is not required, but its active configuration should be exported when useful.
- Shadow the new engine and switch only when results are boring and explainable.
- Cut over one supplier at a time with rollback.

## Reliability

- Daily backups are required, including a proven restore.
- Alerts should cover failures that could lose, delay, misroute, or misbill a lead.
- A second failover server is not required for the initial cutover unless evidence justifies it.
- Reassess multi-node infrastructure after roughly 30 days of real operating data.

## Explicitly outside the two-week promise

- complete dynamic report-builder UX;
- finished multi-tenant SaaS provisioning;
- full call-routing platform;
- advanced aged-lead resale;
- authenticator-app 2FA and recovery flows;
- second active server;
- broad visual redesign unrelated to safe cutover.

These remain product requirements. They are sequenced after the stable cutover, not discarded.
