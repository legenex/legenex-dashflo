# Handoff

The minimum a fresh session needs. Keep this short and current. Overwrite, do not append.

This file (inside the DashFlo repo itself) is now the canonical live copy. The original at
`Legenex AgentOS/projects/dashflo/forge-pack/state/HANDOFF.md` is a historical snapshot only
as of 2026-09-05 — update this one, not that one.

**Current state:** Waves 0 and 1 DONE (all five dispatchable units), merged and deployed clean.
Current `main` HEAD is `f19dd0e`.

**Wave 0 results** (see PROGRESS.md's 2026-09-05 entry for full detail): W0-AUDIT (`0673145`,
docs/GAP-MAP.md, 63 items), W5-EMPTY-STATES (`16f6835`, fixed the AI-card red-error bug),
W6-FIXTURES (`cf4dad5`/`53a86bf`, found 3 distribution-engine safety defects, see BLOCKERS.md),
W1-FLAGS (`2ca7c1a`, 8 immutable money flags + write-once trigger).

**Wave 1 results:**
- `13c8dea` W9-ONBOARDING — fixed GAP-59 (Xero/Stripe steps no longer block the whole onboarding
  pipeline when uncredentialed) and GAP-57 (buyer vertical is now actually captured and stored).
  Found a new gap: Buyer Draft→Active has no delivery-test gate at all (D9 names this as a
  requirement) — recorded in BLOCKERS.md, not fixed (out of file ownership).
- `f19dd0e` W2-STATUS (`321b3d9` + repair `bcfe017`) — the bottleneck unit. **Took two full
  implementation rounds.** First pass (`321b3d9`) built genuinely sound mapping/reason-code/
  connector-trigger-remap/money-safety logic but FAILED independent adversarial QA at the unit
  level: nothing actually invoked the migration (zero of 1,984 leads had any path onto the new
  vocabulary) and `webhook.js`/`leadbyteWebhook.js` never wrote the new fields, so every lead
  created after this release would have had a permanently NULL `lead_status` — exactly the kind
  of gap that would have silently broken W3-UI-STATUS the moment it started reading `lead_status`.
  Repaired (`bcfe017`): added `server/scripts/migrate-status-vocabulary.js` (report by default,
  `--apply` to write, via `npm --prefix server run migrate:status-vocabulary`), made
  `webhook.js`/`leadbyteWebhook.js` dual-write the new fields additively alongside `final_status`,
  and fixed three smaller correctness issues (a false-clean verification, a missed `migrated_at`
  stamp on already-consistent rows, and `migrated_at` permanently excluding a lead from future
  reaping even after a genuinely new live failure). **Still not run against a restored copy of
  real production data** — same disclosed limitation as W1-FLAGS; the drill is now actually
  possible (the script exists) but hasn't been executed. Left a code-comment note for whoever
  builds W4-REAPER: use the new `processed_at`/`leadbyte_outcome_at`-based signal, not
  `migrated_at` alone, to decide redrive eligibility.

**W13-OFFSITE:** still blocked on Nick choosing an off-site backup provider. Not dispatched.

**New, currently unowned findings that need their own bounded unit(s) before Gate C** (full detail
in `BLOCKERS.md` — do not re-discover from scratch, several have exact file:line citations):
1. Three duplicate-send/silent-cascade defects in `client/src/lib/distribution/{distribute,
   distributeRun,deliveryAttempt}.js` (W6-FIXTURES).
2. `webhook.js`/`leadbyteWebhook.js` have no precedence guard on `final_status` writes, and two
   live files encode a precedence order that directly contradicts D1 (Sold/Converted ranked above
   Returned, the reverse of `returned > converted > sold`). At least 14 files (not 2) reference a
   retired status literal with no unit owning them — critically, `testCapiConnector.js` is live,
   authenticated, reachable production code, not dead tooling.
3. Buyer Draft→Active has no delivery-test gate (`OperationsBuyers.jsx`'s `transition()` is an
   instant status-only write) — a D9 completion requirement, found by W9-ONBOARDING.

**Last successful verification:** `npm run gate` fully green at `f19dd0e` under
`LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8` (this Mac's `en_ZA` default locale otherwise fails one
unrelated, pre-existing, CI-invisible test — always set those two env vars). Two transient,
self-resolving GitHub Actions failures occurred during Wave 0/1 (a push-race the remote script's
own SHA check caught correctly, and one VPS SSH-host-key-unreachable blip fixed by `gh run
rerun`) — neither was a code defect; production was reconfirmed healthy both times.

**Next action:** dispatch Wave 2 — W3-UI-STATUS, W4-REAPER, W7-INVARIANTS (all depend on
W2-STATUS, now done; disjoint file trees, safe to run in parallel). W4-REAPER is flagged
high-risk/adversarial-review-required in BUILD-PLAN.md and should use `isExcludedFromRedrive()`
plus the `processed_at`/`leadbyte_outcome_at` guidance already left in `leadStatus.js`'s comments.

**Files that matter now:** `forge-pack/CONTRACT.md`, `forge-pack/03-plan/WORK-UNITS.yaml`,
`docs/GAP-MAP.md`, `server/src/lib/leadStatus.js` (the new status-vocabulary module, read its
top comments), `AGENTS.md`, `docs/HUMAN-GATES.md`, `forge-pack/state/BLOCKERS.md`.
`docs/GROUND-TRUTH.md` is stale (dated 15 August) — do not act on its file-path/machine claims.

**The one thing not to forget:** nothing is routing commercially. Zero active RouteGroup rows.
The deliverable is Gate C, not construction.
