# Progress

Append one entry per session. Newest at the bottom. Keep entries short: outcomes, not narration.

Format:

```
## YYYY-MM-DD  <unit id>
Attempted:
Changed:
Verified:      <command and result>
Remains:
Next unit:
```

---

## 2026-09-04  pack created
Attempted: consolidate v1, v2 and v2.1 into one contract and generate an execution pack.
Changed: `forge-pack/` created. No application code touched.
Verified: work graph validated acyclic, 14 units, 7 waves, no shared write ownership within a wave.
Remains: everything in `state/BACKLOG.md`.
Next unit: W0-AUDIT and W1-FLAGS in parallel.

## 2026-09-05  Wave 0 (W0-AUDIT, W1-FLAGS, W5-EMPTY-STATES, W6-FIXTURES)
Attempted: installed forge-pack into the repo (`3c65720`); dispatched all four Wave 0 units in
parallel, each in its own worktree/branch with exclusive file ownership; independently reviewed
and merged each to `main` (builder never certified its own work).
Changed:
- `docs/GAP-MAP.md` added (`0673145`): 63 items, 27 P0, 32 post-cutover, 4 closed. Two P0 findings
  block W9-ONBOARDING directly: GAP-57 (the onboarding form's vertical field is dead code, the
  wired form has no vertical field at all, so D9's "per-vertical form" is unmet) and GAP-59
  (`onboardBuyer.js`'s Xero/Stripe steps throw unconditionally with no credential, blocking every
  downstream in-scope onboarding step, even though D9 defers Xero/Stripe past cutover).
- `client/src/components/overview/**`, `Overview.jsx` fixed (`16f6835`): Revenue/CPL/Profit now
  show explicit no-data states on an empty lead table instead of `$0`; the AI Analyst card no
  longer renders a red `"ANTHROPIC_API_KEY is not set"` error (now a quiet not-configured message
  linking to Settings > API Keys) - a real, live bug matching CONTRACT.md section 3's exact
  example; Data Quality now shows "Unavailable" (linked to Settings > Data Sources) instead of a
  false 100% score when feeds are stale/empty.
- `server/test/fixtures/**`, `fixtureOutcomes.test.js` added (`cf4dad5`): 13 named synthetic
  fixtures run through the real distribution engine end to end. Found and pinned (as documented
  `KNOWN GAP` tests, not fixed - out of scope, owned by no current unit) three real safety defects
  in `client/src/lib/distribution/{distribute,distributeRun,deliveryAttempt}.js`: an ambiguous
  outcome does not stop cross-destination cascade in the same run (duplicate-sale risk), an
  unmatched 2xx response defaults to accepted without `requireAccept` configured (the historical
  Walker false positive), and a real connection drop's `error_class` ("fetch failed") does not
  match the ambiguous-classification whitelist, so it resolves as a clean fallback-eligible miss
  instead. Recorded in `BLOCKERS.md` as a new unowned unit needed before W4-REAPER/Gate C.
- `server/src/schemas/entities/Lead.json`, `server/src/db/schema.js`, `server/src/lib/leadFlags.js`,
  `server/test/leadFlags.test.js` added (`2ca7c1a`, D2): 8 immutable derived money flags
  (is_sold/sold_at/sale_price_effective/is_returned/returned_at/is_converted/converted_at/
  conversion_type), enforced write-once at both the app layer and a Postgres trigger. Independent
  adversarial QA proved the trigger genuinely holds (raw-SQL probes, 13 assertions) and found one
  real blocking gap before repair: `webhook.js`/`leadbyteWebhook.js`'s create paths can write
  Converted/Returned with no prior Sold and no precedence guard, which combined with permanent
  immutability could lock a wrong `is_sold=true` in forever. Repaired (`20e1e76`, same session)
  with a `precedence_unverified` backfill exception that surfaces every such row for human review
  instead of silently trusting it - `is_sold` semantics themselves were not redesigned (out of
  scope; the actual fix needs a precedence guard in webhook.js/leadbyteWebhook.js, not owned by
  this unit). QA also found the reconciliation tests' baseline didn't match the actual primary
  revenue calculation (`overviewFinance.js`/`reportMetrics.js` sum revenue unconditionally, never
  exposed to the D2 drift; only `partnerMetrics.js`'s buyerMetrics and a secondary `booked_revenue`
  stat use the vulnerable Sold-only filter) - reworded to be accurate rather than overstated.
Verified: `npm run gate` green at every merge (`LC_ALL=en_US.UTF-8` - this Mac's `en_ZA` default
locale otherwise fails one unrelated, pre-existing number-formatting test, invisible in CI).
GitHub Actions deployed every merge to production successfully (one transient, self-resolving
deploy-race failure from pushing two commits within seconds of each other - the remote script's
own SHA-match safety check caught it correctly; the very next run succeeded and production health
was reconfirmed at the correct commit; not a code defect).
Remains: W13-OFFSITE still blocked on Nick (backup provider choice). The webhook.js precedence
gap and the three distribution-engine safety defects are new, currently unowned findings that
should get their own bounded units before Gate C - see `BLOCKERS.md`.
Next unit: Wave 1 - W2-STATUS and W9-ONBOARDING, both now unblocked.

## 2026-09-05  Wave 1 (W2-STATUS, W9-ONBOARDING)
Attempted: dispatched both in parallel worktrees; independently reviewed before merge.
Changed:
- `server/src/functions/{submitBuyerOnboarding,getOnboardingContext,sendOnboardingLink,
  onboardBuyer}.js`, `client/src/pages/Apply.jsx`, `CoverageStep.jsx`, `BuyerOnboarding.json`
  (`13c8dea`, W9-ONBOARDING): fixed GAP-59 (Xero/Stripe steps now skip gracefully instead of
  throwing and blocking the whole pipeline when uncredentialed - matches the existing
  crm_contact/dispo_scope pattern) and GAP-57 (the wired onboarding form now actually captures
  and stores a buyer's vertical; a per-buyer invite link's known vertical is no longer dropped).
  Also added: link expiry (30-day TTL, was completely unimplemented despite the UI promising it),
  immutable versioned submissions (was silently overwriting), rate limiting on
  getOnboardingContext (was present on submit, missing on read). Found and recorded a new gap:
  Buyer Draft to Active has no delivery-test gate at all, contra D9's own acceptance line.
- `server/src/schemas/entities/{Lead,ApiConnector,LeadByteConnector,InboundWebhookRoute}.json`,
  `server/src/functions/{processLead,webhook,leadbyteWebhook}.js`, `server/src/lib/leadStatus.js`
  (new), `server/scripts/migrate-status-vocabulary.js` (new) (`f19dd0e` = `321b3d9` + `bcfe017`,
  W2-STATUS, D1/D3/D4): the seven-value status vocabulary, `processing_state`, machine reason
  codes, and connector-trigger remapping. **Two full rounds required** - round 1 (`321b3d9`)
  built sound mapping/safety logic (proven: naive trigger remapping would have been actively
  dangerous, not just wrong; revenue-from-flags provably unaffected; three D4 risks addressed)
  but adversarial QA found the unit didn't do its actual job: no invokable migration existed (0 of
  1,984 leads had any path to the new vocabulary) and `webhook.js`/`leadbyteWebhook.js` never
  wrote the new fields, so every lead created after release would get a permanently NULL
  `lead_status` - a ticking regression for W3-UI-STATUS. Round 2 (`bcfe017`) added a real
  report/`--apply` migration script, made both webhook handlers dual-write the new fields
  additively (proven not to change either file's existing behavior via 11 new tests against real
  handlers/real DB), and fixed three smaller issues: a verification that reported "clean" on a
  dirty run, a missed `migrated_at` stamp on rows already consistent, and `migrated_at`
  permanently blocking future reaping of a lead that later fails for real (fixed using
  `processed_at`/`leadbyte_outcome_at` as the live-activity signal, since this module structurally
  cannot write those fields). QA also corrected an earlier finding: it's two contradictory
  precedence orders in live code, not three, and the unowned-file list is ~14 files, not 2 -
  `testCapiConnector.js` is live production code. Still not run against a restored production
  copy (same disclosed limitation as W1-FLAGS) - the drill is now possible, not yet done.
Verified: `npm run gate` green at every merge under `LC_ALL=en_US.UTF-8`. One transient GitHub
Actions failure (VPS SSH host-key unreachable after 3 attempts - a network blip, not a code
issue), resolved by `gh run rerun`; production reconfirmed healthy.
Remains: W13-OFFSITE still blocked. Three unowned findings need bounded units before Gate C (see
BLOCKERS.md): the distribution-engine safety defects, the webhook.js precedence guard, and the
Buyer Draft-to-Active delivery-test gate.
Next unit: Wave 2 - W3-UI-STATUS, W4-REAPER, W7-INVARIANTS, all now unblocked, disjoint file
trees, dispatched in parallel.

## 2026-09-05  Wave 2 (W3-UI-STATUS, W4-REAPER, W7-INVARIANTS)
Attempted: dispatched all three in parallel worktrees (disjoint file ownership); independently
reviewed/verified before each merge; two of three needed a repair round after adversarial QA.
Changed:
- `client/src/lib/leadStatus.js` (new client module), `LeadsTable.jsx`, `LeadsFilterBar.jsx`,
  `DistributionDashboard.jsx`, `Overview.jsx`, `distributionMetrics.js` (`7b15563`, W3-UI-STATUS):
  the seven-status vocabulary now drives the client - per-tab filters (`matchesLeadView`), a
  Status filter shown only on the "All Leads" tab (`showStatusFilter={view === 'all'}`), split
  Rejected/Unsold reason cards, a "Top Unsold Reasons" panel. Deleted 4 confirmed-dead files
  (`Leads.jsx`, `LeadsRejections.jsx`, `ExportColumnsDialog.jsx`, and `TopRejectionReasons.jsx` -
  a stale unwired duplicate the unit found independently, not in GAP-MAP). Direct personal
  verification (not a separate QA agent): reviewed the diff, re-ran gate.
- `server/src/functions/reapStuckLeads.js`, `client/src/components/distribution/
  StuckLeadsCard.jsx` (new) (`96c00cb` + repair `53d2842` + `cbb8c76`, W4-REAPER): a scheduled
  reaper that classifies stuck leads (RESUME_DELIVERY/AMBIGUOUS_HOLD/EXCLUDED_MIGRATED/
  NO_SAFE_REENTRY/ALREADY_SOLD) and an operator-facing Stuck Leads card. **Adversarial QA
  required and found two real gaps before repair**: B1, the reaper bypassed
  `NATIVE_RETRY_WORKER_ENABLED`, the existing kill switch for the exact send path it reuses; B2,
  classification didn't actually control what got sent - `runNativeRetryPass`'s batch nature
  meant ambiguous/excluded leads got resent anyway despite the UI correctly labeling them "never
  resumed automatically." Repaired: `nativeRetryRunner.js` gained an optional `onlyLeadIds`
  ALLOWLIST parameter (not an exclude-list - an allowlist fails closed if a lead is missed or
  misclassified) applied at the `listDue` query layer plus a second defense-in-depth throw inside
  `deliverFn`, backward-compatible (omitted/null returns the original behavior and return shape).
  `startStuckLeadReaper` was written but not scheduled anywhere; wired into `server/src/index.js`
  directly (mirroring the existing `startNativeRetryScheduler` pattern) since `index.js` isn't
  owned by any unit. Resolved one real git merge conflict in `DistributionDashboard.jsx` against
  W3-UI-STATUS's already-merged "Top Unsold Reasons" panel (kept both additions).
- `docs/INVARIANTS.md` (new), `server/src/db/invariantConstraints.js` (new),
  `server/test/{capRace,idempotency}.test.js` (new) (`aa17634` + boot-wiring `5a7b03c`,
  W7-INVARIANTS): a full invariant-to-constraint audit, 15 commercial invariants from
  CONTRACT.md Section 7 scored against actual DB constraints vs. app-only enforcement, each with
  a file:line citation or an honest "gap" verdict. Closed one real, verified gap:
  `CapReservation.json`'s own comment claimed "(idempotency_key, route_member_id) uniqueness
  guarantees no double-consume" but no such DB constraint existed anywhere - only
  `reservation.js`'s atomic claim (itself resting on `CapCounter`'s real index) kept it honest,
  one call site away from bypassable. Added a real unique index, guarded by a pre-check that
  refuses to create it over any existing violation rather than risk a boot crash. Proven under
  genuine concurrency (`Promise.all`, not sequential) against a real disposable Postgres, not
  doubles: 12 concurrent cap-1 claimants leave exactly one winner (`capRace.test.js`); the real
  `processLead()` entry point replayed sequentially, with an explicit idempotency key, and
  concurrently always yields exactly one Lead/receipt (`idempotency.test.js`). Three more real,
  currently unowned gaps found and honestly recorded, not fixed (out of this unit's reach or file
  ownership) - see BLOCKERS.md: cross-buyer/cross-supplier authorization has no DB-tier
  equivalent (needs an architecture decision, not an additive constraint), DeliveryAttempt/
  RouteDecisionTrace have no DB-level append-only guarantee, and two small stale-schema findings
  (ApiKey.json's legacy raw_key purge, CapReservation.json's state enum missing 'failed'). I
  independently verified the new index physically exists on a live disposable database (not just
  read the source) and re-ran both new test files plus the full gate myself before merging.
  `ensureInvariantConstraints()` was written but not called at boot (disclosed, `index.js` not
  owned by this unit); wired in directly, same pattern as W4-REAPER's scheduler.
Verified: `npm run gate` green under `LC_ALL=en_US.UTF-8` at every merge, including after the
`DistributionDashboard.jsx` manual conflict resolution and after wiring both boot-time follow-ups.
Production reconfirmed healthy after each deploy.
Remains: W13-OFFSITE still blocked. Six unowned findings now recorded in BLOCKERS.md needing
their own bounded units before Gate C: three from before this wave (distribution-engine
duplicate-send defects, webhook.js/leadbyteWebhook.js precedence guard + ~14-file trigger-key
cleanup, Buyer Draft-to-Active delivery-test gate), plus three new from W7-INVARIANTS' audit
(cross-tenant RLS, audit-trail append-only trigger, two stale schema fields).
Next unit: Wave 3 - W8-CONGRUENCE (depends on W0-AUDIT + W3-UI-STATUS, both done).
