# DashFlo execution plan

This plan is dependency-led. Calendar labels are targets, not permission to skip a gate.

## Task graph

| Task | Depends on | Primary owner | Acceptance |
|---|---|---|---|
| F0 Freeze and branch | None | Lead | Auto-sync risk recorded, isolated branch clean |
| F1 Truthful harness | F0 | Test agent | 47 files collect, all tests pass, root gate repeatable |
| F2 Dependency baseline | F0 | Security agent | Advisories classified, high severity production risks resolved or isolated |
| S1 Auth fail-closed | F1 | Backend agent | Registration, cookies, CSRF, rate limits, startup secret tests pass |
| S2 Entity authorization | F1 | Backend agent | Default deny and role plus row matrix pass |
| S3 Function authorization | F1 | Backend agent | Auth default and explicit public allowlist pass |
| S4 Secret storage | F2 | Security agent | ADR, key hashing, credential protection, rotation list |
| I1 Durable receipt module | F1, S1 | Backend agent | Commit, lease, replay, idempotency, crash tests pass |
| I2 Global DNC module | F1, S2 | Backend agent | Matching, scope, audit, UI and import tests pass |
| I3 Pipeline integration | I1, I2, S3, S4 | Lead integrator | All real callers covered, dry runs inert, under-five-second contract measured |
| R1 Buyer identity normalization | F1 | Data agent | Additive fields, resolver, backfill and exception report |
| R2 Routing and caps | I3, R1 | Backend agent | Fixture matrix and concurrency tests pass |
| R3 Delivery and response parsing | I3, S4 | Backend agent | Destination fixtures, timeout, retry and immutable attempt tests pass |
| M1 Billing and returns | R1, R3 | Backend agent | Idempotent ledgers, term and adjustment tests pass |
| P1 Portal isolation | R1, S2 | Full-stack agent | Buyer and supplier projection matrices pass |
| C1 Configuration recovery | F0 | Data agent | Recovered config plus unresolved-exception artifact |
| D1 History import | F1, R1 | Data agent | Restartable import and reconciliation report |
| O1 Shadow comparison | R2, R3, C1 | Backend agent | Inert shadow and discrepancy taxonomy pass |
| O2 Reliability | I3 | Operations agent | Backup restore, health, alerts, restart and load evidence |
| O3 Cutover runbook | O1, O2, M1, P1, D1 | Lead | Per-supplier manifest, kill switch, rollback tested |

## Integrator rule

I1 and I2 may be developed in parallel in separate modules and worktrees. I3 is a serial integration task owned by the lead. No parallel agent edits `processLead.js`.

Package files, lockfiles, shared schemas, migrations, generated bundles, and distribution mode controls follow the same single-integrator rule.

## Two-week target shape

### Days 1 and 2

- F0, F1, F2
- S1, S2, S3 design and tests
- Start C1 discovery immediately

### Days 3 to 5

- Complete S1 through S4
- Build I1 and I2 in isolated worktrees
- Present Gate B only for unresolved secret references, source contracts, and genuine configuration ambiguities

### Days 5 to 8

- I3 serial integration
- R1, R2, R3
- C1 import validation
- Begin D1

### Days 8 to 10

- M1 and P1
- O1 shadow tooling
- O2 reliability and restore drill
- Finish D1 reconciliation

### Days 10 to 12

- Shadow run using approved safe environment and config
- Investigate every material discrepancy
- Load, restart, timeout, replay, portal, and ledger evidence

### Days 12 to 14

- Present Gate C
- Cut over one low-risk supplier if approved
- Hold and compare
- Continue supplier by supplier only when success criteria remain green
- Present Gate D after stabilization

## Scope protection

The following do not enter the cutover critical path unless they directly block a configured live flow:

- full dynamic report builder;
- general SaaS tenant provisioning;
- authenticator-app 2FA;
- call routing;
- advanced aged-lead resale;
- second application server;
- broad visual redesign.

Create backlog tasks and architecture seams for them. Do not pretend they are complete.

## Required reviewer pairing

| Work | Required review |
|---|---|
| Auth, authorization, secrets, portals | General reviewer and security reviewer |
| Durable receipt, DNC, delivery, billing | General reviewer and failure-mode review |
| Migrations and backfill | General reviewer plus reconciliation evidence |
| UI-only work | General reviewer and behavior observation |
| Cutover controls | General reviewer, security reviewer, and Gate C |

## Stop conditions

Stop the affected task and record a blocker if:

- a test would need a live endpoint;
- a migration cannot be made restartable;
- buyer identity cannot be reconciled without guessing;
- a credential would need to enter source, a spreadsheet, or a browser response;
- native shadow can produce a live side effect;
- a production action is required before Gate C;
- unrelated upstream sync changes alter the audited surface.

Continue every unaffected ready task.
