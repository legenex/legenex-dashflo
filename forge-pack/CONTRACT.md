# DashFlo Build Contract v3 (canonical)

**Supersedes in full:** the v1 AgentOS Master Discovery, the v2 Master Build Contract, and the v2.1 Corrections. Those three are archived history. This is the only contract agents read.

**Owner and final product authority:** Nick Allen
**Repo:** `github.com/legenex/legenex-dashflo`, branch `main`
**App:** `app.dashflo.io` | API `api.dashflo.io` | Docs `docs.dashflo.io`
**Target:** first supplier live on DashFlo by 16 September 2026
**Written:** 4 September 2026, after a direct clone and audit of the repository at `f89b2e8`

---

## 1. Document precedence

The repository already defines its own precedence in `docs/GROUND-TRUTH.md`. This contract does not replace it. It slots into it.

1. Nick's explicit decisions, including §4 of this contract
2. Security, privacy, legal suppression, prevention of irreversible production actions
3. Reproducible current-machine evidence: `docs/GROUND-TRUTH.md`
4. Executable tests and observed application behaviour
5. Locked requirements and accepted architecture: `docs/REQUIREMENTS.md`, `docs/adr/`, `AGENTS.md` invariants
6. **This contract**, for the remaining work plan, scope and sequencing
7. Historical audits, plans, comments, generated summaries

**Where this contract and the repository disagree about a machine fact, the repository wins and this contract gets corrected in the same commit.** Where they disagree about what work remains and in what order, this contract wins.

`AGENTS.md`, `docs/HUMAN-GATES.md` and `docs/GROUND-TRUTH.md` are not superseded by anything here. This contract adds a work plan on top of them.

---

## 2. Where the project actually is

Verified by clone and execution on 4 September 2026, not inferred.

**Built, deployed and proven:**

- 596 `.js` and 471 `.jsx` files. Server 51,279 lines, client 94,287 lines, docs 10,190 lines.
- 95 entity schemas including `RouteGroup`, `RouteMember`, `RouteConfigVersion`, `RouteDecisionTrace`, `CapCounter`, `CapReservation`, `DeliveryAttempt`, `ResponseMapping`, `SubDelivery`, `BuyerCplRule`, `BuyerStateCpl`, `SupplierStateCoverage`, `ReturnRequest`, `BuyerOnboarding`, `DncEntry`, `ReleaseGate`.
- 121 backend functions. Production boot reports `loaded 109 functions`.
- **1,491 tests passing**, 181 skipped without a database, across 144 files. CI runs the skipped ones against a real `postgres:16`.
- Root gate `npm run gate`: tests, function-loader, engine-parity, lint, build, bundle-purity, secret-scan, em-dash.
- Continuous deployment: push to `main` runs the gate in CI, then deploys. Last run `33147743996` green, VPS `HEAD` matches.
- One canonical routing engine, 3,227 lines, generated from `client/src/lib/distribution/`, SHA-pinned, with a blocking parity check that also fails if a hand-written mirror reappears.
- Simulator, shadow report and distribution mode switching exist as functions.
- Durable receipts with `transport_key TEXT NOT NULL UNIQUE`. Cap counters with a unique canonical `scope_key`. Idempotency handling across receipts, retry runner, processLead, billing and API keys.
- Nightly backups, restore-verified into a disposable database, proven by booting the real app image against the restored copy.
- Human gates A to D with a decision packet template, and the rule that a packet answerable by code or tests is not ready to send.

**Not done:**

- **Nothing is routing commercially. Zero active `RouteGroup` rows.** `NATIVE_RETRY_WORKER_ENABLED` absent. `BASE44_SYNC_ENABLED=0`.
- Production holds 1,984 leads, 13 buyers, 5 suppliers across 101 tables, all dormant.
- Off-site backup replication is a deliberate no-op: `deploy/backup/offsite.env` does not exist.

**The reframe that governs everything below:** this is not a system waiting to be built. It is a system waiting to be switched on. The 16 September deliverable is Gate C, one supplier live safely, not a construction project.

---

## 3. What the Overview screenshot proves, and the rule it creates

The app on 4 September showed Revenue $0, Sold 0, "No leads in this period", alongside Cost $7,198 and Profit -$7,198. Also `ANTHROPIC_API_KEY is not set` rendered in red on the owner's home page next to Confidence 100% and "$670,409 at risk", and Data Quality 100/100 captioned "unverified, feeds stale".

Cost with no leads is ad spend arriving through a connector into a dormant lead table. That is expected given §2. The presentation is not.

**Binding rule for every card in the app.** A metric with no underlying data renders "no data for this period". A metric whose source is unavailable renders "unavailable" with a link to the relevant Data Source. Neither renders as `$0.00`, and neither renders a confidence score. A missing optional integration degrades quietly and never puts a red error on the primary dashboard. A score and its caption may not contradict each other.

---

## 4. Binding product decisions

Numbered so work units and commits can cite them.

### D1. Lead statuses: seven, with an internal processing state

The operator-facing enum becomes exactly: `queued`, `rejected`, `disqualified`, `unsold`, `sold`, `returned`, `converted`.

| Status | Exact meaning |
|---|---|
| `queued` | Durably saved, not yet settled. Covers received, processing, retry-pending and awaiting-cascade |
| `rejected` | The submission was **not accepted** as a valid, new, routable lead. A system or field-level rejection, returned to the poster |
| `disqualified` | Accepted as valid, then **failed a business qualification rule** for the vertical or campaign. Never offered to a buyer |
| `unsold` | Qualified, entered distribution, **no buyer bought it**. Includes buyers being asked and saying no |
| `sold` | At least one valid buyer acceptance under the exclusive or shared rule |
| `returned` | A previously sold lead with an approved return |
| `converted` | A previously sold lead confirmed downstream by the buyer as signed, retained or equivalent |

**`processing_state` is a separate internal field:** `received`, `validating`, `routing`, `settled`, `failed`, `ambiguous`. A crash never changes `lead_status`. A lead at `queued` + `failed` is a stuck lead, surfaced in the Stuck Leads queue and picked up by the reaper.

**Precedence when more than one could apply:** `returned` > `converted` > `sold` > `unsold` > `disqualified` > `rejected` > `queued`.

**Funnel:** Received, then `rejected`, then `disqualified`, then Qualified, then `sold` or `unsold`. This matches LeadByte's post-time rejection behaviour, so supplier-facing numbers reconcile without a translation layer. There is no `not_sold_total`. Unsold is the single not-sold figure and buyer rejections roll up inside it, with per-buyer rejection codes preserved on each `DeliveryAttempt`.

### D2. Money never comes from `lead_status`

The lead carries immutable derived flags, set once and never cleared: `is_sold`, `sold_at`, `sale_price_effective`, `is_returned`, `returned_at`, `is_converted`, `converted_at`, `conversion_type`.

Revenue is the sum of `sale_price_effective` where `is_sold`, less approved returns. Never a count of rows where status equals sold.

Without this, every conversion that arrives decrements Sold and Revenue, quietly, weeks after launch. This decision is a prerequisite for D1 and is built first.

### D3. DNC stays exactly as built

`DncEntry`, `dnc.js`, `dncEnforcement.js`, `dncManage.js` and the enforcement inside `processLead.js` and `intake.js` remain in place, enabled, and covered by their existing tests. Gate C's "DNC all-path evidence" line in `docs/HUMAN-GATES.md` stands unchanged.

A DNC-suppressed lead is durably stored and takes `lead_status = rejected` with reason `REJECTED_DNC`, since under D1 it was not accepted as a routable lead. The engine's existing `SUPPRESSED` reason code is the eligibility-layer equivalent and is unaffected.

### D4. Retiring status values map as follows

| Retiring | Code sites | Becomes | Reason |
|---|---|---|---|
| `Processing` | 8 | `queued` | `processing_state = routing` |
| `Qualified` | 13 | `queued` | plus a derived `is_qualified` flag so qualification rate survives |
| `Duplicate` | 21 | `rejected` | `REJECTED_DUPLICATE`, linked to the original lead |
| `Error` | 30 | `queued` | `processing_state = failed`, excluded from re-drive by a `migrated_at` marker |
| `Fake` | 1 | `rejected` | `REJECTED_FAKE` |

**Three risks this migration must not realise:**

1. `ApiConnector`, `LeadByteConnector` and `InboundWebhookRoute` derive trigger keys from the status field, including `on_duplicates` and `on_received`. Remap every connector trigger array in the same migration. A trigger matching nothing throws no error, so failure here is silent.
2. All 1,984 existing leads change status. Revenue totals before and after must be identical to the cent, which is what D2 protects.
3. Thirty code sites treat `Error` as terminal. Under D1 those leads become recoverable. The backfill must not re-drive historical errors into live distribution.

### D5. Nothing that already works gets deferred

Before deferring any capability, grep the engine `REASON` map and the entity schemas. `FILTER_ZIP`, `FILTER_COUNTY`, `CAP_HOURLY` through `CAP_TOTAL`, `LOW_BALANCE`, `OVER_CREDIT_LIMIT`, `DESTINATION_UNHEALTHY` and `BELOW_RESERVE` all exist and stay. Deleting shipped tested capability to hit a date is never the trade.

### D6. Base44 exit follows the boundary document, not a grep

`docs/BASE44-BOUNDARY.md` is the authority. `migrationImport.js`, `base44Reconcile.js`, `migrationPlan.js` and `migrationExport/exporter.js` are live migration machinery and stay until Gate D retirement. Sync stays disabled. Only runtime and UI surface area is removed before then. No "grep returns nothing" check before Gate D.

### D7. Approvals run through the existing gates

`docs/HUMAN-GATES.md` Gates A to D are the approval model, unchanged, including the rule that a packet answerable by code, tests, exports, history or a safe local experiment is not ready to send.

Two additions:

- **Live pricing.** Any change to an effective buyer sale price, tiered or conditional price rule, or supplier payout on a live route is a Gate C decision item, and a later change on a live route reopens a Gate C packet. Prices on draft, paused or test-mode routes need no gate. Transcribing an existing LeadByte price during migration is a copy, not a change; a transcribed price that does not match the source of record is a defect and is escalated as one.
- **Delivery and default.** Gate packets are delivered in two fixed digests per day, 09:00 and 17:00 in Nick's timezone. Each carries a stated safe default and a deadline. An unanswered packet takes its safe default and work continues. The safe default is never activate and never spend.

### D8. Roles stay as built

The existing permission model and portal isolation evidence stand. No role model rewrite before cutover. Revisit at white-label.

### D9. Buyer onboarding is completed, not built

`BuyerOnboarding`, `OnboardingEmailTemplate`, `onboardBuyer.js`, `sendOnboardingLink.js`, `submitBuyerOnboarding.js` and `getOnboardingContext.js` exist. Scope is completion and hardening of the secure link, the per-vertical form, immutable versioned submissions, missing-information detection, the internal alert, and visibility on Buyer Detail. Out of scope until after cutover: IO documents, e-signature, template editing UI, Xero, Stripe and payment links. The `payment_required` flag is stored so that work is additive later.

### D10. AgentOS orchestration topology

Bossman is the durable project orchestrator. Nick is not the prompt router and does not manually advance waves. Hermes owns durable orchestration through the existing DashFlo Kanban; Buzz is the project conversation, visibility and approval surface; Bossman business WhatsApp is the urgent approval/blocker surface when verified live. `buzz_guard` stays closed at its current non-mutating allowlist and is not widened for this build. Coding work is dispatched through the approved repo-capable execution path directly against `legenex/legenex-dashflo`, with branch/worktree isolation and the existing repository rules. Bossman automatically advances dependency-satisfied work from persistent state and requires independent evaluation before completion.

### D11. Freeze

12 September. After it: fixes, tests, reconciliation and cutover only. New feature requests go to the post-cutover backlog automatically, including Nick's.

---

## 5. Remaining work, in one list

| Ref | Work | Size |
|---|---|---|
| A | Derived money flags and backfill (D2) | Small, blocking |
| B | Seven-status migration, connectors, reason codes (D1, D4) | **Largest single item** |
| C | Status vocabulary through UI, per-tab filters, reports | Medium |
| D | Stuck lead reaper and Stuck Leads queue | Small |
| E | Honest empty states across cards (§3) | Small |
| F | List-page congruence: tables, filters, actions, columns | Medium, size against code first |
| G | Buyer onboarding completion (D9) | Medium, size against code first |
| H | Fixtures and adversarial delivery modes | Small |
| I | Invariant-to-constraint audit | Small |
| J | Off-site backup provider decision | Human |
| K | Gate C packet, shadow run, first supplier live | The deliverable |

**F and G must be sized against the code before they are planned.** `docs/STATE.md` records seven completed Lead Distribution rebuild stages, so v1's description of them is probably pessimistic. Wave 0 measures them.

---

## 6. Cadence

| Date | Gate | Green means |
|---|---|---|
| Fri 5 Sep | Re-audit | Gap map for F and G produced from the code. Backlog rewritten from what is actually missing |
| Sun 7 Sep | Migration on staging | Seven statuses live on a restored copy of production. 1,984 leads migrated. Connector triggers remapped. Revenue identical to the cent before and after |
| Tue 9 Sep | Surfaces | F and G closed to the level v1 §1.6 describes |
| Thu 11 Sep | Gate C packet | Full evidence list per `docs/HUMAN-GATES.md`, plus live pricing decisions, first-supplier manifest, thresholds, kill switch, rollback |
| Fri 12 Sep | Freeze | Fixes, tests, cutover only |
| Mon 15 Sep | Shadow | Shadow report against real traffic, every discrepancy explained |
| Tue 16 Sep | **Gate C: first supplier live** | One supplier, low cap, monitored lead by lead, LeadByte retained for rollback |
| After | Gate D | Next tranche, LeadFlow last, then retirement |

LeadFlow is the highest-volume relationship, so it is built and tested against first and cut over **last**. Highest value gets the most testing and is never the guinea pig.

---

## 7. Never-acceptable at cutover

Carried from v1 §47.5, still binding, unchanged: lost leads, duplicate commercial sends or sales, dedupe failure, wrong routing, cap oversell, incorrect sale price, revenue, cost or gross profit, insecure secrets, cross-buyer or cross-supplier data leakage, untraceable commercial actions, unsafe retries, silent processing failures, corrupted production data, or inability to roll back safely.
