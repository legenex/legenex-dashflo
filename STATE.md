# DashFlo autonomous build state

Update this file after every completed or blocked task. It is the persistent handoff between sessions and agents.

## Current control state

- Audited base: `a63144cb0e1a2c000e873e94e5091565f6bbb1c6`
- Current base: `84ab0303f93e8704ac01d3c173c155f6452a3a97`
- Working branch: `claude/dashflo-production-cutover-e1tgel`
- Auto-sync status: PAUSED at source. Both launchd writers booted out and
  persistently disabled on the operator workstation, 15 August 2026. See
  "Gate A resolution" below for the verification evidence.
- Current phase: Phase 1 complete, Phase 2 in progress
- Active human gate: Gate A approved and closed. Gate B pending.
- Last green commit: `00eeab1`
- Last full gate: PASS at `00eeab1` on 15 August 2026

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
a run was due at 05:57Z. At 05:56Z the jobs were booted out. The last line
of `sync/state/sync.log` remains `2026-08-15T04:57:24.772Z no changes (at
194f0e17)` and the file mtime remains 06:57:24 local. No run occurred after
the pause. This should be re-checked before any merge to confirm the log
has still not advanced.

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
| S4 Secret storage | In progress | Lead | cutover branch | `pending` | Hash path proven by 42 tests; cleartext retained on purpose | Cleartext purge is deliberately deferred until real traffic is observed on the hash path |
| I1 Durable receipt module | Blocked | | | | | |
| I2 Global DNC module | Blocked | | | | | |
| I3 Pipeline integration | Blocked | Lead | | | | |
| R1 Buyer identity normalization | Blocked by F1 | | | | | |
| R2 Routing and caps | Blocked | | | | | |
| R3 Delivery and parsing | Blocked | | | | | |
| M1 Billing and returns | Blocked | | | | | |
| P1 Portal isolation | Blocked | | | | | |
| C1 Configuration recovery | Blocked by F0 | | | | | |
| D1 History import | Blocked | | | | | |
| O1 Shadow comparison | Blocked | | | | | |
| O2 Reliability | Blocked | | | | | |
| O3 Cutover runbook | Blocked | Lead | | | | |

Use only these statuses: Ready, In progress, Review, Blocked, Done.

## Accepted architecture decisions

| ADR | Decision | Date | Commit |
|---|---|---|---|
| | | | |

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

## Next human packet

None yet. Build it only when a human gate is genuinely reached.
