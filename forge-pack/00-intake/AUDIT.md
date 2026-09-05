# Repository audit, 4 September 2026

Produced by cloning `legenex/legenex-dashflo` at `f89b2e8` and running commands. Every line is `RUN` evidence unless marked otherwise. This file exists because the v1 handoff described a system in trouble and the code shows something else. **Read this before believing any older description of project state.**

## Access

The repository is public. An earlier 403 was `API rate limit exceeded for 35.196.141.6`, a shared IP, not a permission problem.

## Scale

- 596 `.js`, 471 `.jsx`
- server 51,279 lines, client 94,287 lines, docs 10,190 lines
- 95 entity schemas, 121 backend functions, production boot reports `loaded 109 functions`

## Verification infrastructure

- `npm run gate`: tests, function-loader, engine-parity, lint, build, bundle-purity, secret-scan, em-dash
- `.github/workflows/deploy-production.yml`: push to `main` runs the gate against a real `postgres:16` service, then deploys. Run `33147743996` green, VPS HEAD matched
- `npx vitest run`: **1,491 passing, 181 skipped, 144 files.** The 181 skips are DB-dependent suites, which CI runs with a database. 15 files failed only in the audit sandbox for missing client dependencies, not in the repo

## Architecture facts that matter

- One canonical routing engine: `server/src/functions/routingEngine.generated.js`, 3,227 lines, generated from `client/src/lib/distribution/`, pinned by `canonical-engine-sha256`, enforced by `scripts/check-engine-parity.mjs`, which also fails if a hand-written mirror reappears
- `processLead.js` is 2,800 lines
- Engine `REASON` codes already include `FILTER_ZIP`, `FILTER_COUNTY`, `CAP_HOURLY`, `CAP_DAILY`, `CAP_WEEKLY`, `CAP_MONTHLY`, `CAP_TOTAL`, `SUPPRESSED`, `LOW_BALANCE`, `OVER_CREDIT_LIMIT`, `DESTINATION_UNHEALTHY`, `BELOW_RESERVE`, `QUALIFICATION_FAILED`, `MISSING_REQUIRED_FIELDS`
- Durable receipts: `transport_key TEXT NOT NULL UNIQUE` with single-statement claiming
- `CapCounter.scope_key` unique index, with a reservation primitive
- Simulator, shadow report and distribution mode switching exist as functions
- DNC is fully built: `DncEntry`, `dnc.js`, `dncEnforcement.js`, `dncManage.js`, enforced in `processLead.js` and `intake.js`
- Buyer onboarding is largely built: `BuyerOnboarding`, `OnboardingEmailTemplate`, `onboardBuyer.js`, `sendOnboardingLink.js`, `submitBuyerOnboarding.js`, `getOnboardingContext.js`
- 72 files reference Base44; it is live migration machinery governed by `docs/BASE44-BOUNDARY.md`, with sync disabled

## Current lead status enum

`Lead.json` field `final_status`, twelve values: `Processing, Sold, Qualified, Unsold, Queued, Disqualified, Returned, Rejected, Duplicate, Converted, Fake, Error`, default `Processing`.

Code-site counts for the retiring values: `Processing` 8, `Qualified` 13, `Duplicate` 21, `Error` 30, `Fake` 1.

`ApiConnector.json`, `LeadByteConnector.json` and `InboundWebhookRoute.json` all derive trigger keys from this field, including `on_duplicates` and `on_received`.

## Production state

From the most recent verified entries in `docs/STATE.md`:

- `e_lead` 1,984, `e_buyer` 13, `e_supplier` 5, 101 tables
- **0 active `RouteGroup` rows**
- `NATIVE_RETRY_WORKER_ENABLED` absent, `BASE44_SYNC_ENABLED=0`
- All four public hosts returning 200
- Nightly backup restore-verified by booting the real app image against the restored copy
- `deploy/backup/offsite.env` does not exist, so off-site replication is a deliberate no-op

## The conclusion this audit forces

DashFlo is built, deployed, gated, backed up and dormant. The remaining work is a status migration, a set of finishing touches, and Gate C. It is not a construction project.
