# DashFlo ground truth, verified 15 August 2026

Every fact below was proved by running the stated command in this folder on this
machine. Do not re-derive them from memory, from the audit pack, or from
`REPO-AUDIT-2026-08-15.md`. Re-run the command if you need to confirm a fact
after changing something.

## Scope of this document, and its limits

This file is evidence about the current machine. It is not a product authority.

It may override stale factual claims about machine state, repository state,
ports, paths, services, database contents and observed behavior. It may not
override what the product must do or what it must never do.

Source precedence, highest first:

1. Bru's latest explicit decisions
2. Security, privacy, legal suppression, and prevention of irreversible
   production actions
3. Reproducible current-machine evidence, which is this file
4. Executable tests and observed application behavior
5. Locked requirements and accepted architecture decisions
6. Historical audits, plans, comments and generated summaries

So this file outranks `REPO-AUDIT-2026-08-15.md` and any stale path, port or
service claim in `CLAUDE.md`, `README.md` or an earlier prompt. It does not
outrank an invariant in `CLAUDE.md`, a locked requirement in `REQUIREMENTS.md`,
a gate in `HUMAN-GATES.md`, or anything Bru has decided.

This is an editable document. Never use an edit to it as grounds for weakening a
security, privacy, legal or production-safety requirement. If machine evidence
appears to conflict with a level 1 or level 2 item, that is a finding to raise,
not a permission to proceed.

When a lower-precedence document contradicts a fact here, correct that document
in the same commit that discovers it.

## Product identity

DashFlo is a self-hosted lead intake, distribution, delivery, billing, portal
and reporting system. It runs on this machine. It is not a Base44 application
and it is not hosted on `legenex.com`.

| Surface | Authoritative value now | Future value |
|---|---|---|
| Application | `https://dashflo.io` | `https://app.dashflo.io` after DNS, TLS and login verification |
| Public supplier API | `https://api.dashflo.io` | `/functions/leads` for intake |
| Health | `https://dashflo.io/api/health` | same Node service on port 4000 internally |
| Vite dev server | `http://localhost:5173` (proxies `/api` to 4000) | local development only |
| Documentation | `https://docs.dashflo.io` | public documentation host |

The apex and `www` are reserved for the marketing website. The application
must not remain permanently on the apex. The controlled sequence is app DNS,
app certificate/vhost, application and login verification, canonical URL
switch, then marketing cutover. As observed on 16 August 2026,
`app.dashflo.io` had no DNS record; the required record is
`A app.dashflo.io 2.24.130.44`.

`dashboard.legenex.com`, `api.legenex.com` and
`progress.dashboard.legenex.com` are inherited fallbacks from the Base44 era.
They are not DashFlo hosts. `grep -rn "legenex\.com" client/src server/src`
returns 54 hits. They are configuration debt, not deployment truth.

Base44 is limited to temporary migration reads, encrypted owner export, and
reconciliation. The scheduled read path is isolated from normal runtime:
DashFlo continues operating from PostgreSQL when Base44 is unavailable. See
`docs/BASE44-BOUNDARY.md` for the current one-way sync design.

## Repository and branch state

```
git -C "/Users/nickallen/Documents/Projects/Legenex Dashflo" status --short
git log --oneline -3
git rev-list --left-right --count HEAD...origin/main
```

- Working folder: `/Users/nickallen/Documents/Projects/Legenex Dashflo`
- Remote: `legenex/legenex-dashflo`
- Local branch: `main` at `a63144c`
- `origin/main` at `84ab030`, local is 0 ahead and 3 behind, fast forward is clean
- The 3 missing commits are `95c544c`, `27348e0`, `84ab030`, all uploaded through
  the GitHub web interface, not by the sync job. `84ab030` adds `CLAUDE.md`,
  `MASTER-PROMPT.md`, `PRODUCT-BRIEF.md`, `REQUIREMENTS.md`, `EXECUTION-PLAN.md`,
  `HUMAN-GATES.md`, `STATE.md`, `REPO-AUDIT-2026-08-15.md` and a rewritten
  `README.md`, all at the repository root, not under `docs/`.
- Uncommitted: `client/src/pages/ToolsDashboard.jsx`, 173 added lines, a file
  upload and clipboard paste feature. It is real work. Preserve it.

### The working branch is not checked out here

`claude/dashflo-production-cutover-e1tgel` exists on the remote only. It is
3 commits ahead of `origin/main` and 0 behind:

- `c247649` F1/F2 truthful test baseline, root gate, fail-closed migration secret
- `07bb061` F0 record truthful baseline, close untracked-file gap in gate scanners
- `00eeab1` S1 to S3 make production exposure fail closed

Those objects are present in the local object store after `git fetch`, but the
current checkout is on `main` and does **not** contain them. Any instruction
that says "if the current branch already contains those commits, continue from
it" is describing a state that does not exist yet. You must land on the branch
first, using the procedure in the master prompt.

### Stale worktrees

`git worktree list` returns three entries, two of which are broken:

| Path | Branch | State |
|---|---|---|
| `.../Legenex Dashflo` | `main` | valid, this is the working copy |
| `.../Projects/dashflo-cutover` | `cutover-local` | broken, its `.git` file points at `/Users/nickallen/Documents/Projects/Legenex DashOS/.git/worktrees/dashflo-cutover`, a deleted path |
| `.../Legenex DashOS/.kilo/worktrees/iodized-spoon` | `iodized-spoon` | prunable, parent directory deleted |

Both broken entries are artifacts of the `Legenex DashOS` to `Legenex Dashflo`
folder rename. Prune them. Do not work inside them and do not try to repair
them.

## Local runtime state

```
launchctl list | grep legenex
ps -o pid,lstart,command -p 35631
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/api/health
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/
```

- Node `v22.23.1`, npm `10.9.8`
- PostgreSQL 16 running under `brew services`, listening on port **5433**, not
  5432. Server env: `PGHOST=localhost`, `PGPORT=5433`, `PGUSER=nickallen`,
  `PGDATABASE=dashos`, `PGSSL=false`. Any disposable test database must use
  5433.
- Database `dashos` has 91 tables with live data, including `e_lead` at 1887
  rows, `e_meta_sync_run` at 104977 rows, `e_ad_spend` at 222 rows and
  `e_bank_transaction` at 194 rows. This is production data. It is not
  disposable, and no test may touch it.
- Disposable test databases use port 5433 and an explicitly reserved test name,
  for example a `dashflo_test_` prefix. The test harness must refuse to run
  when the target database is `dashos`, or when it contains live leads,
  banking rows, billing rows or any other production data. The refusal is a
  hard failure that aborts the run, not a warning. Implement the check by
  inspecting the target database, not by trusting the name alone, because a
  copied production database under a test name is the exact accident this
  prevents.
- `/api/health` returns 200. `/` returns 404.

### Why the user interface is down

The server process, PID 35631, started at `Fri Aug 14 23:56:39 2026` from
`/Users/nickallen/Documents/Projects/Legenex DashOS/server/src/index.js`. That
directory no longer exists. The process survived the rename because macOS kept
its inode alive. Its working directory now resolves outside the project, so
every static file request fails with:

```
Error: ENOENT: no such file or directory, stat
  '/Users/nickallen/Documents/Projects/Legenex DashOS/client/dist/index.html'
```

`client/dist/index.html` exists in this folder, freshly built. Nothing is wrong
with the build. The path is wrong.

If PID 35631 ever exits, launchd cannot restart it, because
`~/Library/LaunchAgents/com.legenex.dashos.server.plist` still points at the
deleted path. The server is running on borrowed time.

### Scheduler state, which is Gate A evidence

```
launchctl print gui/501/com.legenex.dashos.sync      -> Could not find service
launchctl print gui/501/com.legenex.dashos.updater   -> Could not find service
launchctl print gui/501/com.legenex.dashos.server    -> loaded, PID 35631
```

| Label | Plist target | Loaded |
|---|---|---|
| `com.legenex.dashos.server` | `.../Legenex DashOS/server/src/index.js` | yes, stale path |
| `com.legenex.dashos.sync` | `.../Legenex DashOS/sync/sync.mjs` | **no** |
| `com.legenex.dashos.updater` | `.../Legenex DashOS/sync/daily-update.mjs` | **no** |

Both mutating writers are already unloaded. The hourly sync stopped at the same
23:56 timestamp as the rename, which is exactly why this checkout fell 3 commits
behind `origin/main`. Gate A is therefore already satisfied on this host by
accident, and your job is to record the evidence and keep it that way, not to
ask Bru to pause something that is already paused.

The plist files still exist and still point at the dead path. They will not run.

### Do not run scripts/install-scheduler.sh

`scripts/install-scheduler.sh` derives `ROOT` from its own location, so it would
correctly repoint the server. It also rewrites and bootstraps the sync and
updater agents at lines 161 and 162, runs `sync.mjs --init` at line 153, and
would put an hourly writer back on this checkout. That is the opposite of Gate A.

`scripts/uninstall-scheduler.sh` is also wrong, because it stops the API server
along with the writers.

The correct action is a server-only repoint, specified in the master prompt.

## Build and test state

- Root `node_modules` is **empty**. `npm run gate` cannot run until root
  dependencies are installed. The `gate`, `test`, `lint`, `verify:functions`,
  `scan:secrets` and `check:em-dashes` scripts and the `vitest` devDependency
  exist only in the branch copy of `package.json`, not in the `main` copy.
- There is no root `package-lock.json` on `main`. The branch adds one, 1603
  lines, in commit `c247649`. Install order therefore matters: land the branch
  first, then run `npm ci` against the lockfile it brings. Reach for
  `npm install` only if the lockfile is genuinely absent or invalid, and record
  the reason in `STATE.md`. Do not casually rewrite the lockfile, because a
  silently regenerated tree makes every later gate result unreproducible.
- `server/node_modules` has 125 entries, `client/node_modules` has 458. Those
  are installed.
- Root `package.json` still declares `"name": "legenex-dashos"` and a
  description naming Legenex DashOS. Branding rename is outstanding.
- `scripts/` contains `check-em-dashes.mjs`, `gate.mjs`, `secret-scan.mjs` and
  `verify-function-loader.mjs` on the branch only.
- The gate rejects em dashes on added lines. Every document and comment you
  write must avoid them.

## Verified code findings

These were re-proved today. They are the reason the remaining task ladder is
ordered the way it is.

1. **Leads are enriched before they are saved.**
   `server/src/functions/processLead.js` is 2618 lines.
   `db.entities.Lead.create(...)` first appears at line 1453. Everything before
   that line is phone validation, email validation and TrustedForm, which are
   calls to third-party servers. A restart or a hung dependency inside that
   window destroys the lead with no record that it existed. This is I1.

2. **Supplier keys are stored retrievably and looked up in cleartext.**
   `processLead.js:1355` runs `db.entities.ApiKey.filter({ key: supplierKeyRaw })`.
   Usage counters are updated at line 1431. This is S4.

3. **Route-member suppression exists and works. A global legal DNC service does
   not.** Do not state that suppression is absent. Two different things share
   the word.

   What exists, verified, and must be preserved:

   - `client/src/lib/distribution/engine.js:148` gates member eligibility on
     `Array.isArray(m.suppression) && matchesSuppression(m.suppression, l)` and
     returns `REASON.SUPPRESSED`. It is step 5 of the eligibility chain, after
     schedule and filters, before caps.
   - `matchesSuppression` at `engine.js:188` compares a lowercased trimmed
     email and a digits-only phone against the member's list.
   - The backend mirror is `server/src/functions/routingEngine.generated.js:100`
     and `:127`, a generated file whose header names
     `client/src/lib/distribution/backend-entry.js` as source of truth and
     carries a `canonical-engine-sha256`.
   - Schema support: `RouteMember.json` has `suppression_list_id`,
     `Buyer.json` has `suppression_lists` as a JSON array of names or
     references, surfaced at `client/src/pages/BuyerDetail.jsx:75`.
   - Operator messaging: `simulator.js:20` renders
     `'Lead is on the suppression list'` and `simulateReport.js:16` renders
     `'Suppressed'`.
   - Test coverage: `client/src/lib/distribution/engine.test.js:93`, "applies
     suppression by email or phone", asserting `REASON.SUPPRESSED`.

   What is missing: a global legal do-not-contact service, enforced across
   every real intake source, before delivery, contact, billing or conversion
   events. Today's mechanism is per route member and per buyer, evaluated
   inside routing eligibility, which is far too late and far too narrow for a
   legal obligation. A lead that reaches no route member is never checked at
   all.

   Two further observations about the existing mechanism, recorded so the DNC
   work does not silently inherit them. First, the runtime gate reads an inline
   `m.suppression` array while the schemas store `suppression_list_id` and
   `suppression_lists` as references, so there is a resolution seam between
   stored configuration and evaluated data. Second, matching is exact string
   equality after light normalization, with no keyed hashing.

   Also present but unrelated despite the shared word: the capture-only test
   mode at `processLead.js:2001` to `2067`, which withholds outbound delivery
   and records `'Captured for testing. Outbound delivery intentionally
   suppressed.'` That is a test harness, not a contact preference.

   The DNC gap is still the only remaining gap with a legal consequence rather
   than a commercial one. This is I2. Build it as an additional canonical
   service, and leave route and buyer suppression working.

4. **Bearer tokens live in browser local storage.**
   `client/src/api/client.js:9` and `:12`, plus `client/src/lib/app-params.js:8`.

5. **Billing is already built.** The `Buyer` schema carries `billing_type` with
   prepay, net 7, net 15 and net 30, wallet versus post-pay mode, credit limits
   and Xero payment links. `server/src/schemas/entities/` holds 90 entity
   definitions including `BuyerWallet`, `BuyerPayment`, `Invoice`,
   `BillingRun`, `BillingLineItem`, `CapCounter` and `CapReservation`. Verify
   and wire, do not rebuild.

6. **Schema is JSON-entity driven.** There is no migrations directory.
   `server/src/db/schema.js` plus `server/src/schemas/entities/*.json` define
   the model, and `server/src/db/repo.js` provides JSONB-backed repositories.
   Schema evolution is additive.

7. **Backend functions load dynamically.** `server/src/functions/` holds 106
   files; the loader reports 94 handlers because helper modules are prefixed
   with an underscore (`_llmClient.js`, `_pageManifest.js`, `_readiness.js`).
   A new helper without that prefix will be loaded as a handler and will break
   `npm run verify:functions`.

8. **The routing engine generator is not in this repository.**
   `routingEngine.generated.js` instructs `node scripts/generate-backend-engine.mjs`,
   but that file exists only at `.sync/upstream/scripts/generate-backend-engine.mjs`
   inside the upstream mirror, not in this repository's `scripts/`. Any change
   to routing eligibility, including anything touching the suppression step,
   must go through `client/src/lib/distribution/backend-entry.js` and a working
   generator, with source and generated output committed together. Restoring a
   first-class generator entry point is a prerequisite for editing routing
   safely. Hand-editing the generated file violates the invariant in
   `CLAUDE.md` and will be silently overwritten.

## What this changes about the plan

- Gate A is evidence collection, not a request to Bru.
- Phase 0 has to land the branch and revive the interface before any feature
  work, because you currently cannot see the application you are changing.
- Install order is land the branch, then `npm ci` against the lockfile it
  brings.
- The database on this host is production. Every experiment goes to a reserved
  disposable test database on port 5433, and the harness refuses to run against
  `dashos` or against any database holding live data.
- I2 is additive. Global DNC is built alongside route and buyer suppression,
  which keeps working and keeps its tests passing.
