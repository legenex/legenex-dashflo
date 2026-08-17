# DashFlo legal and privacy review record

Date: 17 August 2026

This document separates facts established by code and configuration, facts
provided by the owner, and decisions that require business confirmation or
legal counsel. It is an internal review record, not a public policy and not a
statement of legal compliance.

## 1. Established by repository and deployment evidence

### Service and identity

- Public operator identity supplied for this work: Next Consulting LLC dba
  DashFlo.
- Public endpoints are `dashflo.io`, `app.dashflo.io`, `api.dashflo.io`, and
  `docs.dashflo.io`.
- The marketing site is a static React bundle served by nginx from
  `/var/www/dashflo`. The application and API are separate hosts.
- The production application deployment observed on 17 August 2026 runs the
  repository at commit `da0fefce280ee9775265ef74aeff822d49574ef7` in Docker on
  a Hostinger VPS. The production-named database is currently
  `dashflo_staging`.

### People and account data

- DashFlo handles two populations: authenticated business users and people
  represented in lead or call data who may have no DashFlo account.
- Email and password registration, invitations, one-time email verification,
  password reset, roles, permissions, buyer or supplier portal links, and user
  timezone are implemented.
- Passwords are stored as bcrypt hashes in `auth_credentials`.
- The application sets a 30-day `dashos_token` cookie with HttpOnly,
  SameSite=Lax, path `/`, and Secure in production.
- The browser client also stores `dashos_access_token` in local storage. This
  compatibility behavior remains a security and privacy review item.
- Google account buttons currently route to an unavailable-provider state.
  Google authentication itself is not implemented. Google service-account and
  Picker code supports Sheets and Drive integrations, which are distinct from
  user login.

### Lead, call, consent, and attribution data

- The canonical intake stores the original inbound payload and normalized
  mapped fields, plus first and last name, email, mobile number, supplier,
  source, timestamps, and routing and outcome fields.
- Posting specifications and mapping code accept ZIP, city, state, IP address,
  user agent, opt-in URL, TrustedForm URL, and Jornaya token.
- Attribution code accepts UTM fields, campaign identifiers, Meta `fbc` and
  `fbp` identifiers, advertising data, and conversion data.
- Call ingestion supports names, phone numbers, caller ID, city, state, ZIP,
  call identifiers, source, campaign, duration, disposition, qualification,
  buyer, supplier, linked lead, and revenue.
- TrustedForm certificates can be validated, stored, recovered from a backup
  store, and included in audit records. The system does not mint certificates.
- Global do-not-contact entries use keyed hashes and retain immutable history.
  Scope and enforcement gaps remain documented in `docs/STATE.md`.

### Accident, legal, and consumer health data

- `leadbyteWebhook.js` maps accident state, type, details and timeframe;
  injured status; injury type; treatment status, type and time; fault;
  attorney and attorney-change status; insurance; and police-report status.
- `processLead.js` resolves treatment or injury, attorney status, accident date
  and details, fault, state, and other configured fields for validation and
  outbound delivery.
- Buyer qualification criteria can include treatment timing.
- These fields can constitute sensitive personal information or consumer
  health data. The code does not establish that they are HIPAA protected health
  information or that Next Consulting is a HIPAA covered entity or business
  associate.

### Routing and recipients

- Personal data can be delivered to configured buyers and one or more endpoint
  tiers by API post, email, Google Sheet, or other configured transport.
- Buyers can be law firms, aggregators, resellers, networks, or tests.
- LeadByte remains represented in compatibility and migration code. Native
  routing, customer-configured webhooks, Meta services, Google Sheets, email,
  phone HLR, TrustedForm, Slack, WhatsApp, Xero, Stripe, Mercury, and AI
  providers have executable integration code.
- An installed dependency or function file does not establish that an optional
  integration is active. A read-only production query on 17 August 2026 found
  zero lead, call, buyer, supplier, delivery-attempt, integration-config,
  connector, financial, chatbot, and knowledge-base records. It found one user
  and one credential record. The deployment therefore does not establish the
  final production recipient list.
- The repository states that current production business data historically
  resided in a Base44 migration source. That source was not queried for this
  legal audit.

### Financial, AI, support, and uploaded content

- Schemas and executable functions support buyer and supplier contacts,
  onboarding submissions, CPL, revenue, margin, payouts, wallets, invoices,
  payments, bank transactions, advertising spend, reconciliation, and limited
  payment-provider references.
- AI features can send prompts, selected operational data, knowledge-base
  content, and screenshots to OpenAI or Anthropic, depending on deployment
  configuration. Chat conversations and memories can be stored.
- File upload, knowledge-base, API documentation upload, taxpayer-form URL,
  and page-capture features exist. The uploaded-file directory is persistent in
  the Docker deployment.

### Logs, audit, deletion, retention, and backups

- Express logs startup and errors to standard output. nginx and Docker may log
  ordinary request information under their server configuration.
- In-process authentication rate limiting derives a key from request IP and,
  for some routes, email. Those buckets expire in memory and are not a durable
  event log.
- Error records can contain lead reference, stage, message, supplier, and full
  JSON detail. Distribution and key actions have separate audit schemas.
- Authorized users can archive leads, hard-delete individual or bulk leads,
  delete calls, and delete several configuration and user records. Archiving is
  not deletion. Routing versions, DNC history, receipts, and other audit data
  have separate retention behavior.
- No general retention scheduler or category-specific retention schedule was
  found.
- The VPS contained one pre-deployment PostgreSQL dump and one environment
  backup dated 16 August 2026. No recurring production backup job or tested
  expiration schedule was established by this audit.

### Marketing cookies and collection points

- The marketing bundle has no form and no analytics or advertising tag.
- It stores only `dashflo-theme` in local storage.
- Google Fonts are loaded from Google, causing normal font-resource requests.
- The application uses required account storage and functional UI preferences.
- Registration at `app.dashflo.io/register` collects email and password. A
  Notice at Collection summary with Privacy and Terms links was added there.
- Because the marketing site has no nonessential tracking, no cookie-consent
  banner was added.

## 2. Business facts supplied by the owner

- Legal operator: Next Consulting LLC dba DashFlo.
- Public contact: `info@next-consulting.co`.
- Brand: DashFlo.
- Primary website and service hostnames listed above.
- DashFlo is a lead-management and distribution system that can handle
  suppliers, buyers, routing, billing, and reporting.
- The requested deployment path is `/var/www/dashflo`.

## 3. Business facts requiring owner confirmation

1. State of formation and principal legal address for Next Consulting LLC.
2. Legal-notice mailing address.
3. Governing-law state, venue, and whether arbitration is desired.
4. Annual revenue, California consumer or household volume, and percentage of
   revenue derived from selling or sharing personal information.
5. Exact current and planned states in which DashFlo, its customers, or its
   suppliers target or receive consumers, including Washington and Nevada.
6. Whether any consumer directly requests a product or service from Next
   Consulting, rather than only from a customer, supplier, law firm, or buyer.
7. For each lead flow, who pays whom, what consideration is exchanged for the
   transfer, who selects the recipient, whether the consumer intentionally
   directs the disclosure, and which contracts impose service-provider or
   processor restrictions.
8. The actual notice and consent language used at every supplier, customer,
   Meta, call, and owned-form collection point.
9. Whether any transfer of health-related lead information has a separate
   signed consumer-health-data sale authorization, and who retains it.
10. Whether recipients may reuse or resell leads beyond the disclosed purpose.
11. Final production list of infrastructure, email, validation, consent,
    communication, AI, payment, accounting, advertising, and support providers,
    including each provider's legal entity and processing location.
12. Whether DashFlo intentionally offers services to or monitors people in the
    EEA, United Kingdom, or other non-US jurisdictions.
13. Desired and contractually supportable retention periods by data category,
    including lead payloads, health data, consent records, delivery logs,
    financial records, AI conversations, audit data, and backups.
14. Whether self-service registration will remain closed and whether Google
    authentication will be enabled for all users or selected organizations.

## 4. Legal conclusions requiring counsel

### Sale and sharing

The code proves onward transfer and commercial lead economics, but code cannot
determine all contract terms, consumer directions, consideration, exemptions,
or statutory thresholds. Counsel should classify each transfer under the CCPA
and other applicable laws. Until then, public text must not say that DashFlo
never sells or shares personal information. The public Privacy Choices page
accepts an opt-out request without prejudging classification.

### California applicability and links

The CCPA applies only if a statutory threshold or related-control provision is
met. As of 2025, the adjusted annual gross-revenue threshold is $26.625 million;
other thresholds include buying, selling, or sharing personal information of
100,000 California consumers or households, or deriving at least 50 percent of
annual revenue from selling or sharing it. The needed business facts are not in
the repository.

If DashFlo is a covered business and sells or shares personal information,
counsel should decide whether the homepage must use the exact "Do Not Sell or
Share My Personal Information" label and implement Global Privacy Control for
the applicable processing. If sensitive information is used beyond permitted
purposes, counsel should assess the separate limitation link and signal.

Primary sources:

- <https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=1798.135.>
- <https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=1798.140.>
- <https://cppa.ca.gov/regulations/cpi_adjustment.html>

### Consumer health data

Washington RCW 19.373 broadly covers linked information identifying physical
or mental health status, including conditions, treatment, and a person seeking
health services. Its policy requirement applies to regulated entities and
small businesses and requires a distinct homepage link. Nevada NRS 603A.400 to
603A.550 has similar consumer health requirements. The repository proves that
DashFlo can process covered categories, but it does not establish geographic
scope, consumer relationship, exemptions, or consent facts.

A separate public Consumer Health Data Privacy Policy and prominent footer link
were implemented because the processing categories create a material risk that
one or more laws applies. This does not resolve compliance. Counsel must assess
each state's scope, consent, sharing, sale authorization, deletion propagation,
appeal, and processor-contract requirements against actual lead flows.

Primary sources:

- <https://app.leg.wa.gov/RCW/default.aspx?cite=19.373&full=true>
- <https://www.atg.wa.gov/protecting-washingtonians-personal-health-data-and-privacy>
- <https://www.leg.state.nv.us/NRS/NRS-603A.html>

### DPA and international transfers

DashFlo is capable of processing personal data on behalf of B2B customers, so
a data processing addendum is commercially appropriate. The internal draft at
`docs/DPA-DRAFT.md` is not ready for signature or publication until the legal
address, governing law, security schedule, deletion and return commitments,
subprocessor list, audit mechanism, liability relationship, and transfer scope
are approved. Do not add Standard Contractual Clauses, a UK Addendum, or a Data
Privacy Framework statement without confirmed international scope and counsel.

### Retention

The public policy accurately uses criteria rather than fixed durations. Counsel
and the owner should approve an operational schedule and then implement it in
code and backups. Health-data and consent-authorization laws may impose specific
rules for particular records.

## 5. Publication decisions

- Published: Privacy Policy, Terms of Service, Cookie Policy, Privacy Choices,
  and Consumer Health Data Privacy Policy.
- Acceptable use is integrated into the Terms because a separate page would be
  duplicative.
- No public DPA was published because material contractual details are missing.
- No public subprocessor list was published because final provider legal
  entities, active production use, and processing locations are not established.
- No categorical sale or no-sale statement was published.
- No HIPAA, GDPR, CCPA, SOC 2, ISO 27001, or similar compliance claim was made.
