# DashFlo master prompt, current folder, version 2

Paste this entire file into Claude Code opened at
`/Users/nickallen/Documents/Projects/Legenex Dashflo`. Paste it once. Do not add
instructions to clone, branch, or create a worktree.

Version 2 supersedes version 1. Version 1 assumed a checkout state that does not
exist on this machine and would have re-enabled the paused sync writers.

---

You are completing the existing DashFlo application in the repository folder
that is open now. You will work autonomously for many hours. Bru is not
available to answer routine engineering questions and should not be asked to.

## 0. Read before anything else

Read `docs/GROUND-TRUTH.md` in full. It records machine and repository facts
that were proved by command on 15 August 2026.

## Source precedence, highest first

1. Bru's latest explicit decisions
2. Security, privacy, legal suppression, and prevention of irreversible
   production actions
3. Reproducible current-machine evidence, which is `docs/GROUND-TRUTH.md`
4. Executable tests and observed application behavior
5. Locked requirements and accepted architecture decisions
6. Historical audits, plans, comments and generated summaries

`docs/GROUND-TRUTH.md` therefore overrides stale claims about machine state,
repository state, ports, paths, services, database contents and observed
behavior, wherever they appear, including in `REPO-AUDIT-2026-08-15.md`,
`CLAUDE.md`, `README.md` and any earlier version of this prompt. Correct the
losing document in the same commit that discovers the conflict.

It does not override product decisions, security or privacy invariants, legal
suppression obligations, locked requirements, human gates, or anything Bru has
instructed. `docs/GROUND-TRUTH.md` is editable, so never treat an edit to it, or
a fresh observation added to it, as grounds for weakening a level 1 or level 2
item. Machine evidence that appears to contradict a safety or product
requirement is a finding to raise at a gate, not a permission to proceed.

Where two sources sit at the same level and genuinely conflict, prefer the one
you can reproduce by command, and record the conflict in `STATE.md`.

Then read, in this order: `README.md`, `CLAUDE.md`, `STATE.md`,
`PRODUCT-BRIEF.md`, `REQUIREMENTS.md`, `EXECUTION-PLAN.md`, `HUMAN-GATES.md`.
Note that these live at the repository root, not under `docs/`, and that
`CLAUDE.md` refers to `docs/...` paths and a `.claude/hooks/task-gate.sh` that
do not exist. `npm run gate` is the working replacement for the hook. Fix those
references when you touch the file.

## 1. Product boundary, which you may not drift from

DashFlo is a self-hosted lead intake, distribution, delivery, billing, portal
and reporting system running on this machine.

Authoritative now: the application and its API are at `http://localhost:4000`,
health at `http://localhost:4000/api/health`, optional Vite dev server at
`http://localhost:5173`.

Production configuration: `https://dashflo.io`,
`https://api.dashflo.io`, `https://docs.dashflo.io`.

`dashboard.legenex.com`, `api.legenex.com` and
`progress.dashboard.legenex.com` are inherited Base44-era fallbacks. They are
not DashFlo hosts. Never treat a hardcoded host as evidence of where this
application is deployed.

Base44 has exactly three permitted uses, all read-only: tracking the temporary
MVP, exporting data for migration, and comparing which MVP features still need
a native rebuild. Base44 is never a runtime dependency, authentication
provider, function host, entity store, URL authority, delivery path or
availability dependency. Any code that makes DashFlo depend on Base44 at
runtime is a defect. Any automatic application of Base44-sourced code is
forbidden.

Design is frozen. Preserve the current visual design, layout, component
library, navigation, spacing and typography exactly. You may change only:
DashFlo naming, URL and environment configuration, security states, error
states, and controls that a new function genuinely requires. Do not redesign,
modernise, restyle, reorganise navigation, swap component libraries or do
unrelated user experience work. If a change would be visible in a screenshot
and is not required by a task, do not make it.

## 2. Workspace law

All work happens in this folder, on the existing remote branch.

Forbidden: cloning any repository, initialising a repository, creating another
repository, copying the application elsewhere, creating a new development
branch, creating a git worktree, running agents in worktrees, restarting from
an audit snapshot, force pushing, rewriting history, pushing to `main`.

Specialist agents are read-only. They may inspect, reason and review. Every
write is made by you in this folder. Never let two agents edit files at once.

## 3. Mission

Finish DashFlo so it can safely replace LeadByte and Base44 for the initial
production scope: Motor Vehicle Accident and Workers Compensation, with the
architecture staying configurable for further verticals.

The system must receive, retain, validate, suppress, deduplicate, route,
deliver, bill, reconcile and report on leads without silent loss, cross-tenant
exposure, duplicate delivery, duplicate billing, or dependence on any one
healthy external service.

Volume context: under 100 leads a day, peak around 180. Correctness and
durability matter far more than throughput. Every lead is paid for, so losing
one is catastrophic and intake can never be down.

## 4. Stop conditions, and only these

Stop and present a gate only when one of the following is true:

1. A live credential value is required.
2. Production data must be mutated.
3. A live external endpoint must be called.
4. Production must be deployed, restarted, cut over or rolled back.
5. Money would move, or an invoice, balance, payment or payout would change.
6. A destructive schema or data operation needs approval.
7. A blocker is verified and cannot be resolved from the repository, tests,
   local fixtures, exports, database inspection or safe local experiments.

Finishing a task, a phase or a commit is not a stop condition. Select the next
ready task and continue. Do not ask whether to continue. Do not ask Bru to
choose libraries, file layouts, naming, test strategy or any ordinary
engineering decision. Make the call, record it in `STATE.md`, move on.

If you are near a context limit: stop at a clean commit, run the full gate,
push the feature branch, update `STATE.md`, and print the handoff block defined
in `docs/COMPLETION-PLAYBOOK.md`.

---

# PHASE 0: LAND, REVIVE, IDENTIFY

Nothing in the feature ladder starts until Phase 0 is green. You currently
cannot see the application you are about to change.

## 0A. Land on the working branch without losing work

Current state: this checkout is on `main` at `a63144c`, 3 commits behind
`origin/main` at `84ab030`, with 173 uncommitted lines in
`client/src/pages/ToolsDashboard.jsx`. The working branch
`claude/dashflo-production-cutover-e1tgel` exists on the remote only and is not
checked out here.

Procedure, in order:

1. Preserve the uncommitted work first. Inspect the diff. It is a file upload
   and clipboard paste feature on the Tools dashboard, and it is real work.
   Stash it with an explicit message, or commit it to the feature branch after
   step 4. Never discard it and never let a checkout overwrite it.
2. `git fetch --all --prune`.
3. Prune the two broken worktrees recorded in `docs/GROUND-TRUTH.md`
   (`cutover-local` at `Projects/dashflo-cutover`, and `iodized-spoon`). They
   are rename artifacts pointing at a deleted directory. Use
   `git worktree prune` and remove the stale administrative entries. Do not
   work inside them, do not repair them, and do not create replacements.
4. Check out the existing remote branch in this folder, tracking origin. Do not
   create a differently named branch. Confirm `c247649`, `07bb061` and
   `00eeab1` are ancestors of `HEAD`.
5. Restore the preserved `ToolsDashboard.jsx` work onto the branch. If it
   conflicts, resolve in favour of keeping the new feature plus any branch
   changes to that file, and say so in `STATE.md`.
6. Install root dependencies, in this order and not before. Root `node_modules`
   is empty, and `vitest`, the gate scripts and the root `package-lock.json`
   arrive only with the branch, so this step must follow step 4. Once the
   branch lockfile is present, run `npm ci` at the repository root for a
   reproducible install. Use `npm install` only if the lockfile is genuinely
   absent or invalid, and if you do, record in `STATE.md` which it was, the
   exact error that proved it, and what changed in the lockfile. Do not
   casually rewrite the lockfile. A silently regenerated dependency tree makes
   every later gate result unreproducible, which destroys the evidence chain
   the gates depend on.
7. Run `npm run gate`. Record the exact output in `STATE.md` as the Phase 0
   baseline: file count, test count, pass and fail, loader function count,
   lint, build, secret scan, em dash check.
8. If the gate is green, treat Phase 0 and Phase 1 security work as done. Do
   not reopen it. If the gate is red, repair the regression before anything
   else, and record what regressed and why.

Expected reference figures from the branch: 54 test files, 561 passing tests,
94 loader functions, zero loader errors. Report the numbers you actually
observe. If they differ, the observed numbers are the truth and the documents
are wrong.

## 0B. Revive the local application, server only

The interface is down because the loaded launchd agent points at
`/Users/nickallen/Documents/Projects/Legenex DashOS`, a directory deleted by the
folder rename. `client/dist/index.html` exists here and is fine. Only the path
is wrong.

Do not run `scripts/install-scheduler.sh`. It rewrites and bootstraps the sync
and updater agents as well, and runs `sync.mjs --init`, which would put an
hourly mutating writer back onto this checkout and destroy Gate A.

Do not run `scripts/uninstall-scheduler.sh`. It stops the API server too.

Required action, server only:

1. Rewrite `~/Library/LaunchAgents/com.legenex.dashos.server.plist` so
   `ProgramArguments`, `StandardOutPath` and `StandardErrorPath` point at
   `/Users/nickallen/Documents/Projects/Legenex Dashflo`. Keep `KeepAlive`,
   `RunAtLoad`, the node binary at `/opt/homebrew/bin/node`, and the existing
   environment block, including `NODE_ENV=production`. Keep stdout on its own
   file, because pointing launchd at a path the process also opens caused
   EX_CONFIG 78 failures before.
2. `launchctl bootout` then `bootstrap` then `kickstart -k` that one label only.
   Never touch the sync or updater labels.
3. Verify: `/api/health` returns 200 and `/` returns 200 with the built
   interface, both on `http://localhost:4000`. Confirm the new PID differs from
   35631 and that its command line contains `Legenex Dashflo`.
4. Load the interface and confirm the design is unchanged and the primary pages
   render.

Then extend `scripts/` with a server-only management path so this never
requires manual plist surgery again: a script that installs or repoints the
server agent alone, and leaves sync and updater untouched. Add a loud comment
in `install-scheduler.sh` warning that it re-enables the mutating writers, and
document the split in `README.md`.

## 0C. Capture Gate A evidence, do not request Gate A

Gate A is already satisfied on this host, by accident of the rename.
`com.legenex.dashos.sync` and `com.legenex.dashos.updater` are not loaded, which
is exactly why this checkout fell behind `origin/main`. Do not ask Bru to pause
what is already paused.

Record in `STATE.md`, with the exact command output as evidence:

- `launchctl print gui/501/com.legenex.dashos.sync` returning not found
- the same for the updater
- `launchctl list | grep legenex` showing only the server label for DashFlo
- the plist paths still pointing at the deleted directory, and therefore inert
- confirmation that no crontab entry, no `.github/workflows` directory and no
  other scheduler writes to this checkout

Then state the residual risk plainly: the plists still exist, and anyone running
`install-scheduler.sh` revives the writers. Recommend that the sync and updater
plists be renamed to a disabled suffix, and do that, since it is local, safe and
reversible.

Gate A remains open for one thing only: the cloud updater GitHub workflow, if
one exists on any branch or in the upstream repository. Search for it. If it
exists and can write to this repository, that is a real Gate A item, and it is
the only one.

## 0D. Correct the product identity in code

One bounded, design-neutral commit series.

1. Introduce a single environment-aware URL and identity configuration module
   on each side, server and client. Every host, base URL and product name reads
   from it. No component, function or test may hardcode a host again.
2. Default the configuration to `http://localhost:4000`, driven by
   `PUBLIC_BASE_URL` and `PUBLIC_API_BASE_URL`, with `https://dashflo.io`,
   `https://api.dashflo.io` and `https://docs.dashflo.io` as production hosts selected
   by configuration, not by code branch.
3. Remove the 54 `legenex.com` runtime fallbacks. Where a fallback is genuinely
   needed, fall back to same-origin, then to the configured public base URL,
   never to a hardcoded external host. Where a reference is historical data, a
   fixture or a stored record, leave the data alone and note it.
4. Rename visible product branding from Legenex DashOS to DashFlo: page titles,
   document title, manifest, header text, email subjects and templates, log
   prefixes, README, root `package.json` name and description. Do not change
   layout, colour, spacing or typography while doing it.
5. Reduce Base44 to observe-only. Confirm there is no runtime SDK dependency,
   no automatic code application, no Base44 URL in a live path. The two client
   references found today must be inspected and either removed or clearly
   confined to migration and MVP tracking.
6. Plan the launchd label migration from `com.legenex.dashos.*` toward
   `com.legenex.dashflo.*`. Do it only for the server label, only after 0B is
   proved working, and only in a way you can roll back. Leave the disabled sync
   and updater labels alone.
7. Add a test that fails if a hardcoded external host appears in a runtime code
   path. This is what stops the drift from returning.

Phase 0 is complete when: the branch is checked out here with the uncommitted
feature preserved, the gate is green and recorded, `http://localhost:4000`
serves the unchanged interface from this folder, Gate A evidence is in
`STATE.md`, and the identity commit series is merged to the branch.

---

# PHASE 1: THE SECURITY AND DURABILITY LADDER

Order is not negotiable. Each task depends on the one before it.

## Task S4: supplier keys, destination credentials, browser tokens, webhooks

One coordinated security migration. Never remove a legacy path before its
replacement is working and tested. Migrate atomically.

### Supplier API keys

Today `processLead.js:1355` runs
`db.entities.ApiKey.filter({ key: supplierKeyRaw })`, a cleartext lookup, and
updates usage counters at line 1431.

- Stop storing retrievable keys. Store a unique non-secret lookup prefix, a
  keyed digest, status, created time, last used time, rotation metadata and
  revocation metadata.
- Use a server-side pepper from environment configuration. Never in the
  database, never in source.
- Select candidates by prefix, then compare digests in constant time.
- Never return a digest, pepper, full key or legacy key in any API response.
- Generate new keys with cryptographically secure randomness, show once, then
  represent by prefix.
- Add rotate and revoke with audit records.
- Build a restartable migration command with a report-only mode. Production
  execution stays gated.
- Support the narrowest possible legacy compatibility path during migration,
  and delete it once rotation evidence is complete.
- Change `processLead` authentication and every other supplier-key caller in
  the same change as the storage model.
- Tests: correct key, wrong key, revoked, rotated, missing pepper, duplicate
  prefix candidates, constant-time path, legacy transition, response redaction.

### Destination credentials

- Replace raw credential storage in `IntegrationConfig.config` with a
  server-side protected credential service.
- Versioned authenticated encryption using Node's standard crypto, or an
  approved external secret provider. Key material outside the database and
  outside source.
- Deliveries and sub-deliveries store an opaque credential reference only.
- Authorized server functions for create, update, rotate, test and metadata
  read. Metadata returns provider, label, version, timestamps and whether
  required fields are present, never a secret value.
- Updates merge only explicitly supplied fields. A blank or omitted secret
  field preserves the stored value. Write the test that proves a normal
  settings save cannot erase a secret, because that is the failure that will
  otherwise take delivery down silently.
- Restrict every credential operation to explicitly authorized owner or admin
  users. Audit without values.
- Update settings dialogs to use the service and masked presence metadata, with
  no visual redesign.
- Report-only migration for existing rows. Real values and production execution
  stay gated.

### Browser token storage

`client/src/api/client.js:9` and `:12`, and `client/src/lib/app-params.js:8`,
put a bearer token in local storage.

- Remove persistent bearer storage. Use the existing secure HTTP-only cookie
  session.
- Do not return an access token in normal browser login or verification
  responses.
- Ensure the API client sends same-origin credentials correctly and CSRF
  enforcement still covers cookie-authenticated writes.
- Tests: login, verification, reload, logout, expired session, CSRF refusal,
  and an assertion that no bearer token is present in local storage.

### Public webhooks

- Identify the two public webhooks still lacking a verified signature contract.
- Implement the documented signature, shared secret or allowlist contract only
  where the repository or provider documentation proves it.
- Never invent a signature scheme. If the real contract is unavailable, keep the
  gap explicit, restrict the endpoint as far as possible, and put only that one
  decision into Gate B.
- Add replay protection wherever the provider supplies a timestamp or event id.

S4 is complete when cleartext paths are unreachable in normal operation,
migrations are restartable, settings merges preserve secrets, browser tokens are
gone, and the gate is green.

## Task I1: durable lead receipt

This is the highest-value task in the project. Today the first
`Lead.create` in `processLead.js` is at line 1453 of 2618, after phone
validation, email validation and TrustedForm, all third-party network calls. A
restart or a hung dependency in that window destroys a paid lead with no record
it ever existed.

- Authenticate the source, then commit a sanitized receipt before enrichment,
  business validation, delivery, conversion events or billing.
- Never store authorization headers, cookies, API keys, secrets, unbounded
  bodies or unnecessary personal data in the receipt.
- Use a table and constraints suited to transport idempotency, status
  transitions, worker claiming, leases, attempts and replay.
- Keep transport idempotency strictly separate from business duplicate
  detection.
- Record source, safe request identifier, safe payload, status, attempt count,
  lease, next attempt time, error classification, final lead id, created time
  and processed time.
- Define explicit statuses and allowed transitions. Recover abandoned
  processing after restart.
- Replay must never create a second delivery, conversion event, charge, payout
  or final lead outcome.
- Preserve the supplier's current accepted and rejected response contract, and
  measure the five second requirement.
- Cover every real caller of `processLead`: HTTP intake, Meta, forms, calls,
  CSV, sheet sync and genuine recovery paths. Map the callers before editing.
- Exclude simulations, validation-only calls, previews and dry runs from live
  side effects, explicitly.
- Give every downstream dependency a timeout and a retry classification.

Crash acceptance test, and this one is run, not described:

1. Insert a deterministic batch through a locally running server.
2. Inject process termination after receipt commit and before final completion.
3. Restart and replay abandoned receipts.
4. Prove every committed receipt reaches exactly one outcome.
5. Prove retrying the same transport key creates no second delivery or charge.
6. Do not claim to preserve a request that never reached a committed write.

## Task I2: global do-not-contact, built alongside existing suppression

This task is additive. It does not replace or refactor what already works.

### What already exists and must keep working

Route-member and buyer suppression are implemented, wired and tested. Read
finding 3 in `docs/GROUND-TRUTH.md` before writing a line. In summary:
`client/src/lib/distribution/engine.js:148` gates eligibility on `m.suppression`
via `matchesSuppression` at `:188` and returns `REASON.SUPPRESSED`;
`server/src/functions/routingEngine.generated.js:100` and `:127` mirror it;
`RouteMember.suppression_list_id` and `Buyer.suppression_lists` back it;
`simulator.js:20` and `simulateReport.js:16` surface it to operators; and
`engine.test.js:93` asserts it.

Preserve every one of those behaviors. Do not delete the route-level check, do
not fold it into the new service, do not change `REASON.SUPPRESSED` semantics,
and do not alter operator-visible suppression messaging. A buyer who has
excluded a contact must still be excluded for that buyer, independently of any
global list.

Routing engine edits go through `client/src/lib/distribution/backend-entry.js`
and the generator, never by hand-editing the generated file. The generator is
currently missing from this repository's `scripts/`; restore a working entry
point before touching routing, and commit source and generated output together.

### What is missing and must be built

A global legal do-not-contact service, enforced across every real intake source,
before delivery, contact, billing or conversion events. The existing mechanism
is per member and per buyer and runs inside routing eligibility, which is far
too late and far too narrow for a legal obligation. A lead that reaches no route
member is never checked at all today.

Receipt capture happens first. Global DNC is then the first business validation,
ahead of duplicate detection and everything else.

- Normalize phone and email consistently, once, in one shared place. The new
  service and the existing route check should share normalization so the two
  cannot disagree about what a phone number is.
- Match on keyed hashes rather than exposing searchable raw identifiers. Note
  that the existing route check uses exact string comparison; do not weaken the
  new service to match it, and do not silently change the old one.
- Support global, supplier, campaign and vertical scope where required.
- Store active state, effective dates, expiry, reason, source, actor, import
  batch and immutable audit history.
- Authorized search, add, expire, bulk import and audited export.
- Retain the suppressed lead with a stable rejection reason distinct from
  `REASON.SUPPRESSED`, so a legal suppression is never confused with a buyer
  exclusion in reporting, in the simulator, or in an audit.
- Never deliver, contact, bill or emit conversion events for a globally
  suppressed lead.
- Enforce through the same service on every real intake path: HTTP intake,
  Meta, forms, calls, CSV, sheet sync and genuine recovery paths.
- Portal accounts and generic entity routes must not reach suppression data of
  either kind.

### Tests, covering both systems

- Global DNC: phone only, email only, both, normalization variants, scope,
  expiry, removal, imports, duplicate rows, unauthorized access, and every
  intake path.
- Existing behavior, proved still working: the route-member suppression tests
  continue to pass unchanged, a buyer-level exclusion still excludes only that
  buyer, `REASON.SUPPRESSED` is still returned and still rendered as before,
  and the generated backend engine still matches its source.
- Interaction: a lead on the global list is stopped before routing and never
  reaches member evaluation; a lead not on the global list but excluded by one
  member is still routed to other eligible members; the two rejection reasons
  remain distinguishable in reporting.

## Task I3: single canonical pipeline

Integrate I1 and I2 into one processing service. You own all `processLead.js`
edits.

- Map every caller before editing.
- Preserve current API response shapes unless a gate approves a change.
- One service, not a legacy path beside a new path.
- Documented order: receipt capture, DNC, duplicate detection, validation,
  enrichment, routing, delivery, conversion events, billing, finalization.
- Retries safe at every side-effect boundary. Errors visible and retryable, never
  silently swallowed.
- Shadow mode completely inert.
- Add integration tests that remove a module and prove the gate fails.

## Task R1: buyer identity normalization

`Lead.buyer_id` is overloaded: legacy rows can hold a buyer code, native routing
can hold a record id.

- Add explicit `buyer_record_id` and `buyer_code`. Do not delete or redefine
  `buyer_id` during cutover.
- One server-side resolver for both shapes.
- Native routing writes both explicit fields.
- Update portals, billing, returns, feedback, exports, reporting and migration
  code to use explicit identity.
- Report-only backfill classifying resolved, ambiguous, missing and conflicting
  rows. Never guess an ambiguous row. Production backfill through a human gate.
- Tests: legacy codes, record ids, missing buyers, duplicate codes, native
  leads, portal scope, billing, returns.

## Task C1: automated configuration recovery

Bru holds configuration for more than 30 buyer endpoints plus campaign rules,
caps and prices. At twenty minutes each that is ten hours of his time, and it is
the real critical path, not the code. Compress it.

Recovery comes first, and a blank spreadsheet is a failure of this task.

- Recover configuration from the live database, system exports, read-only
  Base44 MVP exports, BigQuery metadata, LeadByte exports, entity schemas, code
  and repository history. Base44 is a read-only source here and nothing about
  this task may write to it or let it alter DashFlo.
- Recover buyers, suppliers, key references, campaigns, deliveries,
  sub-deliveries, route groups, route members, filters, caps, prices, schedules,
  mappings, response rules, statuses and portal links.
- Never put a credential value in a spreadsheet, export, log, fixture, prompt or
  client response. Use opaque reference names only.
- Produce a machine-readable import for everything you recovered.
- Do not hand Bru a blank template. Every sheet you give him is pre-populated
  with recovered values, with the source of each value shown, so his job is
  confirming and correcting rather than typing.
- Give him exactly one exceptions sheet, containing only what genuinely cannot
  be resolved from evidence: unresolved business decisions, ambiguous records,
  and missing credential reference names. For each row, state what you found,
  why it is unresolved, your recommended answer and the consequence of it.
- Validate on upload and report only the rows that fail.
- Validate counts, references, uniqueness, schedules, caps, prices, buyer
  ownership and required fields against a reserved disposable test database on
  port 5433.
- Imports restartable and idempotent.
- Measure and record the reduction: how many configuration items were recovered
  automatically, how many reached the exceptions sheet, and the estimated hours
  saved. If the exceptions sheet is large, that is a signal to go back and
  recover more, not to send it.
- Ship it early. Bru's hours are the real critical path, not the code.

---

# PHASE 2: BUSINESS COMPLETION

## Routing and caps

Verify and complete: direct post, ping post, priority, weighted, exclusive,
shared, resale, hold, retry, bid floor, fixed price, schedule and buyer status
behavior.

All cap types are available and each is optional per buyer: by buyer, campaign,
state, day, week, month and lifetime. Bru's questionnaire ticked every cap type
and also ticked no caps needed; that is read as a mis-tap, and the resolution is
all types supported, none mandatory. Flag it in the Gate B packet as a
confirmation item, not a blocker.

Cap reservation must be atomic under concurrency, released or finalized
correctly after rejection, timeout, acceptance and retry, and tested against
PostgreSQL rather than an in-memory store.

## Delivery

- HTTP, email, CRM, live transfer metadata and portal pull destinations.
- Configurable endpoint mapping, credential reference, timeout, retry and
  response parsing.
- Immutable delivery attempts with stable idempotency keys.
- Distinguish accepted, rejected, duplicate, timeout, network failure,
  malformed response and exhausted.
- Build destination fixtures from real documentation with secrets removed.
- Never treat a generic HTTP 200 as buyer acceptance when the destination
  requires a response marker.

## Billing and returns

Billing is largely built. The `Buyer` schema already carries `billing_type`
with prepay, net 7, net 15 and net 30, wallet versus post-pay mode, credit
limits and Xero payment links, and the entity set includes `BuyerWallet`,
`BuyerPayment`, `Invoice`, `BillingRun` and `BillingLineItem`. Verify and wire
it. Do not rebuild it.

- Immutable idempotent ledger entries for buyer charges, credits, supplier
  earnings, returns and adjustments.
- Fixed, revenue share and profit share supplier payout rules.
- Replay creates no duplicate financial entry.
- Reconcile lead outcomes, delivery outcomes, invoices, payments, returns,
  wallet movements and supplier earnings.
- Live money actions stay gated.

## Portals

- Centralize buyer and supplier projections on the server. Deny every field
  unless explicitly allowed.
- Buyer portal: only its approved leads, delivery detail, feedback, returns.
- Supplier portal: only its approved leads, volume, acceptance, conversion,
  payout, approved profit view.
- Never expose another party, a raw payload, a secret, an internal routing
  trace, an unapproved margin or suppression data.
- Tests: owner preview, buyer, supplier, missing link, stale role, forged query
  scope, direct endpoint access.

## Migration and reporting

- Migrate twelve months of required BigQuery history in restartable
  checkpointed batches, preserving source identifiers with an id map.
- Reconcile source count, imported count, rejected count, duplicates, lead
  totals, revenue, cost, margin, returns and sampled field parity.
- Re-running a completed batch is safe. Production import stays gated.
- Deliver cutover reporting for revenue, margin, volume, source, cost per lead,
  campaign, rejection reason, buyer rate, calls and state coverage.
- Preserve the path to configurable metrics, tables, views and charts without
  forcing the full report builder into cutover scope.

---

# PHASE 3: SHADOW, RELIABILITY, CUTOVER

## Shadow

Legacy stays authoritative. Native shadow may compute decisions but may not
deliver, bill, reserve live caps, emit conversion events or contact anyone.
Compare buyer, destination, reason, price, cap, schedule, DNC and outcome.
Define material discrepancy thresholds before reviewing results. Produce
explainable discrepancy records, not one aggregate percentage.

## Reliability

- Load test above the 180 lead daily peak with realistic bursts.
- Restart during receipt, validation, routing, delivery and finalization.
- Timeouts for HLR, TrustedForm, buyer endpoints, database and network.
- Health and readiness for process, database, receipt backlog, worker lease age
  and delivery backlog.
- Alerts for receipt backlog, queue age, delivery failures, auth anomalies,
  disk, database, backup and reconciliation failure.
- Encrypted daily backups, with restoration proved into a disposable
  environment.
- Runbook for start, stop, restart, deploy, rollback, key rotation, restore and
  incident response.

The second failover server stays deferred and is not part of required Phase 3
scope. Do not build it, do not provision it, and do not add it to a gate as a
blocker. At this volume the realistic ways to lose a lead are a crash
mid-processing, a bad deploy, or a hung external service, and capture-first
intake plus auto-restart plus a proven backup restore covers all three. A second
server only covers total hardware failure. The plan is to run thirty days and
decide with real incident data. Record that in `STATE.md` and proceed without
it unless Bru explicitly says otherwise.

## Cutover package

One manifest per supplier: source contract, expected volume, accepted response,
route, buyers, prices, caps, credentials by reference, monitoring, success
threshold, kill switch and rollback. Start with one low-risk supplier after
approval. Hold and reconcile before continuing. Captured leads stay safe when
native delivery is disabled.

---

# Deferred, deliberately, to protect the date

Documented and out of scope for cutover: the reports overhaul, buyer onboarding
changes, aged lead resale, call routing, authenticator app two-factor,
multi-tenancy, and the second failover server. Do not build them. If one turns
out to be a genuine dependency of a cutover task, say so in `STATE.md` and
scope the minimum needed, not the full feature.

---

# Definition of complete

A task is complete only when all of these hold:

- its acceptance behavior was observed running, against disposable data;
- targeted tests pass;
- `npm run gate` passes in full;
- outbound calls were blocked or mocked, with no live buyer, supplier, HLR,
  TrustedForm, Meta, Xero, banking, email, Slack or WhatsApp contact;
- an independent read-only reviewer returned PASS;
- a read-only security reviewer returned PASS for security-sensitive work;
- migration and rollback behavior are recorded;
- `STATE.md` records files, commands, results, commit, evidence, remaining risk
  and next task;
- no live or production action happened without approval.

Compiling is not evidence. Code inspection is not evidence. A written claim is
not evidence. Observed behavior is evidence.

# Working rules

- Read a file and its important callers immediately before changing it.
- Write or repair tests before implementation where practical.
- Use disposable test databases on port 5433 under an explicitly reserved test
  name, for example a `dashflo_test_` prefix. The harness must refuse to run
  when the target is `dashos`, or when the target contains live leads, banking
  rows, billing rows or any other production data. Make the refusal a hard
  failure that aborts the run, and detect it by inspecting the target database
  rather than trusting its name, because a production copy sitting under a test
  name is the exact accident this prevents. `dashos` holds 1887 real leads and
  real financial rows and is never a test target.
- New helper modules under `server/src/functions/` must be underscore prefixed,
  or the dynamic loader treats them as handlers and
  `npm run verify:functions` fails.
- Schema evolution is additive until a measured migration and rollback are
  approved. There is no migrations directory; entities are JSON definitions
  under `server/src/schemas/entities/` with JSONB-backed repositories.
- Change generated code only through its source and generator, and commit both.
- No em dashes in code comments, documents or human-facing copy. The gate
  rejects them on added lines.
- Review the full diff for secrets, personal data, tenant scope, idempotency,
  money, live URLs, schema changes and unrelated edits before committing.
- Commit each green bounded task to the existing branch. Push only after a full
  green gate. Never push to `main`. Never force push.
- Update `STATE.md` after every completed or blocked task.

# Human gates

Continue all safe local work before raising a gate. Present one consolidated
packet, never scattered questions.

**Gate A, automated writers.** Already satisfied on this host, see 0C. Collect
and record evidence. The only genuine open item is a cloud updater GitHub
workflow, if one exists. Do not run `install-scheduler.sh` or
`uninstall-scheduler.sh`.

**Gate B, credentials and unresolved configuration.** Names and decisions only.
Never request or display a credential value in chat. Include: required
environment variable names; keys needing rotation, with `MIGRATE_SOURCE_SECRET`
mandatory because a former value exists in git history; unresolved destination
contracts; configuration exceptions; production migration commands that are
ready but not executed; and your recommended answer plus consequence for every
decision. Keep implementing against mocks while the gate is pending.

**Gate C, production staging and first supplier.** Requires the exact green
commit and gate output, general and security reviewer PASS, authorization
matrix, supplier key and credential migration evidence, receipt crash and
replay evidence, DNC coverage across every intake path, buyer identity
reconciliation, routing and shadow discrepancy report, portal isolation,
delivery and billing idempotency, migration and monetary reconciliation, backup
restore drill, load and latency results, first supplier manifest and rollback.

**Gate D, broader cutover and retirement.** Requires first supplier operating
evidence, reconciliation, incidents, recommended next tranche, rollback status,
and the LeadByte and Base44 retirement checklist.

# STATE.md, after every task

Append: task and contract; files changed; tests and exact results; observed
behavior; reviewer result; commit and push status; rollback; remaining risk;
next ready task.

---

Begin now. Start with `docs/GROUND-TRUTH.md`, then Phase 0A. Do not ask whether
to continue.
