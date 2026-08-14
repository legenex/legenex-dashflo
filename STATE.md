# DashFlo autonomous build state

Update this file after every completed or blocked task. It is the persistent handoff between sessions and agents.

## Current control state

- Audited base: `a63144cb0e1a2c000e873e94e5091565f6bbb1c6`
- Current base: `84ab0303f93e8704ac01d3c173c155f6452a3a97`
- Working branch: `claude/dashflo-production-cutover-e1tgel`
- Auto-sync status: no writer inside this checkout. See delta audit below.
- Current phase: Phase 0 complete, Phase 1 next
- Active human gate: None
- Last green commit: `c247649`
- Last full gate: PASS at `c247649` on 14 August 2026

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
| S1 Auth fail-closed | Ready | | | | | |
| S2 Entity authorization | Ready | | | | | |
| S3 Function authorization | Ready | | | | | |
| S4 Secret storage | Ready | | | | | |
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

## Next human packet

None yet. Build it only when a human gate is genuinely reached.
