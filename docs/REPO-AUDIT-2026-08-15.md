# DashFlo repository audit

Audit target: `legenex/legenex-dashflo`

Audited commit: `a63144cb0e1a2c000e873e94e5091565f6bbb1c6`

Audit date: 15 August 2026

## Executive finding

The repository has substantial working product code and strong routing unit coverage. It is not production-ready for public self-hosting. The top blocker is access control, not the exact lead-loss scenario described in the earlier plan.

The earlier plan should not be executed unchanged.

## Verified baseline

| Area | Observed result |
|---|---|
| Repository | 962 tracked files, including 730 client files and 217 server files |
| Tests | 47 test files discovered, 465 tests executed, 464 passed |
| Test failures | 3 suites reference the removed Base44 layout; 1 privacy masking assertion fails |
| Client build | Passes, with a CSS syntax warning and dynamic import warnings |
| Client lint | Fails with 36 unused import errors |
| Backend functions | 94 load, 3 fail because they do not default-export a function |
| Server dependency audit | 3 advisories, including high severity issues in `nodemailer` and `xlsx` |
| Client dependency audit | 7 advisories, including high severity issues affecting `nanoid` and `postcss` |
| Source control | `main` is still fed by an hourly upstream application sync |

The three backend modules that fail the loader are `llmClient`, `pageManifest`, and `readiness`. They should either be renamed as non-routable helpers, default-export valid handlers, or be excluded by an explicit loader rule.

## Corrections to the earlier plan

### 1. The headline lead-loss sequence is inaccurate

`processLead.js` first creates the `Lead` record near line 1453. The earlier plan says phone validation, email validation, and TrustedForm calls happen before this write. In the audited commit, those external calls occur later in the function. Before the first lead write, the code performs authentication and settings database work, not those enrichment network calls.

There is still a real durability gap between request arrival and the first committed lead record. A durable receipt is still P0, but the acceptance test and explanation must be technically exact.

### 2. `list()` does not return null

The self-hosted repository maps query rows to an array. Empty reads return an empty array. Null guards are harmless, but this is not a repository invariant and should not drive the plan.

### 3. Suppression is narrower than the plan implies

Routing code supports buyer or route-member suppression configuration. There is no global do-not-contact system with normalized phone or email matching, operator management, audit history, and enforcement across all intake sources. That global capability is still P0.

Raw receipt capture must occur before validation. Global suppression is the first business validation after capture and authentication.

### 4. Parallel ownership in Wave 1 is invalid

Durable intake and global suppression both need to integrate with `processLead.js`. They cannot be assigned to separate agents that independently edit the same file. Agents may build isolated modules and tests in parallel, but one integrator must apply the ordered changes to the canonical pipeline.

### 5. Buyer identity is overloaded

Legacy data and comments treat `Lead.buyer_id` as a buyer code. Native routing writes a buyer record id. Portal and billing code often query it as a record id. A blanket instruction that it is always a code would break the native engine.

Use additive normalization with explicit `buyer_record_id` and `buyer_code` fields, a resolver for legacy rows, a backfill report, and compatibility reads until the migration is proven.

### 6. The earlier gate scripts are ineffective

The quick hook checks only staged changes, while normal edits are not staged. The stop hook runs only client tests and does not run the promised build, lint, function-loader, security, parity, or generated-file checks. A global double-hyphen ban would also reject valid command flags and code syntax, and the current repository already contains hundreds of matches.

The corrected rule is to prohibit em dashes in newly written human-facing text. Do not prohibit valid programming syntax.

## Deployment-blocking findings omitted from the earlier plan

### Public registration creates privileged application users

`public-settings` reports a registration setting, but the register route does not enforce it. The first account becomes owner. Every later public registration becomes a manager user.

Production must be invite-only by default. Initial owner bootstrap must be a deliberate command or one-time token, not an open web race.

### Generic entity access fails open

The entity router permits every authenticated user when an entity schema has no row-level rule. Many sensitive schemas do not define rules. This can expose or allow changes to buyers, suppliers, bank transactions, return requests, and API key records.

The default must be deny. Sensitive entities must use explicit service functions with field allowlists and ownership checks. Portal accounts must never be able to query the generic entity route for cross-tenant data.

### Function invocation is public by default

The generic function route does not require authentication at the route. Individual functions vary in how they inspect `ctx.user`. Production needs a small explicit public allowlist for intake, verification, reset, onboarding, and approved webhooks. Every other function must require authenticated permission before its handler runs.

### Authentication configuration is unsafe for production

The server falls back to a known development JWT secret. Cookies are not marked secure. JWTs last 30 days by default. The client also retains bearer tokens in local storage, which reduces the value of an HTTP-only cookie. There is no login second factor, even though registration has an email verification code.

Production startup must fail if required secrets are missing. Auth endpoints need rate limits. Browser auth should use secure HTTP-only cookies with CSRF protection and no persistent bearer token in local storage.

### API keys and integration secrets need a storage decision

The generic `ApiKey` entity stores and can return raw keys. Delivery credentials are resolved through `IntegrationConfig`, which is a database record, despite comments calling it a secret store. Bulk configuration must never place credentials in a spreadsheet or browser-readable response.

Use hash-only storage for supplier API keys. Use a server-side encrypted credential store or an external secret provider for reversible buyer credentials, with only opaque references exposed to application records.

## Additional functional risks

- `processLead` is invoked from several functions, not only the public lead endpoint. Durable receipt and DNC enforcement must cover every real intake path and must exclude simulations and dry runs explicitly.
- Portal server functions duplicate projection logic even though the client contains a tested projection helper. The server must own a single deny-by-default projection implementation.
- Supplier portal output does not yet satisfy the requested profit reporting.
- Existing bulk and system export code should be used to recover configuration automatically. Bru should receive an exception sheet for unresolved records, not a blank sheet for all 30 or more destinations.
- Tests must never contact real HLR, TrustedForm, LeadByte, Meta, buyer, email, Slack, WhatsApp, bank, or accounting endpoints.

## Recommended priority

| Priority | Work |
|---|---|
| P0 | Freeze auto-sync, green baseline, production auth fail-closed, entity and function authorization, secret handling decision |
| P0 | Durable raw receipt with replay and transport idempotency |
| P0 | Global DNC with audit and all-path enforcement |
| P0 | Routing, delivery, billing, and portal isolation acceptance tests |
| P1 | Automated configuration recovery, data migration, shadow comparison, supplier-by-supplier cutover |
| P1 | Backup restore drill, alerts, service hardening, rollback runbook |
| P2 | Dynamic reporting builder, broader SaaS tenancy, advanced 2FA, call routing, second server |

## Honest deadline position

The focused cutover slice can fit the two-week target if configuration recovery is automated, live activation remains incremental, and P2 scope does not enter the critical path. Building the full long-term SaaS vision in the same two weeks would trade speed for hidden production risk and should be rejected.
