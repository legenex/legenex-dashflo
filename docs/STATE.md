# DashFlo autonomous build state

Update this file after every completed or blocked task. It is the persistent handoff between sessions and agents.

## Current control state

- Audited base: `a63144cb0e1a2c000e873e94e5091565f6bbb1c6`
- Current base: `117a3f1fa6e274e5fdd830d458641b1de0f76a1c`
- Working branch: `main`. Ordinary work happens on `main` and reaches production
  automatically through GitHub Actions. The earlier
  `claude/dashflo-production-cutover-e1tgel` branch is history, not a
  requirement.
- Canonical agent contract: `AGENTS.md`. `CLAUDE.md` is a short Claude Code
  entrypoint that defers to it.
- Release mode: autonomous. A safe change that passes the gate is committed,
  pushed, deployed, monitored and verified by the agent without a manual step
  from the operator. See "Authentication and autonomous release state" below.
- Auto-sync status: PAUSED at source. Both launchd writers booted out and
  persistently disabled on the operator workstation, 15 August 2026. See
  "Gate A resolution" below for the verification evidence. Nothing is writing to
  `main` on a schedule.
- Current phase: Phase 1 complete, Phase 2 in progress
- Active human gate: Gate A approved and closed. Gate B pending. LIVE URL GATE
  open, see `docs/LIVE-URL-GATE.md`. Ordinary application releases no longer sit
  behind a manual deployment gate.
- Production commit: `117a3f1`, placed there by GitHub Actions run 32141125172
  on 18 August 2026
- Last green commit: `117a3f1`
- Last full gate: PASS at `117a3f1` in GitHub Actions run 32141125172, seven
  steps

## Delta audit, audited base to current base

Performed before editing, as required when the repository has moved.

`git diff --name-status a63144c..84ab030` returns nine paths, all
documentation: `CLAUDE.md`, `EXECUTION-PLAN.md`, `HUMAN-GATES.md`,
`MASTER-PROMPT.md`, `PRODUCT-BRIEF.md`, `README.md`,
`REPO-AUDIT-2026-08-15.md`, `REQUIREMENTS.md`, `STATE.md`.

No application code changed. Every code finding in the audit was
re-verified against the current commit and still holds.

Two structural differences from the pack's assumptions:

- The governing documents are at the repository root, not under `docs/`.
  `CLAUDE.md` refers to `docs/...` paths that do not exist.
- `.claude/` was never installed, so there are no project hooks, agents or
  settings. `CLAUDE.md` step 5 refers to `.claude/hooks/task-gate.sh`,
  which does not exist. `npm run gate` is the working replacement.

## Auto-sync status

- `sync/sync.mjs`, `sync/daily-update.mjs` and
  `sync/cloud-updater.workflow.yml` are present and are the upstream sync
  engine. `scripts/install-scheduler.sh` installs it as a scheduled job.
- Inside this container there is no crontab, no systemd timer and no
  `.github/` workflow directory, so nothing is writing to this checkout
  right now.
- Git history shows the writer is real: 20 of the last 24 commits are
  `Auto-sync upstream ...`. It runs wherever the scheduler is installed,
  not here.
- Work is isolated on `claude/dashflo-production-cutover-e1tgel`. Pausing
  the upstream job before integration remains a Gate A request.

## Gate A resolution, 15 August 2026

Bru approved Gate A and chose option 1, pause the upstream auto-sync for
the cutover period. The earlier "no writer inside this checkout" finding
was correct but incomplete: it was measured from a cloud container. The
writer runs on the operator workstation, which is where it was located and
stopped.

### Writer identification

The active automated writer to `main` is `com.legenex.dashos.sync`, a
launchd user agent on the operator workstation.

| Candidate | Verdict | Basis |
|---|---|---|
| `com.legenex.dashos.sync` | ACTIVE WRITER | Runs `sync/sync.mjs` hourly, `StartInterval` 3600. `commitAndPush()` commits as `legenex <team@legenex.com>` and runs `git push origin main`. Its own log records `pushed to origin/main` at 2026-08-14T13:38:50Z and 2026-08-14T21:56:42Z. |
| `com.legenex.dashos.updater` | ACTIVE WRITER, indirect | Runs `sync/daily-update.mjs` at 03:30 local. That script shells out to `sync.mjs --force`, which reaches the same push path. Same writer, second trigger. |
| Cloud updater GitHub workflow | NOT ACTIVE | `gh workflow list` and `gh run list` on `legenex/legenex-dashflo` both return empty. The repository has no `.github/` directory. `sync/cloud-updater.workflow.yml` is an uninstalled template. Corroborated by `sync/cloud-baseline.json`, still pinned at `83587f35` from 12 August while the local sync advanced to `194f0e17`, and by the absence of any `Cloud auto-sync` commit in history. |
| Another external scheduler | NOT ACTIVE | No user crontab. No `com.legenex.dashos.*` job in `/Library/LaunchDaemons` or `/Library/LaunchAgents`. The other user agents point at unrelated trees: `com.legenex.buzz.autopush` at `~/Projects/Buzz`, `com.legenex.unclaimed-backup` at `~/Projects/Youtube/Unclaimed`, `com.agentos.dashboard` at an unrelated Next.js app, `com.legenex.buzz-client-guard` at `~/.buzz`. |

### Commands used to pause only the two jobs

`scripts/uninstall-scheduler.sh` was deliberately not used, because it also
boots out `com.legenex.dashos.server` and deletes all three plists.

```
UIDN="$(id -u)"; DOMAIN="gui/$UIDN"
for L in com.legenex.dashos.sync com.legenex.dashos.updater; do
  launchctl bootout  "$DOMAIN/$L"
  launchctl disable  "$DOMAIN/$L"
done
```

`bootout` unloads the job for the current session. `disable` writes a
persistent flag to the per-user service database so a login or reboot does
not silently reload it. Both are needed. The plist files are left in place,
so the pause is reversible with `launchctl enable` followed by
`launchctl bootstrap`, or by re-running `scripts/install-scheduler.sh`.

### Verification evidence, observed 15 August 2026 at 07:56 local

`launchctl list | grep -i legenex`, both target labels absent:

```
35631	-15	com.legenex.dashos.server
-	0	com.legenex.unclaimed-backup
-	1	com.legenex.buzz.autopush
-	0	com.legenex.buzz-client-guard
```

`launchctl print gui/$(id -u)/<label>` per job:

```
com.legenex.dashos.sync            -> NOT LOADED
com.legenex.dashos.updater         -> NOT LOADED
com.legenex.dashos.server          -> LOADED
```

`launchctl print-disabled gui/$(id -u)`, persistent flags:

```
"com.legenex.dashos.server" => enabled
"com.legenex.dashos.sync" => disabled
"com.legenex.dashos.updater" => disabled
```

API server left running, as required:

```
state = running
pid = 35631
program = /opt/homebrew/bin/node
35631 /opt/homebrew/bin/node .../server/src/index.js
health HTTP: 200
```

Negative control. The sync agent last ran at 04:57:24Z and fires hourly, so
runs were due at 05:57Z and 06:57Z. The jobs were booted out at 05:56Z. Both
due times have now passed and the last line of `sync/state/sync.log` is
still `2026-08-15T04:57:24.772Z no changes (at 194f0e17)`, with the file
mtime still 06:57:24 local. Two consecutive missed runs, re-checked at
06:37Z. The pause holds.

Re-check this immediately before any merge. A single missed run could be
coincidence; the log not advancing across several scheduled times is the
evidence that matters.

### Writer that is not automated and is not covered by this pause

`origin/main` is at `84ab0303`, three commits ahead of the workstation
checkout of `main` at `a63144cb`. Those three commits are authored by
`Legenex <nick@legenex.com>` on 2026-08-15 between 00:48 and 00:50 with the
messages `Add files via upload`, `Delete legenex-dashflo-main.zip` and
`Add files via upload`. That message shape is the GitHub web upload
signature, so a human pushed to `main` through github.com. Disabling
launchd jobs cannot prevent that. The delta is documentation only and is
already covered by the delta audit above, and this branch is built on top
of `84ab030`, so nothing is lost. Before merging, confirm with Bru that no
further web uploads will land, or protect `main`.

`UNPROVEN`: whether any writer exists on a machine other than this
workstation. The checks above cover this workstation and the GitHub
Actions surface for `legenex/legenex-dashflo` only.

## Verified baseline at `84ab030`, re-measured 14 August 2026

The 15 August figures could not be reproduced as written, because no test
runner was installed at any level. Corrected values:

| Measure | Audit claim | Observed at `84ab030` |
|---|---|---|
| Test runner | implied present | absent: no vitest, jest or `test` script anywhere |
| Test files | 47 | 47, confirmed |
| Tests | 464 passed, 1 failed | 457 passed, 1 failed, 4 files could not collect |
| Failed suites | 4 | 5 files: 4 uncollectable, 1 failed assertion |
| Obsolete path suites | 3 | 4: the audit missed `autoCreatedReviewConfig` |
| Client build | passes with warnings | confirmed |
| Client lint | 36 errors | confirmed, all `unused-imports` |
| Function loader | 94 loaded, 3 invalid | confirmed exactly |
| Server advisories | 3 total, 2 high | 3 total, 2 high, 1 low, confirmed |
| Client advisories | 7 total, 2 high, 5 moderate | 9 total, 4 high, 5 moderate |

The fourth obsolete suite, `autoCreatedReviewConfig`, resolved its target
through `process.cwd()` and so only collected when the runner was started
from `client/`. It is repaired along with the other three.

Client advisory counts moved because the advisory database moved, not
because dependencies changed.

## Baseline after Phase 0, at `c247649`

- `npm run gate`: PASS, all six steps.
- Tests: 48 files, 480 tests, all passing.
- Function loader: 94 loaded, 0 errors.
- Client lint: 0 errors, no rule weakened or disabled.
- Client build: passes.
- Secret scan: clean.
- Outbound network in tests: blocked and proven by
  `server/test/networkGuard.test.js`.

## Task board

| Task | Status | Owner | Branch or worktree | Commit | Evidence | Blocker |
|---|---|---|---|---|---|---|
| F0 Freeze and branch | Done | Lead | cutover branch | `c247649` | Delta audit and auto-sync status above | |
| F1 Truthful harness | Done | Lead | cutover branch | `c247649` | `npm run gate` PASS, 48 files, 480 tests | |
| F2 Dependency baseline | In progress | Lead | cutover branch | `c247649` | Advisories classified below | High severity remediation not yet applied |
| S1 Auth fail-closed | Done | Lead | cutover branch | `pending` | Live probe, 22 of 22 checks | |
| S2 Entity authorization | Done | Lead | cutover branch | `pending` | Matrix plus route tests, 40 tests | |
| S3 Function authorization | Done | Lead | cutover branch | `pending` | Route deny-by-default, 11 tests | Two public webhooks still lack own verification |
| S4 Secret storage | Done | Lead | cutover branch | `84a5798`, ADR `c04e2fc` | Hash path proven by 42 tests; ADR 0001 written; rotation list in ADR and Gate B | Cleartext purge deliberately deferred, preconditions below |
| I1 Durable receipt module | Done | Lead | cutover branch | `84a5798`, `0d48043` | 19 tests against real PostgreSQL 16 on 5433, five consecutive green runs | Not wired into processLead; that is I3 |
| I2 Global DNC module | Review | Lead | cutover branch | `3c568d0`, `c04e2fc` | 35 module tests plus 27 enforcement tests including route suppression regression | Operator UI not built; audited export not built; wiring is I3 |
| I3 Pipeline integration | Review | Lead | cutover branch | `b347515` | 44 tests: 19 against real PostgreSQL, 25 call graph. Gate 829 passing, none skipped | Independent review pending. Two outcome reconciliation paths documented rather than integrated, see below |
| R1 Buyer identity normalization | Review | Lead | cutover branch | `bbf25a3` | 18 tests plus an observed apply and rerun on a disposable database | Not run against production data |
| R2 Routing and caps | Blocked | | | | | |
| R3 Delivery and parsing | Blocked | | | | | |
| M1 Billing and returns | Blocked | | | | | |
| P1 Portal isolation | Blocked | | | | | |
| C1 Configuration recovery | In progress | Lead | cutover branch | `bbf25a3` | 23 tests plus an observed run producing real blockers | Only buyers, suppliers, campaigns and credential references are covered. Routes, destinations, caps, schedules, mappings and response rules are not. A Gate B packet built from it today would be incomplete. |
| D1 History import | Blocked | | | | | |
| O1 Shadow comparison | Blocked | | | | | |
| O2 Reliability | Blocked | | | | | |
| O3 Cutover runbook | Blocked | Lead | | | | |

Use only these statuses: Ready, In progress, Review, Blocked, Done.

## Accepted architecture decisions

| ADR | Decision | Date | Commit |
|---|---|---|---|
| [0001](docs/adr/0001-secret-storage.md) | Supplier API keys are hash only at rest; destination credentials stay server side behind an opaque reference; neither field is writable through the generic entity route | 15 Aug 2026 | `84a5798` implementation, ADR written at `c04e2fc` |

## Evidence log

For each completed task append:

```
TASK:
CONTRACT:
FILES:
COMMANDS:
RESULTS:
OBSERVED BEHAVIOR:
REVIEWERS:
COMMIT:
ROLLBACK:
REMAINING RISK:
```

## Dependency advisories at `84ab030`

Recorded, not blindly fixed. `npm audit fix --force` would pull an
unreviewed major upgrade, and the audit is explicit that xlsx has no
automatic patched path.

Server, 3 advisories:

| Package | Severity | Patched path | Position |
|---|---|---|---|
| `nodemailer` | high | yes, 9.0.5, semver major | Remediate with a regression test. Used for OTP, invite and reset mail. |
| `xlsx` | high | none available | Replace or isolate based on actual usage. Not yet done. |
| `body-parser` | low | yes | Transitive through express. Take with the express update. |

Client, 9 advisories, 4 high and 5 moderate:

| Package | Severity | Patched path | Position |
|---|---|---|---|
| `brace-expansion` | high | yes | Transitive dev only. Safe to take. |
| `js-yaml` | high | yes | Transitive dev only. Safe to take. |
| `nanoid` | high | yes | Safe to take. |
| `postcss` | high | yes | Build time. Safe to take. |
| `dompurify` | moderate | yes | Reaches rendered content. Take with a check. |
| `react-router` and `react-router-dom` | moderate | yes | Open redirect. Routing is load bearing, so take with a test pass. |
| `quill` and `react-quill` | moderate | only by downgrade to 0.0.2 | Not a real fix. Assess actual usage and replace or isolate. |

`UNPROVEN`: no advisory has been remediated yet. F2 stays open.

## Gate B rotation list, credential references only

- `MIGRATE_SOURCE_SECRET`. A shared secret was committed in
  `server/src/functions/migrateSource.js` and is in git history. The
  endpoint streams every entity in the database. Treat the old value as
  compromised, generate a new one per environment, and place it directly
  in the production secret mechanism. Never in chat, a spreadsheet, an
  issue, a commit or a fixture.
- `JWT_SECRET`. Production currently falls back to a known development
  value. Phase 1 makes startup refuse the fallback; a real value is still
  required at deploy time.
- `DNC_HASH_KEY`. New in I2. The key that all do-not-contact entries are
  hashed under. It has no default and the DNC surface fails closed without
  it. Note before setting it: rotating this key later invalidates every
  stored suppression, and the raw contacts are deliberately not kept, so a
  rotation means rebuilding the list from its original sources. Decide the
  key management approach before the list is populated.

No values appear in this repository, and none should be pasted into it.

## Phase 1 evidence: production exposure fails closed

Observed against a real server process and a disposable PostgreSQL 16
database on loopback, not inferred from compilation. Probe script:
`scratchpad/authProbe.mjs`, 22 of 22 checks passed.

| Behaviour observed | Result |
|---|---|
| public-settings reports registration closed by default | `registration_open: false` |
| First registration bootstraps the owner | 200 |
| Second registration while closed | 403 Registration is closed |
| Password under 12 characters | 400 |
| Session cookie flags | HttpOnly, SameSite=Lax, Secure off in development |
| Anonymous entity read | 401 |
| Owner reading an unlisted entity | 403 |
| Owner reading a policied entity | 200 |
| Raw API key in create response | absent, prefix retained |
| Raw API key in list response | absent, prefix retained |
| Anonymous call to a non-public function | 401 |
| Anonymous function index | 401 |
| Anonymous call to a public function | 200 |
| migrateSource with the previously committed secret | 403 |
| Cross-site cookie-authenticated write | 403 |
| Same-origin cookie-authenticated write | 200 |
| Repeated failed logins | 429 |
| 200 KB auth body | 413 |

Production startup refusal was observed in a real process:
`NODE_ENV=production node server/src/index.js` exits 1 and names the
development JWT secret and the missing public base URL, without printing
any secret value.

Race-safe owner bootstrap was observed under real concurrency: eight
simultaneous registrations against a completely empty instance produced
one 200, four 403 and three 429, and the database ended with exactly one
user holding `base_role` owner.

## Known gaps carried forward from Phase 1

- `leadbyteWebhook` and `buyerFeedbackWebhook` are on the public function
  allowlist but do not verify their own caller. The signature contract
  needs the third-party details, which is Gate B. The gap is asserted in
  `server/test/functionRoute.test.js` so it stays visible.
- Supplier API keys resolve by SHA-256 hash as of S4. The cleartext column
  is retained deliberately. See "S4 cleartext purge" below for what has to
  be true before it is removed.
- `IntegrationConfig.config` is written through `saveIntegrationConfig`,
  which merges server-side, and read through `integrationConfigStatus`,
  which returns settings by value and secrets as presence only. Both
  fields are now write-denied on the generic route as well as read-denied.
- `client/src/components/suppliers/PostingSpecs.jsx` still builds its
  supplier spec link with `specToken(apiKey?.key)`. That value has been
  absent since S1 read-denied it, so the link has been wrong since then,
  and S4 moved the canonical derivation to the key hash, which the browser
  also cannot see. The page needs a small server function that returns the
  token for an authorized operator. Not fixed here, to keep S4 bounded.
  `UNPROVEN`: no test currently asserts this page's behaviour.
- Rate limiting is in-process. Correct for a single node, wrong the moment
  a second node exists. Recorded here rather than assumed away.
- Bearer tokens are still persisted in browser local storage by
  `client/src/api/client.js`. The server now sets an HttpOnly cookie and
  the CSRF guard exempts header-authenticated calls, so removing the local
  storage token is a client change that can land next without a server
  change.

## S4 cleartext purge, preconditions

The `ApiKey.key` column still holds the legacy cleartext value. Removing it is
a separate task and must not run until all of the following are true. Each is
checkable, not a judgement call.

1. `node server/scripts/backfill-api-key-hashes.js` reports zero rows in
   "would hash" and zero in "unrecoverable" against the production database.
2. Every supplier posting in the observation window resolved by hash. The
   resolver reports `matchedBy` for exactly this purpose. Any row still being
   matched by cleartext is a supplier that has not posted since the backfill,
   not a row that is safe to purge.
3. `DASHFLO_APIKEY_LEGACY_CLEARTEXT=0` has run in staging for a full cycle
   with no authentication failures.
4. Supplier posting spec links have been reissued, because `spec.js` derives
   its token from the key hash once cleartext is gone, and every link already
   handed to a supplier carries a token derived from the raw key.
5. A rollback exists. Purging is irreversible: the raw values are not
   recoverable from the hash, so a bad purge means rotating every supplier key.

## Corrections to historical assumptions

- Enrichment network calls occur after the first `Lead` create in the audited `processLead.js`; the smaller pre-create durability window remains.
- Self-hosted `Repo.list()` returns an array, including for an empty result.
- `Lead.buyer_id` is overloaded and must be normalized additively.
- Durable receipt capture occurs before business validation; DNC is first among business validations.
- The 15 August baseline could not have been produced by this repository as
  committed: no test runner was installed at root, server or client, and no
  `test` script existed. The audit's test numbers came from a tree that had
  a runner. Treat the corrected table above as the baseline of record.
- The audit lists three obsolete-path suites. There are four. The fourth,
  `autoCreatedReviewConfig`, was hidden because it failed only when the
  runner was started from the repository root.
- `scripts/check-engine-parity.mjs` is referenced by
  `client/src/lib/distribution/backend-entry.js` and by `parity.test.js`
  but does not exist in this repository. Behavioural parity between the
  canonical engine and the generated bundle is proven by `parity.test.js`.
  Hash parity is `UNPROVEN` because the generator did not survive the port.
- `server/src/functions/_llmClient.js` and its generated bundle are dead
  code. The live LLM path is `server/src/integrations/llm.js`. Removal is a
  separate bounded task, not folded into the harness work.

## Evidence log entries

```
TASK: F0 Freeze and branch
CONTRACT: Establish current commit, branch, versions, auto-sync risk, and a
  delta audit against the audited base before any edit.
FILES: STATE.md
COMMANDS: git rev-parse HEAD; git status; node --version; npm --version;
  ls .openai/hosting.json; git diff --name-status a63144c..84ab030;
  git log --oneline -24; ls .claude .github docs; crontab -l
RESULTS: HEAD 84ab030 on claude/dashflo-production-cutover-e1tgel, clean
  tree. Node v22.22.2, npm 10.9.7. .openai/hosting.json absent. Delta is
  documentation only, nine files, no application code. No cron, timer or
  workflow writer inside this checkout. .claude/ and docs/ absent.
OBSERVED BEHAVIOR: Every code finding in the audit re-verified at 84ab030.
REVIEWERS: Pending independent review.
COMMIT: c247649
ROLLBACK: Documentation only. git checkout a63144c -- STATE.md
REMAINING RISK: The upstream sync runs outside this container and can still
  move main. Gate A request stands.
```

```
TASK: F1 Truthful harness
CONTRACT: All 47 test files collect and pass; build and lint green; the
  backend loader reports zero invalid handlers; one root gate runs
  everything; tests cannot reach a live endpoint.
FILES: vitest.config.js, vitest.setup.js, package.json, scripts/gate.mjs,
  scripts/verify-function-loader.mjs, scripts/secret-scan.mjs,
  scripts/check-em-dashes.mjs, server/test/networkGuard.test.js,
  four repaired test suites, client/src/lib/progress/mask.js,
  three renamed helper modules and their two importers, 36 unused imports.
COMMANDS: npm run gate
RESULTS: PASS. tests 10.8s, function-loader 0.2s, lint 20.9s, build 22.4s,
  secret-scan 0.2s, em-dash 0.1s. 48 test files, 480 tests, 0 failures.
  Loader 94 loaded, 0 errors. Lint 0 errors.
OBSERVED BEHAVIOR: networkGuard.test.js observes fetch, http.request and
  dns.lookup to live third-party hosts throwing, and a loopback mock server
  returning a real response through the same guarded fetch.
REVIEWERS: Pending independent review.
COMMIT: c247649
ROLLBACK: git revert c247649. No runtime behaviour outside migrateSource
  changes, so revert is safe.
REMAINING RISK: Hash parity for generated bundles is UNPROVEN. Test
  coverage is still client-library heavy; the server pipeline has almost no
  direct coverage, which I1 through I3 must add.
```

```
TASK: Fail-closed migration secret
CONTRACT: migrateSource must not authenticate against a literal committed
  to the repository, and must refuse everything when unconfigured.
FILES: server/src/functions/migrateSource.js, server/.env.example,
  server/test/migrateSourceSecret.test.js
COMMANDS: npx vitest run server/test/migrateSourceSecret.test.js
RESULTS: 5 tests passed.
OBSERVED BEHAVIOR: With MIGRATE_SOURCE_SECRET unset, all five ops return
  403 and no entity rows appear in the response, including for the secret
  literal that was previously committed. With it set, the exact value
  returns 200 and a near miss of equal length and a prefix both return 403.
REVIEWERS: Pending independent and security review.
COMMIT: c247649
ROLLBACK: git revert c247649. Note that reverting restores a publicly
  readable secret on an endpoint that can read every entity, so prefer
  fixing forward.
REMAINING RISK: The endpoint still has no route level authentication,
  because the generic function route does not require any. That is S3. The
  old secret value remains in git history and must be rotated at Gate B.
```

```
TASK: Close the untracked-file gap in the gate scanners
CONTRACT: The secret scan and the em dash check must see brand new files,
  which is where a pasted credential or new prose is most likely to land.
FILES: scripts/secret-scan.mjs, scripts/check-em-dashes.mjs,
  server/test/migrateSourceSecret.test.js
COMMANDS: node scripts/secret-scan.mjs; node scripts/check-em-dashes.mjs,
  each run with a deliberately offending untracked probe file present and
  then absent.
RESULTS: Both scanners exit 1 with the probe present and exit 0 with it
  removed.
OBSERVED BEHAVIOR: Both scanners originally read only `git ls-files`, so
  the first gate run passed while the new script files were untracked. The
  secret scan then failed as soon as those files were committed, which is
  how the gap was found. Both now include untracked, non-ignored files.
  The em dash checker also matched its own literal, so it builds the
  character from its code point.
REVIEWERS: Pending independent review.
COMMIT: pending
ROLLBACK: git revert the follow-up commit. Scanners only, no runtime code.
REMAINING RISK: The compromised migrateSource literal was briefly written
  into a regression test at c247649 and remains in git history there as
  well as in its original location. Both are covered by the single Gate B
  rotation item. The test no longer contains the value.
```

```
TASK: S4 Secret storage
CONTRACT: Supplier API keys are hash-only at rest and resolve without the
  cleartext column. Integration credentials are written through a server-side
  service that merges a partial update over the stored blob, and are never
  returned to a client. Neither credential field is writable through the
  generic entity route. Cleartext is not removed in this change.
FILES: server/src/lib/apiKeys.js, server/src/lib/integrationConfig.js,
  server/src/functions/issueApiKey.js,
  server/src/functions/saveIntegrationConfig.js,
  server/src/functions/integrationConfigStatus.js,
  server/scripts/backfill-api-key-hashes.js,
  server/src/schemas/entities/ApiKey.json, server/src/lib/entityPolicy.js,
  server/src/functions/processLead.js, webhook.js, contract.js, spec.js,
  provisionLeadSource.js, server/package.json,
  server/test/apiKeyHashing.test.js,
  server/test/integrationCredentials.test.js,
  server/test/entityRoute.test.js,
  client/src/functions/{issueApiKey,saveIntegrationConfig,integrationConfigStatus}.js,
  client/src/components/settings/{SettingsApiKeys,ApiKeyConnectDialog,SettingsIntegrations,GooglePickerSettings}.jsx,
  client/src/components/finances/BankFeedTab.jsx,
  client/src/lib/financeSettings.js
COMMANDS: npx vitest run server/test/apiKeyHashing.test.js
  server/test/integrationCredentials.test.js; npm run gate
RESULTS: gate PASS, all six steps. 56 test files, 607 tests, 0 failures, up
  from 54 files and 562 tests at 00eeab1. 42 new tests cover the two new
  modules, 3 more cover the write-deny at the route.
OBSERVED BEHAVIOR:
  - A key resolves from its hash alone, with no cleartext present on the row.
  - A row holding only cleartext resolves through the fallback and is
    backfilled in place on the way through, and the second presentation of
    the same key takes the hash path. The cleartext column is not deleted.
  - With DASHFLO_APIKEY_LEGACY_CLEARTEXT=0 a cleartext-only row stops
    resolving and a backfilled row keeps resolving. That is the switch that
    proves the hash path stands on its own.
  - A failed backfill write does not fail the request.
  - mintApiKey produces 200 distinct keys with no collision and a 32
    character random segment from crypto.randomBytes. The previous browser
    generator used Math.random().
  - saveIntegrationConfig merges a partial update over the real stored blob:
    saving {account_id} against {api_token, account_id} persists both. A
    blank secret keeps the stored value. Removal requires an explicit clear.
  - No response from either integration function contains a secret value,
    asserted by scanning the serialized payload for the stored token.
  - PATCHing key, key_hash or config through the generic entity route is
    dropped before it reaches the database, on create as well as update.
REVIEWERS: Pending independent and security review.
COMMIT: pending
ROLLBACK: git revert the S4 commit. Safe in both directions: the change is
  additive at rest, so reverting restores cleartext resolution against rows
  that still carry cleartext. Any key minted after this change exists only as
  a hash and would have to be rotated, so prefer fixing forward once keys have
  been issued.
REMAINING RISK: Two concurrent writers to one IntegrationConfig row can still
  interleave. `Repo.update` has no optimistic locking and `config` is a single
  opaque string, so a service function's read-modify-write and an operator's
  save can overwrite each other. The window is much smaller than before,
  because the merge now happens server-side against fresh data, but it is not
  closed. `UNPROVEN`: no test exercises that race.
  The backfill script has not been run against a real database in this
  session, because no production or staging database was in scope.
```

```
TASK: I1 Durable receipt module
CONTRACT: A sanitized receipt commits before enrichment, validation, delivery
  or billing. Database constraints enforce transport idempotency and safe
  worker claiming. Every committed receipt reaches exactly one terminal
  outcome or stays visibly retryable. Replay after a crash cannot
  double-deliver or double-bill.
FILES: server/src/db/receiptSchema.js, server/src/lib/receipts.js,
  server/test/durableReceipt.test.js
COMMANDS: npx vitest run server/test/durableReceipt.test.js, run five times
RESULTS: 18 tests, all passing, five consecutive clean runs.
OBSERVED BEHAVIOR: Against a real PostgreSQL 16 on 127.0.0.1:5433 in a
  disposable database, not a double, because the properties are database
  properties.
  - Eight concurrent commits of one transport key produce exactly one row.
    The UNIQUE constraint decides, not a prior SELECT.
  - Four workers claiming at once, one wins. A leased receipt is invisible to
    a second worker. An expired lease is reclaimed and the attempt counter
    shows the retry, so a poison receipt is visible rather than silent.
  - A second completion is refused and the first outcome stands. A worker that
    lost its lease cannot write its result; the current lease holder can.
  - Inserting a terminal row with no outcome is rejected by
    lead_receipts_terminal_coherent, so "silently dropped" is unrepresentable.
  - A crash leaves the receipt in the pending backlog; a replacement worker
    claims it with the payload intact and completes it once.
  - Credential material never reaches the stored payload.
REVIEWERS: Pending independent and failure-mode review.
COMMIT: pending
ROLLBACK: Drop the lead_receipts table. Nothing reads it yet, because I3 has
  not run, so removal has no effect on the running system.
REMAINING RISK: Two real defects were found by these tests and fixed, both
  ordering related. created_date is not a total order, so FIFO claiming was
  nondeterministic when several receipts landed in the same instant; a
  BIGSERIAL seq column is now the tiebreak. And RETURNING does not preserve
  the subquery ORDER BY, so a claimed batch came back unordered; it is sorted
  before it is handed to the caller. Both would have surfaced only under load.
  `UNPROVEN`: behaviour under real concurrent load, as opposed to eight
  simultaneous statements, is not measured. That is O2.
```

```
TASK: I2 Global DNC module
CONTRACT: Match normalized phone and email with keyed hashes. Support scope,
  status, effective dates, reason, source, actor and immutable history.
  Support operator search, controlled add or expire, and bulk import.
  Suppressed leads keep a stable machine reason.
FILES: server/src/lib/dnc.js, server/src/schemas/entities/DncEntry.json,
  server/src/functions/dncManage.js, server/src/lib/entityPolicy.js,
  server/test/globalDnc.test.js
COMMANDS: npx vitest run server/test/globalDnc.test.js
RESULTS: 35 tests, all passing.
OBSERVED BEHAVIOR:
  - The same person written five ways normalizes to one hash. A plus tagged
    email does not collapse into the untagged one, because folding it would
    suppress somebody who never opted out.
  - Entries are HMAC-SHA256 under DNC_HASH_KEY, asserted to differ from a
    bare SHA-256 of the same input. A plain hash of a ten digit number is
    walkable offline; the key is what prevents that.
  - With DNC_HASH_KEY unset, hashing throws and dncManage returns 503 rather
    than answering "not suppressed", which would contact people who opted out.
  - Future dated, expired and out-of-window entries do not suppress, and an
    expired entry is retained rather than deleted.
  - A narrow scope with no scope value covers nothing, so a half configured
    entry does nothing instead of suppressing everyone.
  - Expiring is a status change with actor and reason recorded, and is
    idempotent. The route denies create, update and delete on DncEntry
    outright, so history cannot be rewritten through it.
  - No response or stored row contains a raw phone or email, including the
    bulk import report, which names row numbers instead.
REVIEWERS: Pending independent and security review.
COMMIT: pending
ROLLBACK: git revert. Nothing calls this module yet, so revert is inert.
REMAINING RISK: DNC_HASH_KEY is a new credential reference for Gate B, and it
  cannot be rotated without re-deriving every stored hash from values this
  system deliberately does not keep. Rotating it means rebuilding the list
  from its sources. This needs to be decided before the list is populated,
  not after.
  `UNPROVEN`: the operator UI and audited export are not built, and
  enforcement across every intake source is I3, so "identical across every
  real intake source" is not yet demonstrated.
```

```
TASK: R1 Buyer identity normalization
CONTRACT: Add buyer_record_id and buyer_code without deleting or redefining
  legacy buyer_id. Reconcile and backfill legacy and native leads with an
  exception report.
FILES: server/src/lib/buyerIdentity.js,
  server/scripts/backfill-buyer-identity.js,
  server/src/schemas/entities/Lead.json, server/package.json,
  server/test/buyerIdentity.test.js
COMMANDS: npx vitest run server/test/buyerIdentity.test.js;
  node scripts/backfill-buyer-identity.js; then --apply; then a plain rerun
RESULTS: 18 tests passing. Observed on a disposable database seeded with one
  lead per identifier shape.
OBSERVED BEHAVIOR: The resolver reads all three things buyer_id actually
  holds. A lead carrying the legacy bid 1002 and a lead carrying the code
  ALPHA both resolved to the right Buyer record.
  Verified directly in SQL after the apply run: buyer_id still reads
  "", "1002", "ALPHA", "who_is_this" exactly as before, and only
  buyer_record_id and buyer_code were added. Nothing was redefined.
  The rerun reported "already correct 2, to write 0", so the backfill is
  idempotent and an interrupted run is resumed by running it again.
  A duplicated buyer_code, a duplicated company name and an unknown
  identifier all become exceptions rather than guesses, because attaching a
  lead to the wrong buyer delivers to the wrong customer and charges the
  wrong account. The exception report carries lead ids and buyer identifiers
  only, asserted to contain no contact fields.
REVIEWERS: Pending independent review plus reconciliation evidence.
COMMIT: pending
ROLLBACK: The change is purely additive. To undo, clear buyer_record_id and
  buyer_code; buyer_id was never modified, so every existing reader is
  unaffected in both directions.
REMAINING RISK: `UNPROVEN` against production data. The resolution mix on
  twelve months of real history is unknown, and the exception rate is the
  number that decides whether R1 is done or needs another identifier source.
  Run the report-only mode against a production restore before D1.
```

```
TASK: C1 Configuration recovery
CONTRACT: Recover existing configuration automatically where possible and
  produce an artifact listing only the exceptions a human must resolve.
FILES: server/src/lib/configRecovery.js,
  server/scripts/recover-configuration.js, server/package.json,
  server/test/configRecovery.test.js
COMMANDS: npx vitest run server/test/configRecovery.test.js;
  node scripts/recover-configuration.js
RESULTS: 23 tests passing. Observed against a disposable database, both empty
  and seeded with deliberately broken configuration.
OBSERVED BEHAVIOR: On the seeded database it reported two blockers, an active
  supplier with no API key and a campaign routing to a buyer id that does not
  exist, and three credential references by name. It correctly refused to
  declare the configuration ready for Gate B while the blockers stood.
  Credential findings carry a name and a null value, asserted.
REVIEWERS: Pending independent review.
COMMIT: pending
ROLLBACK: Read-only reporting. Nothing to roll back.
REMAINING RISK: One real defect was found while exercising this against a
  database rather than only against fixtures. The liveness test was
  `active !== false`, and Buyer.active defaults to false in the schema while
  Supplier.active and Campaign.active default to true, so every buyer rule was
  dead and the report read as clean because the check never ran. It is now
  `active === true` everywhere, with a regression test that asserts each rule
  both stays quiet and fires. A silently dead rule in a Gate B artifact is
  worse than no rule, so the other checks deserve the same scrutiny during
  review.
  `UNPROVEN`: routes, destinations, caps, schedules, mappings and response
  rules are not yet recovered. Only buyers, suppliers, campaigns and
  credential references are covered, so this is not yet the full C1 surface
  and a Gate B packet built from it today would be incomplete.
```

## Recovery session, 15 August 2026: branch landing, localhost, live URL

### Recovered work that was nearly lost

The local worktree at `/Users/nickallen/Documents/Projects/dashflo-cutover`
carried four commits that existed nowhere else. Its `.git` file pointed at the
deleted pre-rename path, so it presented as a broken record that the plan said
to prune. It was not empty. `git worktree repair` restored it, and the branch
`cutover-local` held `84a5798` (S4), `3c568d0` (I1 and I2), `bbf25a3` (R1 and
C1) and `772589d` (Gate A negative control): 41 files and about 4450 lines,
including `lib/apiKeys.js`, `lib/integrationConfig.js`, `lib/receipts.js`,
`db/receiptSchema.js`, `lib/dnc.js`, `DncEntry.json`, `lib/buyerIdentity.js`,
`lib/configRecovery.js` and seven test files.

Protected three ways before any branch operation: the `cutover-local` ref, a
`refs/backup/cutover-local-20260815` ref, and a verified bundle. The feature
branch was then fast-forwarded onto that work, so nothing was recreated.

LESSON: a worktree whose gitdir points at a renamed path looks prunable and is
not. Prove emptiness with `git worktree repair` and `git status` before removing
any record.

### Branch landing

- Landed `claude/dashflo-production-cutover-e1tgel` in the main folder.
- `c247649`, `07bb061`, `00eeab1` confirmed ancestors, then fast-forwarded to
  `772589d`.
- Uncommitted `ToolsDashboard.jsx` preserved through the checkout, checksum
  `6ddcc9f1` before and after. Still uncommitted, pending its own tested commit.
- `npm ci` against the branch lockfile, not `npm install`.

### Gate baseline

`9157f73`: 60 test files, 686 passed, 15 skipped, loader 94 functions, lint,
build, secret-scan and em-dash all PASS.

The gate had been reporting `FAIL secret-scan` for a reason unrelated to
secrets. `scripts/secret-scan.mjs` derived its root from
`new URL(import.meta.url).pathname`, which keeps percent-encoding, so under a
folder named "Legenex Dashflo" the cwd resolved to a `Legenex%20Dashflo` path
that does not exist and every git call failed with `spawnSync git ENOENT`.
Fixed with `fileURLToPath`, which `gate.mjs` already used.

### Localhost restored, `519a01f`

- Service identity is now `com.legenex.dashflo.server`, running from the
  renamed folder, working directory verified.
- `scripts/install-server-agent.sh` is the server-only path. Both
  `install-scheduler.sh` and `uninstall-scheduler.sh` remain forbidden: the
  first revives the mutating sync and updater, the second stops the API server.
- Old `com.legenex.dashos.server.plist` renamed to `.disabled`, reversible, and
  only after the replacement was proven serving.
- `/` and `/api/health` both 200, verified across a stop and restart.
- Title renders DashFlo.
- Production startup now accepts plain http for loopback only. Non-loopback
  hosts still require https, compared on parsed hostname so
  `http://localhost.attacker.example` is refused.
- Retired host fallbacks removed from executable code and routed through
  `server/src/lib/urls.js` and `client/src/lib/urls.js`.
  `server/test/retiredHosts.test.js` fails if one returns. Docs pages are not
  exempt, because the curl example there is what suppliers copy.

### Gate A evidence

`com.legenex.dashos.sync` and `com.legenex.dashos.updater`: both report
"Could not find service" and neither appears in `launchctl list`. They stopped
at the rename, which is why this checkout fell 3 commits behind `origin/main`.
No crontab, no `.github/workflows`, no other scheduler writes here. Residual
risk: the plists still exist, so anyone running `install-scheduler.sh` revives
them.

### Base44 and live URL update, 16 August 2026

The earlier observe-only and unregistered `.co` notes below this repository's
history are superseded. Production is the Hostinger VPS at `2.24.130.44` using
`dashflo.io`, `api.dashflo.io`, and `docs.dashflo.io`. Base44 is a temporary
one-way migration source only. A deterministic HTTPS reader, durable sync
history, per-record provenance, incremental watermarks, conflict protection,
owner manual control, reconciliation, and a UTC six-hour cron template are now
implemented. No normal DashFlo request uses Base44.

The Base44 owner encrypted export and ordinary redacted export are separate.
Meta platform credentials are owner-only System Keys; supplier and buyer keys
remain separate. Full current detail and cutover order are in
`docs/BASE44-BOUNDARY.md`.

The code is prepared but not deployed by this session. API-host TLS/proxy,
timer installation, VPS data migration, final delta, and controlled production
lead verification remain Gate C actions. Do not mark them ready until they pass
on the public hostname.

## Session 15 August 2026, later: audit of recovered work and Phase E start

### Recovery preservation, verified before anything else

All four recovered commits are ancestors of the pushed feature branch, so the
recovered work is now on the remote and not only in a local worktree:

```
84a5798 3c568d0 bbf25a3 772589d  -> all ANCESTOR-OF-PUSHED-HEAD
```

Three independent backups are retained and will stay until the recovered work
has been verified in full:

- branch `cutover-local` at `772589d`
- ref `refs/backup/cutover-local-20260815` at `772589d`
- bundle, verified complete, at
  `/Users/nickallen/Documents/Projects/dashflo-recovery-backup/cutover-local-20260815.bundle`

The bundle was moved out of a previous session's scratchpad under `/private/tmp`,
which is not durable, into the path above. `git bundle verify` reports it okay
and recording a complete history.

### Audit of S4, I1, I2, R1 and C1 against acceptance criteria

| Task | Acceptance | Verdict | What was wrong |
|---|---|---|---|
| S4 | ADR, key hashing, credential protection, rotation list | Was incomplete, now met | Hashing, credential protection and the rotation list existed. The ADR did not, and the ADR table in this file was empty. Written as `docs/adr/0001-secret-storage.md`. |
| I1 | Commit, lease, replay, idempotency, crash tests pass | Was UNPROVEN, now met | The tests existed and did not run. See below. |
| I2 | Matching, scope, audit, UI and import tests pass | Partly met | Matching, scope, audit and import are covered. The operator UI and the audited export are not built. The intake enforcement path did not exist and has been added. |
| R1 | Additive fields, resolver, backfill and exception report | Met, with a stated limit | All four present and tested. Still `UNPROVEN` against production data, which is the number that decides whether R1 is finished. |
| C1 | Recovered config plus unresolved-exception artifact | Not met | Covers buyers, suppliers, campaigns and credential references only. Routes, destinations, caps, schedules, mappings and response rules are not recovered, so the Gate B packet it produces is incomplete. Status corrected from Review to In progress. |

### The gate was passing while its most critical suite never ran

The single most important finding of this session. `npm run gate` reported PASS
at `7527015` while all fifteen database tests for I1 were skipping, because
`dashflo_receipt_test` did not exist. Invariant 3, that replay after a crash
cannot double-deliver or double-bill, had no executed evidence behind it.

The file's own header claimed the database was "created and dropped by this
file". It was not. It only connected to it.

Corrected at `0d48043`. The suite now creates the disposable database when it is
absent, and only skips when PostgreSQL itself is unreachable. Test totals moved
from 733 passing with 15 skipped to 749 passing with none skipped.

A second hazard was found while fixing it and is now closed. `dashos` lives on
the same PostgreSQL server, port 5433, and every test in that file begins by
truncating the table it uses. `DATABASE_URL` takes priority over the discrete
PG variables in `config.js`, so any inherited value would have pointed the
suite, and its truncate, at whatever it named. The suite now proves what it is
connected to by name before anything destructive runs, and refuses otherwise.

Observed, with `DATABASE_URL` deliberately redirected at another database:

```
Refusing to run: connected to "dashflo_guard_probe", expected the disposable
"dashflo_receipt_test". These tests truncate the table they use, so they never
run against another database.
```

The probe database was inspected afterwards and had no `lead_receipts` table,
so the guard stopped the schema creation as well as the truncate. `dashos` was
verified untouched: 92 tables, no `lead_receipts`. The probe database was
dropped.

### Test code was one commit away from shipping to browsers

`client/src/components/progress/OffscreenCapture.jsx` builds its capture targets
with `import.meta.glob('/src/pages/**/*.jsx')`. Adding a colocated test file
under `client/src/pages` put that test file into the production bundle. It broke
the build only because it used top-level await, which the browser target
rejects. A test file without top-level await would have shipped in silence.

The globs now exclude test files, and `scripts/check-bundle-purity.mjs` is a new
gate step that reads the build output and fails if test code reaches it. Both
directions were observed: it fails on a planted test-shaped asset name and on a
planted test marker in asset text, and passes on a clean build.

### Evidence log entries

```
TASK: Tests for the Tools file upload and paste control
CONTRACT: Cover the existing upload and paste work without redesigning the page.
FILES: client/src/lib/fileUpload.js, client/src/lib/fileUpload.test.js,
  client/src/pages/ToolsDashboard.jsx, client/src/pages/ToolsDashboard.test.jsx,
  client/src/components/progress/OffscreenCapture.jsx,
  scripts/check-bundle-purity.mjs, scripts/gate.mjs, package.json
COMMANDS: npx vitest run client/src/lib/fileUpload.test.js
  client/src/pages/ToolsDashboard.test.jsx; npm run gate
RESULTS: 36 new tests, 29 on the rules and 7 on the rendered page. Gate PASS.
OBSERVED BEHAVIOR: Three defects in the inline logic were found by writing the
  tests and are fixed in the extracted module. split('.').pop() returned the
  whole filename for a name with no dot, so "README" was tested as "readme".
  getAsFile() can return null for an item reporting kind "file", and the old
  loop pushed that null into state where the row renderer then read .type off
  it and threw. The row renderer called file.type.startsWith directly, so a
  file arriving without a type string threw mid-list. The drop zone now opens
  the picker: the hidden input was wired to a ref nothing ever called, so
  "click to browse" and the Choose Files button did nothing. The handler
  ignores clicks originating from the input itself, because click() on the
  input bubbles back and would otherwise reopen the picker without end.
REVIEWERS: Pending independent review and behavior observation.
COMMIT: 7e01432
ROLLBACK: git revert 7e01432. The page markup is unchanged apart from the
  picker wiring, so reverting restores the previous behaviour exactly.
REMAINING RISK: uploadFiles still only simulates an upload. It logs the file
  list to the console and shows an alert; no request is made and no server
  endpoint exists. That is the user's existing work and was left as found.
  Refused files are still dropped without telling the operator; the extracted
  module now returns the refused list so a later change can surface it, but the
  page does not yet use it. `UNPROVEN`: no test exercises a real browser File
  object, only faithful stand-ins, because there is no DOM test environment in
  this repository.
```

```
TASK: Make the durable receipt suite run instead of skipping
CONTRACT: The gate must not report PASS while the evidence for invariant 3 is
  not executed. The suite must never run against the application database.
FILES: server/test/durableReceipt.test.js
COMMANDS: npx vitest run server/test/durableReceipt.test.js, five times;
  npm run gate; a deliberate run with DATABASE_URL redirected
RESULTS: 19 tests pass, five consecutive clean runs. Gate 749 passing, none
  skipped, up from 733 passing with 15 skipped.
OBSERVED BEHAVIOR: Recorded in full above.
REVIEWERS: Pending independent and security review.
COMMIT: 0d48043
ROLLBACK: git revert 0d48043. Reverting restores a gate that passes while
  fifteen tests do not run, so prefer fixing forward.
REMAINING RISK: The suite still skips when PostgreSQL is unreachable, which is
  deliberate, but a skip is still not evidence. A CI environment must have
  PostgreSQL 16 on 5433 or the same silent gap returns in a different form.
```

```
TASK: Global DNC enforcement, intake path
CONTRACT: One function every real intake source calls. Fails closed without
  losing the lead. Route and buyer suppression behaviour preserved.
FILES: server/src/lib/dncEnforcement.js, server/test/dncEnforcement.test.js
COMMANDS: npx vitest run server/test/dncEnforcement.test.js; npm run gate
RESULTS: 27 tests passing. Gate PASS, 776 tests, none skipped.
OBSERVED BEHAVIOR: The decision is three-valued, not boolean. A missing hash
  key, an absent repository and a failing lookup all return UNAVAILABLE, never
  CLEAR, because delivering to somebody who opted out is not recoverable while
  holding a lead whose receipt is already durable is. mayContinue() returns
  false for UNAVAILABLE, asserted directly.
  Suppression matches across phone formatting and email case and padding.
  Scope is honoured: campaign and vertical entries suppress only their own,
  a narrow entry with no scope value suppresses nothing, global suppresses
  regardless of context. Expired and future dated entries do not suppress.
  No raw phone or email appears in any decision or audit record, asserted by
  scanning the serialized output.
  Route member suppression was pinned in the same file: it still fails a member
  by email and by phone, it stays per member so one buyer suppressing a lead
  leaves another eligible, it keeps working with no DNC hash key present, a
  globally suppressed lead does not become a per member routing failure, and
  the two mechanisms carry different reason codes so an operator can tell which
  one fired.
REVIEWERS: Pending independent and security review.
COMMIT: c04e2fc
ROLLBACK: git revert c04e2fc. Nothing calls the module yet, because wiring it
  in is I3, so the revert is inert.
REMAINING RISK: `UNPROVEN`: "identical across every real intake source" is not
  demonstrated until I3 wires this into processLead and every caller is
  covered. The operator UI and the audited export for I2 are still not built.
```

## Next task

I3 pipeline integration. Its dependencies I1, I2, S3 and S4 are all satisfied,
and `server/src/lib/dncEnforcement.js` is the function it wires in. It is the
serial integrator task: no parallel agent edits `processLead.js`.

The reading step is done and recorded in `docs/I3-INTEGRATION-PLAN.md`: both
insertion points with line numbers, all six callers with what each needs, the
tests to write first, what to measure against the five second contract, and the
rollback. The edit itself has not started.

Summary of the two insertion points, against `acb55da`:

- Receipt commit goes after the dry run block closes at line 1431 and before
  `ApiKey.update` at 1433. After the dry run return so a validation still
  writes nothing, before `Lead.create` at 1456 so the receipt is the first
  durable write.
- Global DNC goes immediately after that, before `Lead.create` and well before
  `checkRequiredFields` at 1940, because it must be the first business
  validation. UNAVAILABLE releases the receipt back to the pending backlog
  rather than delivering or rejecting.

`webhook.js` authenticates with `resolveApiKey` but does not invoke
`processLead`. Confirm during the integration whether that is a missed intake
path or a supplier facing surface that legitimately does not ingest.

## Session 15 August 2026, evening: data refresh, I3, S4 postconditions

### Data refresh, run by the parallel session

`node sync/daily-update.mjs --no-code`, 16:46Z to 17:07Z. Not started by this
session: an instance was already running and a second was never started.

- `[code] skipped (--no-code)`. The prohibited code sync did not run.
- 90 entities, 4 groups plus 1 partitioned. Pulls 5 of 5 ok.
- Collapse gate passed: 89 files, 113,550 records against a 97,968 floor,
  which is `MIN_TOTAL_RATIO` 0.9 of the previous 108,853.
- Import: 113,550 records. Health 200. Finished OK.

Row totals, 109,210 to 113,553. Only three entities changed:

| Entity | Before | After | Delta |
|---|---|---|---|
| `e_error_log` | 107 | 122 | +15 |
| `e_lead` | 1887 | 1895 | +8 |
| `e_meta_sync_run` | 105,328 | 109,648 | +4,320 |

August 2026 leads by `final_status`. Only Sold moved:

| Status | Before | After |
|---|---|---|
| Sold | 176 | 184 |
| Disqualified | 195 | 195 |
| Unsold | 14 | 14 |
| Rejected | 9 | 9 |
| Returned | 4 | 4 |
| Duplicate | 2 | 2 |
| Qualified | 4 | 4 |

Note for anyone querying leads: `data->>'status'` is null on every row. The
populated field is `data->>'final_status'`. And `created_date` is a real column,
not a JSONB key, so date filters belong on the column.

Deletions reproduced: `ApiKey` holds 5 rows and zero named LeadFlow, matching
the source. The James M / LeadFlow key deletion is reflected locally.

Import fidelity, three apparent discrepancies, all resolved:

- `e_user` has 3 rows and no export file. Correct: the importer skips User by
  name, because local auth is not sourced from the old app.
- `e_meta_sync_run` shows 109,687 against an export of 109,648. The 39
  difference is entirely rows created after 17:07:00Z, confirmed by timestamp,
  the newest 12 seconds before the check. The local server is writing them
  live. Not an import failure.
- No unreadable files, no schema mismatches, no duplicate identifiers, no
  skipped rows beyond User.

### The refresh has no database backup, and the import deletes first

`sync/import-data.mjs --truncate` issues `DELETE FROM` on every target table
before reimporting, and the pipeline takes no database dump. The directories
under `sync/state/backups/` are code file backups from the legacy sync engine,
not database dumps, and the newest predates today.

The only protection is the 0.9 collapse ratio, which catches a wholesale
collapse and would not catch one entity silently returning a partial page while
the total stays within 10 percent.

A dump was taken before the import landed and verified by restore:

- Path: `~/Documents/Projects/dashflo-recovery-backup/db/dashos-pre-refresh-20260815.dump`
- Format: custom, 6.6 MB, `pg_dump -Fc`
- Restore verification: restored into a disposable `dashflo_restore_verify`
  database and compared row for row against the pre-refresh state. 109,210 rows
  across 91 entity tables, `diff` empty. The probe database was dropped.

`UNPROVEN`: nothing verifies the dump on a schedule, and no future refresh takes
one automatically. Taking a dump before a refresh is currently a human step.

### S4 postconditions, measured rather than assumed

Before the import, all 5 `e_api_key` rows carried cleartext and no `key_hash`.
The import reverted the S4 backfill, because the source app has no `key_hash`
field and `--truncate` replaces the whole blob. The parallel session re-applied
the backfill; the report mode run here observed 5 already hashed and 0 to do,
and wrote nothing.

Measured against ADR 0001:

| Precondition | State |
|---|---|
| 1. Backfill reports zero "would hash" and zero "unrecoverable" | MET. 5 scanned, 5 already hashed, 0 and 0. |
| 2. Every supplier posting resolved by hash | Partially. All 5 keys resolve by hash, but no real supplier traffic has been observed against them. |
| 3. `DASHFLO_APIKEY_LEGACY_CLEARTEXT=0` run in staging for a full cycle | NOT MET. There is no staging. Proven in isolation only. |
| 4. Supplier posting spec links reissued | NOT MET. |
| 5. A rollback exists | MET, as of the dump above. |

Authentication verified, not inferred:

```
fallback ENABLED  -> resolved by: {"hash":5}
fallback DISABLED -> resolved by: {"hash":5}
unknown key rejected: true
```

Resolving by hash with the fallback disabled is what proves the hash path
stands on its own. No credential value was printed, logged or committed.

**S4 is not complete.** Cleartext is still present on 5 of 5 rows, so invariant
10, hash only at rest, is not satisfied. That is the documented compatibility
path: purging is step 5 and must not run until the preconditions above are met.
Do not read "key_hash exists" as "S4 restored".

The regression loop is closed at `5d5b0e2`. `import-data.mjs` now derives
`key_hash` from the cleartext the source carries, so a refresh leaves the table
in the state S4 expects instead of one refresh behind. Additive, never deletes
cleartext, leaves a keyless row alone rather than hashing an empty string.

### ApiConnector.fb_access_token, unfinished S4 work

3 of 3 `ApiConnector` rows carry a non-empty `fb_access_token`, and the Base44
export carries all 3, so the refresh reimports them as plain JSONB values.

`ApiConnector` is `adminOnly()` in `entityPolicy.js`, so access is restricted.
But `fb_access_token` is **not** in the field projection that strips
`ApiKey.key`, `ApiKey.key_hash` and `IntegrationConfig.config` from responses.
An authorized admin reading `ApiConnector` through the generic entity route
receives the raw Meta CAPI token.

Recorded as unfinished, not fixed. Blanking or replacing these values would
break the live Meta connectors, and moving them behind the credential service
is a bounded task of its own. This is the same shape as the
`IntegrationConfig.config` work in S4 and belongs with it.

### I3, integrated

Committed at `b347515`. Detail in the commit message and
`docs/I3-INTEGRATION-PLAN.md`. What changed against the plan:

- The sequence went into `server/src/lib/intake.js` rather than inline, so the
  edit to the 2621 line canonical file is small and every caller runs one
  implementation.
- `webhook.js` was settled by evidence. It creates leads, so it needed pinning,
  but it is an outcome reconciliation endpoint with no delivery, billing,
  routing, connector or conversion capability at all. Asserted, not assumed.
- Writing that test found a second one. `leadbyteWebhook.js` also creates leads
  outside the canonical pipeline. The plan had listed it as a `processLead`
  caller on the strength of a grep for the name; all three hits are comments,
  and its own header says it never calls `processLead` or any routing. Same
  shape, same absent capabilities, now covered by the same assertions.
- The guard that catches the next bypass: no function file outside
  `processLead.js` and those two documented exceptions may call `Lead.create`.
  Adding one becomes a visible decision in a diff.

`UNPROVEN`: the under five second supplier response contract has not been
measured before and after the edit. The added work is one insert and at most
two indexed lookups by hash, so the expected cost is small, and expected is not
measured.

### Independent review of I3, and what it found

Two independent reviewers, correctness and security, both ran the real modules
rather than reading them. They agreed on four defects and found six between
them that were live at `b347515`. All six are fixed at `0272bf5`, each with a
test that failed before its fix.

| Defect | Why the green suite missed it |
|---|---|
| DNC read only `lead.phone`, so a lead posted as `mobile`, the canonical field, was never screened | The only fixture used `phone`, the one spelling production does not produce |
| `X_KEY`, a documented key alias, was not in the sanitizer denylist, so receipts stored a live ingest credential | The credential test used only aliases the denylist already covered |
| Suppressed receipts were never concluded: `expectOwner` compared against a NULL `claim_owner`, matching zero rows, and the return was discarded | No test passed `owner`, so the guard stayed on its null short circuit |
| The duplicate branch answered ok for a receipt whose first attempt never finished, losing the lead after a HELD retry | Duplicate was tested at the module level, never through the caller |
| Transport keys were one global namespace, so two suppliers collide and one can pre-claim another's keys | Every duplicate test used a single implicit supplier |
| `DNC_HASH_KEY` was in neither `.env` nor `.env.example`, so deploying as-is returned 503 to every post | Tests set the key themselves |

The lesson worth carrying: the first suite passed because every fixture used
the one field spelling, the one key alias and the one argument shape that
happened to work. Fixtures have to be built from what the caller actually
produces, not from what is convenient to write.

### I3 remaining blocker, do not build the replay worker before fixing it

The correctness reviewer found that `completeReceipt` is called on exactly one
of sixteen exit paths out of `processLead`. Fifteen others return without
concluding the receipt, and three of those return **after** delivery has
already fired: the pre-classified status bypass, the direct and event route,
and `finishNative` on its accepted branch, which books revenue and fires
on_sold deliveries first.

Those receipts sit at `status = received`, `terminal_outcome = NULL`,
`effects_applied = false`, which is precisely the state a replay reads as "not
yet delivered and not yet billed". Nothing consumes the backlog today, because
`claimReceipts` and `pendingReceipts` have no production callers, so this is a
landmine rather than a live breach. It also means invariant 3, that a committed
receipt is replayable after a crash, is currently unimplemented rather than
satisfied.

Fix before writing any replay worker. The shape is a single conclusion helper
driven by a mutable `effectsApplied` flag set at each delivery site, so every
return concludes exactly once with an honest effects flag, including the outer
catch. Reachable on ordinary traffic today are the missing cert and missing
required fields exits, so the backlog grows during normal operation.

Also open from the reviews, recorded rather than fixed:

- Campaign and vertical scoped DNC entries never fire on the supplier path,
  because campaign resolution happens 800 lines after the screen and suppliers
  post no campaign id. Operators can create such entries and they do nothing.
  Restrict the scope in `dncManage`, or screen a second time after resolution.
- The suppression rejection names `DNC_SUPPRESSED` to the poster, which is a
  membership oracle over the list for anyone holding an ingest key, on an
  endpoint with no rate limit. Whether suppliers contractually need the
  specific reason is a business question, so it is recorded rather than
  changed.
- A suppressed lead persists no `Lead` row and discards `capture.audit`, so the
  receipt is the only trace. The I3 plan required persisting the audit.
- `ensureReceiptSchema` runs DDL on the request path rather than at startup,
  taking `ACCESS EXCLUSIVE` on `lead_receipts` inside a transaction on every
  post. Move it to boot.
- `lead_receipts.payload` is a new durable PII sink with no retention policy
  and no entry in `entityPolicy.js`, so any future read surface over it starts
  with no authorization story.

## Next human packet

`docs/LIVE-URL-GATE.md`. It contains only human actions: name the hosting
destination, register or name the domain, and confirm the staging database may
be created. Everything else continues locally.

## Production legal and privacy section, 17 August 2026

Implemented a production legal baseline based on repository and read-only
deployment evidence:

- public Privacy Policy, Terms of Service, Cookie Policy, Privacy Choices, and
  Consumer Health Data Privacy Policy routes in the static marketing site;
- route-specific client metadata, shared legal navigation, accessible section
  structure, theme support, responsive styles, and a corrected site footer;
- account-registration notice at collection and Privacy and Terms links on the
  application login screen;
- `docs/LEGAL-REVIEW.md`, which separates established facts, owner-supplied
  facts, and questions requiring business confirmation or counsel;
- `docs/DPA-DRAFT.md`, retained internally because provider, transfer,
  retention, security-schedule, address, and governing-law details are not yet
  complete; and
- `scripts/verify-marketing-legal.mjs` plus `npm run verify:legal` for route,
  metadata, identity, navigation, theme-token, accessibility-hook, and public
  claim checks.

Evidence before release:

- `npm run verify:legal` passed for all five legal routes.
- `npm run gate` passed tests, function loading, lint, production build, bundle
  purity, secret scan, and added-copy checks.
- `git diff --check` passed.
- Local HTTP checks returned 200 for `/`, all five clean legal routes, and a
  trailing-slash legal route through the existing SPA fallback.
- The in-app browser runtime had no browser instance available, so screenshot
  review of desktop, mobile, light, and dark rendering remains unperformed.
  Theme tokens, breakpoints, focus states, reduced-motion behavior, and
  rendered DOM structure were checked programmatically. Do not restate this as
  completed visual QA.

The public language does not make a categorical sale or sharing claim. Code
shows transfers to configured lead recipients and can associate payment or
other consideration, but contracts, consumer direction, statutory thresholds,
and exemptions are not established. The separate health policy is justified by
actual accident, injury, treatment, insurance, and qualification fields, while
geographic applicability and any required consent or sale authorization remain
for owner and counsel review.

## Session 17 August 2026, later: Google auth, credential namespace, receipt conclusion

### The finding that mattered most

The single lead posted to `https://api.dashflo.io/functions/leads` did not
become a lead. Production evidence, read directly:

```
lead_receipts: 1 row, status=received, terminal_outcome=NULL,
               effects_applied=false, supplier_key_id=a182794eb8ef...
e_lead:        0 rows
e_error_log:   no entry for that post
```

It authenticated, committed a receipt, then returned 200 from one of the
fifteen exits that concluded nothing. This is the blocker the previous session
recorded as "do not build the replay worker before fixing it", now observed in
production rather than predicted.

Fixed by wrapping the response boundary instead of adding a sixteenth
`completeReceipt` call. After the capture succeeds, `ctx` is rebound to a
context whose `json()` concludes the receipt and then answers. Every existing
return goes through it, including the outer catch, and so does any return added
later. `completeReceipt` already guards on `terminal_outcome IS NULL`, so the
wrapper cannot double-conclude.

`effects_applied` is now tracked at the outbound sites. `fireDeliveries` and
`fireConnectors` are local wrappers that set a flag before delegating to the
renamed module-level `dispatchDeliveries` / `dispatchConnectors`, and a
persisted Lead row counts as an effect too. The old code hardcoded `true` on its
single conclusion, which would have told a replay that a refused lead had
already been delivered and billed.

Evidence: `server/test/receiptConclusion.test.js`, 7 tests against a real
disposable PostgreSQL, covering the no-configuration exit, the missing-required-
fields exit, the outer catch, double-conclusion, and the two paths that must
write no receipt at all (dry run, unauthenticated).

### Credential namespace, Legenex to DashFlo

One rule, in `server/src/lib/apiKeys.js`:

```
dshflo_mst_<random>   master and system ingest keys
dshflo_sup_<random>   supplier ingest keys
dshflo_byr_<random>   buyer keys
```

`translateCredentialNamespace` is a pure prefix swap and is deterministic, which
is what makes the Base44 import idempotent: converting the same value twice
produces the same key, the same SHA-256 and the same stored row, so a rerun
compares equal and preserves rather than rotates.

Three browser-side generators were found and removed. They were not only in the
wrong namespace, they were broken: each minted with `Math.random()` and wrote
`ApiKey.key` through the generic entity route, where `WRITE_DENY_FIELDS` strips
it. Every supplier key created that way was displayed to an operator, told to be
copied, and stored with no credential on it. The supplier could never post
successfully and nothing said so. All three now call the server minter.

- `client/src/components/settings/SettingsSuppliers.jsx` migrated
- `client/src/components/campaigns/CampaignSuppliers.jsx` migrated
- `client/src/components/settings/SettingsKeys.jsx` deleted, unreferenced

`server/test/credentialNamespace.test.js` scans executable client and server
source and fails on any `lgnx_` credential literal, so a fourth generator cannot
be added quietly. The `LGNX` supplier SID in `webhook.js`, `backfillLeadType.js`
and `dataBot.js` is business data, not a credential, and is asserted untouched.

### Google authentication

Google Identity Services ID token flow, verified server-side against Google's
JWKS with Node's own `crypto`. No new dependency, so the lockfile and the Docker
build are untouched, and the verifier is fully testable offline.

Chosen over the authorization code flow because login needs identity and
nothing else: no Client Secret, no redirect URI, no token to store. Scopes are
`openid`, `email`, `profile`.

Verified: RS256 pinned from a fixed value rather than read from the header,
`kid` against the live key set, signature, issuer, audience, `azp`, expiry,
`iat`, nonce in constant time, and `email_verified`. The provider identity is
`sub`. A changed Google email is never copied onto the DashFlo account.

Linking is a pure decision function, `server/src/lib/googleAccountLink.js`, so
it is tested exhaustively without a database. Refusals: `NOT_REGISTERED`,
`ACCOUNT_DISABLED`, `INVITATION_CANCELLED`, `IDENTITY_CONFLICT`,
`AMBIGUOUS_ACCOUNT`, `DOMAIN_NOT_ALLOWED`. Open sign-up is off by default and,
when on, can only ever produce `role: user` / `base_role: manager`. There is no
input to that function that yields an owner.

`auth_credentials` gains `google_sub` (UNIQUE where not null), `google_email`,
`google_linked_at` and `disabled`, all additive. `disabled` is honoured by the
password path as well.

46 tests across `googleIdentity.test.js` and `googleAccountLink.test.js`,
including alg-none, HS256-with-the-public-key, wrong audience, wrong `azp`,
tampered payload, foreign signing key, expiry, nonce replay and key rotation.

### API Keys surface

The landing view is now a dashboard of three category cards with counts and
status and no credential material of any kind, served by a new `overview`
operation that returns counts only. System Keys is a list and detail of discrete
platform credentials; the Meta application credential is one card among Google,
Anthropic, OpenAI and Stripe rather than a permanently expanded form at the top
of the page. `MetaAppCredentialsCard.jsx` deleted, superseded.

### Distribution, measured not assumed

The native engine exists and is substantial: waterfall routing, priority,
weighted, round robin, auction and hybrid selection, caps, reservations,
wallets, billing, ping/post, direct post, delivery attempts, a retry worker,
destination health and route decision traces.

It is not selling anything. Production has no `AppSettings` row at all, so
`distribution_mode` falls through to `legacy_only`, which routes everything to
LeadByte and runs none of the new code. Moving off `legacy_only` is a human gate,
not a code change.

### UNPROVEN

- The authenticated supplier posting path has not been exercised against
  production since the fix. The one production key is hash-only, so its
  cleartext does not exist and a controlled test needs a key issued first.
- No lead has ever been delivered to a buyer by this deployment.
- Google sign-in has no Client ID configured yet, so the button does not render
  in production and the flow is proven by tests only.

## Marketing site UX, performance, contact, and app code splitting, 17 August 2026

Website and application work only. No lead path, routing rule, supplier or
buyer key, Base44 surface, migration import, or production record was touched.

### Hero diagram

The compiled bundle shipped a separate mobile treatment that stacked sources,
DashFlo, and buyers vertically, hid the connector SVG, and grew the scene past
1000px tall on a 390px viewport. That is a different diagram, not a smaller
one.

`marketing/dist/assets/hero.css` restores the single canonical composition at
every width. The connector SVG is `viewBox="0 0 1000 420"` with
`preserveAspectRatio="none"` at 100% by 100%, so it stretches to the scene box
and its path anchors sit on fixed fractions of it. Node stacks are placed on
those same fractions, so every line stays attached with one set of geometry.
Anchor values are recorded in the file.

Measured in Chrome, scene height by viewport width:

| Width | Before | After |
| --- | --- | --- |
| 1440 | 470 | 470 (unchanged) |
| 768 | stacked | 440 |
| 430 | stacked | 353 |
| 390 | 1002 | 328 |
| 360 | stacked | 302 |

No horizontal overflow at 1440, 1024, 768, 430, 390, or 360. Connector paths
render at every width. Secondary labels and the processor row are dropped below
600px rather than shrunk past legibility.

### Call to action

`Request Access` was not in the approved bundle. `site-router.js` was rewriting
the bundle's own `/register` links into a mailto. That rewrite is removed.

Logged out: Start Free Trial to `app.dashflo.io/register` and Login to
`app.dashflo.io/login`. Logged in: one Go To Dashboard to `app.dashflo.io`,
with registration and login links removed. Both states verified in Chrome
against a stubbed session endpoint.

Session awareness is `GET /api/auth/session-status` in
`server/src/routes/publicSite.js`, returning `{"authenticated":boolean}` and
nothing else. The application session cookie stays host-only, HttpOnly, and
unreadable by the marketing site; no token crosses the boundary and nothing is
moved to localStorage. dashflo.io and app.dashflo.io share a registrable
domain, so the request is same-site and the SameSite=Lax cookie is sent while
CORS still applies. `MARKETING_ORIGIN` is deliberately not added to
`ALLOWED_ORIGINS`, because that list also grants CSRF standing for
cookie-authenticated writes. Every failure path resolves to logged out.

### Marketing performance

Measured on the live site with Chrome before the change: 1654 KB transferred,
14 requests, FCP 2388ms and LCP 3288ms at 1440, FCP 2164ms and LCP 3048ms at
390.

Causes found:

- no compression at all, so roughly 460 KB of text was served raw;
- 1254px PNGs used as favicons, 385 KB each, fetched three times;
- the webfont CSS pulled in by an `@import` inside the 160 KB stylesheet, so
  it could not start until that file had downloaded and parsed;
- unfingerprinted assets served `immutable` for a year.

Changes: gzip in `deploy/nginx/dashflo.io.conf` (text types only; brotli needs
a non-stock module and is left as a follow-up); resized icons, with the 1254px
originals kept in `marketing/brand-src/` and out of the deployed tree; the
webfont stylesheet named in the head with preconnect so the identical URL
starts during HTML parse; offscreen hero animation pausing through
IntersectionObserver and `pauseAnimations`, plus `prefers-reduced-motion`.

Transferred bytes, gzip level 6 as configured: 1590 KB to 133 KB, a 91.6%
reduction. Google Fonts adds about 67 KB in both cases.

UNPROVEN: FCP, LCP, and CLS after the change. They depend on nginx compression
and cannot be measured until this is deployed. Only byte counts are proven.

### Caching correctness

`site-router.js`, `brand.css`, `legal.css`, and `hero.css` keep stable
filenames but were served `public, immutable` for one year. A returning visitor
would have kept the old router and never received this or any future deploy.
Fingerprinted bundle assets keep the one-year immutable policy through a regex
location; the hand-authored files now revalidate.

### Contact page and SMTP

`/contact` renders through the same shell, header, footer, tokens, and theme
system as the legal routes. Fields: name, email, company (optional), topic,
subject, message. Accessible labels, `aria-live` status, client and server
validation, loading, success, and failure states, both themes, no horizontal
overflow at 390.

`POST /api/contact` is rate limited to 5 per hour per address, carries a
honeypot and a fill-time check (both accepted and discarded so a bot learns
nothing), validates and length-bounds every field, and strips control
characters so no header can be forged. The recipient is fixed server-side from
`CONTACT_RECIPIENT`, so the endpoint cannot be used as a relay. From is the
SMTP-authorised sender; Reply-To is the visitor. Message content is never
written to the application log; only topic and delivery outcome are.

17 tests in `server/test/contactForm.test.js` cover validation, length bounds,
header injection, recipient fixing, and sender identity.

UNPROVEN: real SMTP delivery. No credentials are configured, so the endpoint
answers 503 rather than reporting success. Required values are listed in
`server/.env.example`: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`,
`SMTP_PASS`, `SMTP_FROM`, `SMTP_FROM_NAME`.

### Footer and legal contact

The public footer is branded DashFlo, shows `support@dashflo.io`, and adds
Contact / Support. The operating company name is removed from it. Legal
documents still identify `Next Consulting LLC dba DashFlo`, and their contact
address moved from `info@next-consulting.co` to `info@dashflo.io`.
`scripts/verify-marketing-legal.mjs` now enforces all of this, plus the contact
route, its accessible labelling, and the call-to-action routing.

### Application performance

The route table imported all 57 pages statically, and `docsConfig` imported 11
more, producing one 3595 KB chunk (932 KB gzipped) that had to arrive before
the login form could paint.

Route-level `React.lazy` with one Suspense boundary above every branch in
`App.jsx`, a second in `OffscreenCapture.jsx` for its detached root, lazy docs
registry, and vendor chunking in `vite.config.js`. Login and Register stay
eager because they are the marketing site's landing points.

`clsx`, `tailwind-merge`, and `class-variance-authority` are pinned to the
always-needed chunk. Left unassigned, Rollup hoisted them into the charts
chunk, which made the entry statically depend on it and preloaded 110 KB of
recharts on the login screen.

Initial load, gzip: 952 KB to 161 KB, an 83% reduction, across 297 chunks.
Verified in Chrome against the built output: the login page fetches three
scripts and renders, `/docs` lazily fetches ten more and renders, no console
errors.

UNPROVEN: authenticated dashboard timings, startup API waterfalls, and query
latency. Those need a populated database and a real session.

### Instrumentation

Slow request logging in `server/src/index.js` and slow query logging in
`server/src/db/pool.js`, both threshold driven, logging route or truncated
statement text and duration only, never parameters, bodies, or caller
identity. Web Vitals on the marketing site are collected from the browser's own
performance entries, left on `window.__dashfloVitals`, and sent nowhere. No
analytics vendor, pixel, cookie, or identifier was added.

### Evidence

- `npm run gate` passed: tests, function loader, lint, production build, bundle
  purity, secret scan, added-copy check.
- `npm run verify:legal` passed for five legal routes and the contact route.
- `git diff --check` passed.
- No SMTP credential appears in any tracked file or built bundle.
- Hero geometry, both call-to-action states, contact form validation and
  submission, theme switching, and the built application boot were exercised in
  Chrome.

### Not done

- Not deployed. No SSH access to `2.24.130.44` from this session; all four
  local keys were refused. Everything above is proven locally only.
- Compression, cache headers, and the live call to action cannot be confirmed
  until `nginx -t` and a reload have run on the VPS.
- No production contact message has been delivered.

## Progress host canonical URL and Google origin, 18 August 2026

Base: `a49003d82e82c8e61d8a596268b7a965b0367b4d`, deployed and healthy. Two
browser acceptance defects on the new Progress host, fixed here. No other work.

### The blank page

`https://progress.dashflo.io/` rendered the page background and nothing else,
with the address bar showing `/progress`.

Cause: `AuthenticatedApp` guarded the progress host by reading
`window.location.pathname` and returning `<Navigate to="/progress" replace />`
INSTEAD of the route table when the path was not on the allowlist. `/` was not
on that allowlist. The redirect updated history, but the component that returned
it holds no location and therefore never re-rendered, so the tree stayed a bare
`<Navigate>` that draws nothing. The address bar moved and the page never did.
Serving a static shell would not have helped: the failure was entirely in
client-side route resolution.

Fix: the Control Center is now addressed at the root of its own host, and every
redirect on that host is a route inside `<Routes>` rather than a value returned
in front of it.

- `progress.dashflo.io/` renders the Command Center.
- `/review`, `/findings`, `/changes`, `/prompts`, `/activity`, `/migration`,
  `/gates`, `/settings` render the other eight surfaces.
- `/login`, `/forgot-password`, `/reset-password` render the auth pages.
- `/progress` redirects to `/`, and `/progress/<surface>` redirects to
  `/<surface>`. Anything the host does not serve lands on `/`.
- `app.dashflo.io/progress` as owner redirects to `https://progress.dashflo.io/`,
  and `/progress/findings` to `https://progress.dashflo.io/findings`.
- Non-owners on the application host still get the ordinary not-found page. The
  `/progress` entries were removed from `PATH_KEYS` so a permission key cannot
  answer first with a redirect to the user's own dashboard.
- `/progress` remains absent from the operator sidebar.

`PROGRESS_SURFACE_PATHS` in `client/src/lib/hostScope.js` is the single list the
route table, the Control Center navigation and the host allowlist all read. The
progress route table moved to `client/src/ProgressHostRoutes.jsx`: it is mounted
on a different host from the operator table and shares nothing with it.

`/` and `/settings` are spelled the same as an operator path and are not the
same surface. `App.jsx` selects one route table per host before any matching
happens, so the table that owns Overview and operator Settings is never mounted
on the progress host.

### Google sign-in on the Progress host

Production showed `Error 400: origin_mismatch`. That is a Google Cloud console
state, not a code defect: `https://progress.dashflo.io` is not yet an Authorized
JavaScript origin on the existing Web Client.

No change was made to the authentication implementation. The existing Google
Identity Services ID-token flow is untouched and is already same-origin on this
host: the browser reads `/api/auth/google/config` and posts the ID token to
`/api/auth/google` on whatever host served it, `config.progressOrigin` already
gives that origin CORS and CSRF standing, and the session cookie stays host-only.
What this commit changes for sign-in is where it lands: the post-login
`window.location.href = '/'` used to reach the blank page and now reaches the
Command Center.

Human action required: add `https://progress.dashflo.io` as an Authorized
JavaScript origin. It is an origin, so no `/progress` path belongs in it.

### Security posture, unchanged

Owner only via `base_role`, server-side authorization still mandatory, Progress
entities and functions still owner only, no `.dashflo.io` shared cookie, host
sessions independent, no token transfer between hosts, CSRF and CORS untouched,
`X-Robots-Tag: noindex, nofollow, noarchive` still on the progress server block
with the robots meta tag as the second copy.

### Evidence

- `npm run gate` PASS, seven steps, 84 test files, 1101 tests, none skipped.
- New `client/src/lib/progressHostRouting.test.jsx`, 22 tests: route resolution
  against the real progress table, both redirect directions, the owner gate, the
  non-owner not-found, and the anonymous login decision.
- `client/src/lib/hostScope.test.js` and `progressSeparation.test.js` extended
  for the canonical root, the retired namespace, and a closed allowlist.
- `server/test/progressAccess.test.js` extended for the unauthenticated Google
  token exchange posted from the progress origin.
- No Base44 migration or sync data touched.

### Rollback

`git revert` this commit and redeploy. It is client routing plus one client
permission map entry and three test files; no schema, no data, no server
behaviour change. The previous commit `a49003d` is the known state, blank root
page included.

### Not done

- Not deployed. The VPS deployment command block is handed to the operator; no
  SSH was attempted from this session.
- The Google Authorized JavaScript origin is a manual console change and is
  UNPROVEN until it is made. Until then Google sign-in on the progress host
  still returns `origin_mismatch`; the password form is unaffected.

## Migration preview visibility and Capture for review removal, 18 August 2026

Base: `7522b11c344238baf6166b8261e58b5630c20fc4`, on top of the deployed
`a49003d`. Two production acceptance defects, fixed here. No other work.

### The migration preview that did nothing

The owner selected a valid encrypted package, entered the passphrase, pressed
Decrypt and preview owner migration, watched a spinner, and then watched the
button return to normal. No preview, no success, no error, no explanation.

Cause: the panel reported every outcome through `toast` from sonner, and
sonner's `<Toaster />` was never rendered anywhere in the application. Sonner's
`toast()` posts to an observer; with nothing subscribed the message is dropped
and the call returns normally. `App.jsx` mounted only the Radix toaster from
`components/ui/toaster.jsx`, which is a different store with four users, while
119 modules report through sonner. So `toast.error(...)` in the catch was a
no-op, `setImportBusy('')` ran in the `finally`, the spinner stopped, and the
panel had nothing else to show. The request had failed and the failure was
discarded in the browser.

The backend was not at fault. The route, the multipart handling, the field
order the browser sends, PBKDF2, chunk decryption, digest verification and the
analysis were all exercised over real HTTP against a disposable database and
answer correctly: 200 with a full preview, 400 with a safe message for a wrong
passphrase, and 400 for a malformed package.

Fixed in four parts:

- `App.jsx` mounts the sonner toaster. `components/ui/sonner.jsx` now reads the
  theme from `lib/theme`, the application's own manager, rather than from
  next-themes, which was never mounted either and always reported "system".
- The panel keeps an explicit status of its own and no longer depends on a
  toast being visible. Busy, success, blocked, refused, timed out and
  unreachable all render a persistent band with `role="alert"` or
  `role="status"`. A new attempt clears the previous outcome, so a stale preview
  cannot be read as the result of the current run.
- `lib/migrationImportStatus.js` maps any thrown value to a safe state. It reads
  only the server's own safe message, keeps the first line, and bounds it to 300
  characters, so a stack trace or an echoed payload cannot reach the screen. A
  decryption failure gets fixed copy that names the passphrase and the file and
  says which of the two was wrong for neither.
- `api/client.js` takes an opt-in `timeoutMs` and `systemImport` passes 360
  seconds, above the 300 second nginx read timeout. An aborted request is
  reported as a timeout and an unreachable server as a network failure, rather
  than as silence.

Server side, the route now emits one structured line per attempt and per
ending, and `MigrationValidationError` carries a stable code that the browser
branches on: `decrypt_failed`, `validation_failed`, `bad_upload`,
`unauthorized`, `not_confirmed`, `too_large`, `internal`. The log records mode,
kind, byte count, duration, run id, outcome and code. It never records the
passphrase, a decrypted value, a record field, a credential or a stack.

The encrypted owner migration architecture is unchanged. Same package format,
same PBKDF2 and AES-GCM parameters, same per-chunk digest, same owner-only
route, same server-side decryption in memory. The passphrase is still
request-only. Preview still writes zero business records, and apply still
requires a fresh explicit confirmation.

### Capture for review

The floating pill at the bottom of every operator page is gone.
`components/progress/CaptureController.jsx` is deleted, `AppLayout` no longer
mounts it, and the sessionStorage capture queue and the `progress_capture`
navigation protocol went with it. `capturePage` in `lib/progress/capture.js`
had no other caller and is removed.

What the Control Center depends on is kept: `capturePageElement` for the
offscreen capturer, `cropAndUpload` for anchored comments, and the masking
preference, which moved to `lib/progress/captureMask.js` because it is a stored
user preference rather than something the removed control owned. It still
defaults to masked when storage is unavailable.

### Included from the working tree, not written for this task

The tree already carried unreleased migration hardening that this commit could
not separate from: `migrationImport.js` imports `MIGRATED_INVITATION_FIELD`
from `googleAccountLink.js`, so committing the error codes without it would
have left main with a broken import. It is included and called out rather than
landed quietly:

- An Invitation carried in from Base44 is stamped `migrated_history` and can no
  longer authorize a Google sign-in. Without it, any Google account whose
  verified address matched an old Base44 row could create a DashFlo account
  carrying whatever role that row named, up to owner.
- `User.email` natural keys are compared case-insensitively, and duplicates
  inside one bundle are reported, so a capitalised address cannot become a
  second account for somebody who already has one.
- `authMigrationGate.test.js` and `authAuthorizationMatrix.test.js` cover both
  against a real disposable database.

### Evidence

- Focused: `migrationPreviewRoute.test.js` 15 passed, `migrationImportStatus`
  28 passed, `captureControlRemoval` and `toastSurface` 19 passed.
- `npm run gate` PASS, seven steps, 88 test files, 1163 tests, none skipped.
  Was 84 files and 1101 tests at `7522b11`.
- The preview was exercised over real HTTP against a disposable local database:
  valid package 200, wrong passphrase 400 `decrypt_failed`, malformed package
  400 `bad_upload`, database failure 500 `internal` with a generic message and a
  log line. Business record counts across every entity table were unchanged by
  preview.
- No Base44 source data was read or altered. No production record was imported.

### Rollback

`git revert` this commit and redeploy. It is client presentation, one client
request option, migration error codes and route logging; no schema change, no
migration behaviour change beyond the invitation marker noted above, and no
data movement. Reverting restores the silent panel, so prefer forward fixes.

### Not done

- Not deployed. The VPS command block is handed to the operator; no SSH was
  attempted from this session.
- Which specific failure the production package hit on 18 August is still
  UNPROVEN. The request failed and the browser discarded the reason. The next
  attempt will name it on screen and leave a `[migration]` line in the
  application log.

## Automatic production deployment from main, 18 August 2026

`.github/workflows/deploy-production.yml` is the first automated path to
production. Every push to main runs the repository gate, and only a passing
gate is allowed to deploy. `workflow_dispatch` runs the same thing by hand.

### What the workflow does and does not do

The gate job is `npm run gate`, unchanged, with a disposable PostgreSQL 16
service on 5433, the port the database suites already look for. Without it the
receipt, intake, migration and auth suites skip themselves and a green CI run
would be weaker evidence than a local one.

The deploy job runs under the `production` environment, in concurrency group
`production-deploy` with `cancel-in-progress: false`, so a running deployment
is never killed midway and a later push waits its turn. It is skipped unless
the ref is main. There is no third-party SSH action: the key is written to a
mode 600 file under `RUNNER_TEMP`, the host key comes from `ssh-keyscan`, and
`StrictHostKeyChecking` stays on.

On the host the sequence is fetch, checkout main, `pull --ff-only`, verify
`git rev-parse HEAD` equals the SHA GitHub is deploying, `docker compose build
app`, `docker compose up -d --no-deps app`, wait for container health, verify
`http://127.0.0.1:4000/api/health`, then the two restricted helper commands,
then `docker compose ps`, then the five public surfaces. The public surfaces
are checked again from the runner afterwards, which is the only evidence that
they are reachable from outside the VPS.

`server/.env` is never written. It is required to exist before anything is
touched and its digest is compared before and after, so a deployment that
disturbed it fails instead of passing quietly. The digest itself is not
printed. No secret is copied from GitHub to the host. Nothing recreates
PostgreSQL, removes a volume, issues a certificate, imports Base44 data, runs
an owner migration, or edits nginx outside the installed helper.

Two guards exist because the failure they prevent is silent. An unset compose
variable does not stop compose, it substitutes an empty string and would
restart the application with a blank database password, so `docker compose
config` is inspected for that warning before the running container is touched;
only stderr is read, so no resolved value is printed. And the remote script
arrives on stdin, so `GIT_TERMINAL_PROMPT=0` stops a credential prompt from
consuming the rest of the script.

### Evidence

- YAML parses, and every `run:` block plus the generated remote script passes
  `bash -n`.
- The remote script was rehearsed against stubs for docker, sudo and curl with
  a real local git remote: 31 assertions, all passing. The happy path proves
  build, `--no-deps` restart, both helper commands, all five surface checks, no
  `compose down` and no volume work, and an untouched `server/.env`. Nine
  failure modes each stop at the right place: SHA mismatch and missing
  `server/.env` stop before the build, an unset compose variable stops before
  the build and names the variable, a build failure and a helper failure abort,
  an unhealthy container stops before any root helper runs, a 502 on a public
  surface fails, and a rewritten `server/.env` fails.
- The URL check helper was exercised against a loopback mock: 7 cases covering
  the exact `res.json` health body, a reformatted one, a followed redirect, a
  wrong body, a 502 and a refused connection.
- The runner steps were exercised directly: 11 cases covering each missing
  input, an unscannable host, a mode 600 key file, no key material in the
  output, a secret that is not a key, and a passphrase protected key, which is
  refused rather than left to hang.
- `npm run gate` PASS at this commit, seven steps, 88 test files, 1163 tests,
  none skipped.
- No live endpoint was contacted from this session. Every rehearsal used
  loopback or stubs.

### Rollback

Delete `.github/workflows/deploy-production.yml` and push, or disable the
workflow in the Actions tab. Deployment returns to the manual VPS command
block. The workflow changes no application code and no host configuration, so
nothing else has to be undone. A bad deployment is rolled back the same way it
always was, by returning the host to the previous commit and rebuilding.

### Not done

- Whether the `production` environment carries a required reviewer is UNPROVEN
  until the first run. If it does, the deploy job waits for approval rather
  than failing.
- The workflow assumes git, docker, curl and sha256sum exist on the host. It
  checks for them and stops before mutating anything, but the check has not
  been observed against the real VPS.

## First successful automatic production deployment, 18 August 2026

Production is now deployed by GitHub Actions from `main`. This is the first time
a push to `main` reached the VPS without a manual SSH session.

Run: https://github.com/legenex/legenex-dashflo/actions/runs/32141125172

- Event: push of `117a3f1fa6e274e5fdd830d458641b1de0f76a1c`
- Gate job: success
- Deploy to production job: success
- Production reached commit `117a3f1`

### What the deployment covered

The preceding run for `c78dcc1` failed, so nothing had ever been shipped by the
pipeline. The successful run was therefore a catch-up that carried the whole
backlog to production in one release, including `7522b11`, which serves the
Progress Control Center at the root of its own host, and `cdcf5d5`, which makes
every migration import outcome visible and removes Capture for review. Both had
been recorded as built and gated but not deployed.

### The earlier failure and its resolution

Run 32134961972, at `c78dcc1`, passed its gate and failed in the deploy job. The
first failing step was "Write the deployment key and the host key", and the rest
of the job failed behind it.

The cause was the key material held in the `production` environment secret
`DEPLOY_SSH_KEY`. It was replaced with a dedicated unencrypted GitHub Actions
deploy key for the deployment user, which is what the workflow expects: it
refuses a passphrase protected key rather than hanging on a prompt. No key
material, passphrase or credential value is recorded here, and none was printed
by the workflow.

### Restricted helper

The VPS restricted sudo deployment helper `/usr/local/sbin/dashflo-deploy-root`
is working. The successful "Deploy on the VPS" step runs it for `marketing` and
then for `nginx`, and that step completed successfully. Nginx is validated by
the helper before any reload, and no certificate was reissued.

### Standing position

Ordinary releases now deploy automatically from `main` after a green gate, and
that path is pre-authorized. Money writes, live delivery activation, production
data mutation, credential changes, destructive schema changes, and cutover or
rollback still require explicit human approval. Do not SSH into the VPS for an
ordinary release.

### Evidence

- GitHub Actions run 32141125172: both jobs success, head SHA
  `117a3f1fa6e274e5fdd830d458641b1de0f76a1c`, completed 18 August 2026.
- Gate job step "Run the repository gate" succeeded, so the seven step gate
  passed in CI against the PostgreSQL service container.
- Deploy job steps all succeeded, including "Deploy on the VPS" and "Verify the
  public surfaces from GitHub".
- The five public hosts were checked again from this session after the
  deployment: `https://dashflo.io`, `https://app.dashflo.io`,
  `https://api.dashflo.io/api/health`, `https://docs.dashflo.io` and
  `https://progress.dashflo.io` all returned 200, and the health body was
  `{"status":"ok"}`.
- No SSH session was opened and no manual deployment command was run.

### Rollback

Deployment rollback is unchanged: return `main` to the previous commit and let
the pipeline redeploy, or disable the workflow in the Actions tab and fall back
to the manual VPS command block.

## AGENTS.md becomes the canonical agent contract, 18 August 2026

`AGENTS.md` is now the canonical model-neutral DashFlo operating contract for
every coding agent, model and harness, including Claude Code, Codex, Kimi,
Nemotron, GLM, DeepSeek and other VS Code agents.

`CLAUDE.md` was reduced from a full duplicate of the operating contract to a
short Claude Code entrypoint. It requires `AGENTS.md` to be read first, keeps
only Claude specific guidance, and states that `AGENTS.md` wins if duplicated
guidance ever conflicts. This is what stops the two files from drifting into two
independent versions of the same rules.

The project-specific material that used to live only in `CLAUDE.md` moved into
`AGENTS.md` intact: the product and stack description, the repository and
environment facts, the fourteen non-negotiable invariants, the gate and database
test detail, what the deployment workflow does on the host, the verified
repository facts, parallel work and integrator-only surfaces, and the definition
of done. Three stale instructions were corrected rather than carried forward:
`.claude/hooks/task-gate.sh` is not the gate and `.claude/` does not exist,
ordinary work is no longer required to sit on a cutover branch, and ordinary
application releases no longer sit behind a manual deployment gate.

### Evidence

Documentation only. `AGENTS.md`, `CLAUDE.md` and this file are the only changed
paths. No application source, test, nginx, Docker, migration, auth, workflow,
package or production configuration file was touched.

### Rollback

`git revert` the commit. Nothing executable depends on either file.

## Authentication and autonomous release state, 18 August 2026

GitHub CLI authentication was refreshed successfully and the push path is
working, so routine agent work no longer needs a manual push or a manual
deployment.

- The active GitHub account is `legenex`.
- The token carries `repo` and `workflow` scope, so a commit that touches
  `.github/workflows/` can be pushed normally.
- The earlier blocker, where a workflow-file push was refused because the token
  lacked `workflow` scope, is resolved.
- `git push origin main` succeeds.
- Routine agents commit and push their own completed work.
- Routine pushes to `main` continue through GitHub Actions to production.
- Manual pushes and manual VPS deployment are not part of the ordinary workflow.

### Git transport, measured rather than assumed

The transport is worth recording precisely, because the two tools describe it
differently and an agent debugging a failed push will otherwise look in the
wrong place.

- `origin` is `https://github.com/legenex/legenex-dashflo.git`, an HTTPS remote.
- Pushes authenticate through the GitHub CLI credential helper installed for
  `https://github.com` in the global git configuration, alongside `osxkeychain`.
- `gh auth status` reports "Git operations protocol: ssh" as a per-host
  preference, while `gh config get git_protocol` reports `https`. Neither
  changes the fact that the working push path is the HTTPS `origin` above.

`AGENTS.md` records the HTTPS origin and the credential helper rather than
describing the transport as SSH, so a future agent does not go hunting for an
SSH key that is not what authenticates the push.

No token value, key material, passphrase or one-time authentication code is
recorded here, and none was printed into the repository.

### Instruction files

`AGENTS.md` gained a Default autonomous release behavior section placed with the
workflow sections, and the remaining rules were integrated into the sections
that already owned them: commit and push authorization and git transport under
Git workflow, run monitoring and the failure loop and the documentation-only
note under Automatic production deployment, per-surface guidance under
Production verification, the expanded stop list under Human approval gates,
commit hygiene under Parallel work and concurrency, current-harness capability
assessment under Model and harness neutrality, and the extra fields under Final
response format.

An earlier draft of this change had appended the same rules as one disconnected
block ahead of the numbered contract, which duplicated Production verification,
Human approval gates, concurrency and harness neutrality. The duplicates are
removed. Sections 4 through 28 shifted by one to 5 through 29, cross references
now name sections instead of numbering them, and `CLAUDE.md` was updated to
match.

### Evidence

Documentation only. `AGENTS.md`, `CLAUDE.md` and this file are the only changed
paths. No application source, test, nginx, Docker, migration, auth, workflow,
package or production configuration file was touched. The deployment workflow
was read to confirm the trigger and the host sequence, and was not modified.

### Rollback

`git revert` the commit. Nothing executable depends on any of these files.
