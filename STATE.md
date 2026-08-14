# DashFlo autonomous build state

Update this file after every completed or blocked task. It is the persistent handoff between sessions and agents.

## Current control state

- Audited base: `a63144cb0e1a2c000e873e94e5091565f6bbb1c6`
- Current base: UNSET
- Working branch: UNSET
- Auto-sync status: UNPROVEN
- Current phase: Phase 0
- Active human gate: None
- Last green commit: None
- Last full gate: Not run from installed pack

## Verified baseline from 15 August 2026

- Test files: 47
- Tests: 464 passed, 1 failed, 465 total
- Failed suites: 4
- Obsolete path suites: `shadowInert`, `parity`, `supplierPortalProjection`
- Genuine failed assertion: long opaque token masking
- Client build: passed with warnings
- Client lint: failed with 36 errors
- Backend function loader: 94 loaded, 3 invalid handler modules
- Server dependency advisories: 3 total, 2 high
- Client dependency advisories: 7 total, 2 high and 5 moderate

Re-run all values before relying on them.

## Task board

| Task | Status | Owner | Branch or worktree | Commit | Evidence | Blocker |
|---|---|---|---|---|---|---|
| F0 Freeze and branch | Ready | Lead | | | | |
| F1 Truthful harness | Blocked by F0 | | | | | |
| F2 Dependency baseline | Blocked by F0 | | | | | |
| S1 Auth fail-closed | Blocked by F1 | | | | | |
| S2 Entity authorization | Blocked by F1 | | | | | |
| S3 Function authorization | Blocked by F1 | | | | | |
| S4 Secret storage | Blocked by F2 | | | | | |
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

## Corrections to historical assumptions

- Enrichment network calls occur after the first `Lead` create in the audited `processLead.js`; the smaller pre-create durability window remains.
- Self-hosted `Repo.list()` returns an array, including for an empty result.
- `Lead.buyer_id` is overloaded and must be normalized additively.
- Durable receipt capture occurs before business validation; DNC is first among business validations.

## Next human packet

None yet. Build it only when a human gate is genuinely reached.
