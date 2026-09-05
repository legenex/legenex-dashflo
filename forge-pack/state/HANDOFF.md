# Handoff

The minimum a fresh session needs. Keep this short and current. Overwrite, do not append.

This file (inside the DashFlo repo itself) is the canonical live copy. The original at
`Legenex AgentOS/projects/dashflo/forge-pack/state/HANDOFF.md` is a historical snapshot only as
of 2026-09-05 - update this one, not that one.

**Current state:** Waves 0, 1, and 2 DONE (all eight dispatchable units so far). Current `main`
HEAD is `5a7b03c`. Deploy to production for this commit was in progress as this file was last
written - confirm `curl https://dashflo.io` and `curl https://api.dashflo.io/api/health` before
trusting production is caught up.

**Wave 0 and 1 results:** see `PROGRESS.md`'s 2026-09-05 entries for full detail. Summary:
W0-AUDIT (`0673145`, docs/GAP-MAP.md, 63 items), W5-EMPTY-STATES (`16f6835`), W6-FIXTURES
(`cf4dad5`/`53a86bf`, found 3 distribution-engine safety defects - see BLOCKERS.md), W1-FLAGS
(`2ca7c1a`, 8 immutable money flags + write-once trigger), W9-ONBOARDING (`13c8dea`, fixed
GAP-57/GAP-59, found a new gap - see BLOCKERS.md), W2-STATUS (`f19dd0e` = `321b3d9`+`bcfe017`,
the seven-status vocabulary - took two rounds, see PROGRESS.md for why).

**Wave 2 results** (full detail in PROGRESS.md's 2026-09-05 Wave 2 entry):
- `7b15563` W3-UI-STATUS - the seven-status vocabulary now drives the client (per-tab filters,
  Status filter only on the All Leads tab, split Rejected/Unsold reason cards). Deleted 4
  confirmed-dead files.
- `96c00cb`+repair `53d2842`+`cbb8c76` W4-REAPER - scheduled stuck-lead reaper + operator Stuck
  Leads card. **Adversarial QA required and found two real gaps**: the reaper bypassed the
  existing `NATIVE_RETRY_WORKER_ENABLED` kill switch, and classification didn't actually control
  what got resent (ambiguous/excluded leads got batch-resent anyway). Repaired with a fail-closed
  `onlyLeadIds` allowlist on `nativeRetryRunner.js`'s `listDue` query layer plus a second
  defense-in-depth check inside `deliverFn`. I personally resolved one real merge conflict in
  `DistributionDashboard.jsx` against W3-UI-STATUS's already-merged panel (kept both). Wired
  `startStuckLeadReaper` into `server/src/index.js` myself (it was written but never scheduled;
  `index.js` isn't owned by any unit).
- `aa17634`+boot-wiring `5a7b03c` W7-INVARIANTS - full invariant-to-constraint audit
  (`docs/INVARIANTS.md`, 15 Section-7 invariants, each with a file:line citation or an honest
  "gap" verdict). Closed one real, verified gap: `CapReservation.json` claimed a DB-level
  uniqueness guarantee that didn't exist; added a real unique index (fail-closed: refuses to
  create it over any existing violation), proven under genuine concurrent load against a real
  disposable Postgres. I independently confirmed the index physically exists (queried the live
  disposable DB's `\d` output, not just read source) and re-ran both new test files plus the full
  gate myself before merging. `ensureInvariantConstraints()` was written but not called at boot
  (disclosed, same file-ownership reason as W4-REAPER); wired into `server/src/index.js` myself.

**W13-OFFSITE:** still blocked on Nick choosing an off-site backup provider. Not dispatched.

**Currently unowned findings needing their own bounded unit(s) before Gate C** (full detail in
`BLOCKERS.md` - do not re-discover from scratch, all have exact file:line citations):
1. Three duplicate-send/silent-cascade defects in `client/src/lib/distribution/{distribute,
   distributeRun,deliveryAttempt}.js` (W6-FIXTURES). W4-REAPER's repair added a scoping
   workaround for its own calls only; the primary-send-path defect itself is still open.
2. `webhook.js`/`leadbyteWebhook.js` have no precedence guard on `final_status` writes (two live
   files encode a precedence order contradicting D1), plus ~14 files referencing a retired
   trigger-key literal with no owner - `testCapiConnector.js` among them is live production code.
3. Buyer Draft->Active has no delivery-test gate (`OperationsBuyers.jsx`'s `transition()` is an
   instant status-only write) - a D9 completion requirement (W9-ONBOARDING).
4. Cross-buyer/cross-supplier authorization has no DB-tier equivalent - app-layer only
   (`entityPolicy.js`), no Postgres RLS. Needs an architecture decision, not an additive
   constraint (W7-INVARIANTS).
5. `DeliveryAttempt`/`RouteDecisionTrace` have no DB-level append-only guarantee - no live
   exploit found, but nothing would stop one being introduced (W7-INVARIANTS).
6. Two small stale-schema findings: `ApiKey.json`'s legacy `raw_key` field is still purgeable;
   `CapReservation.json`'s `state` enum is missing `'failed'`, which the code actually writes
   (W7-INVARIANTS).

**Last successful verification:** `npm run gate` fully green at `5a7b03c` under
`LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8` (this Mac's `en_ZA` default locale otherwise fails one
unrelated, pre-existing, CI-invisible test - always set those two env vars). Three transient,
self-resolving GitHub Actions failures occurred across Waves 0-2 (two push-races the remote
script's own SHA check caught correctly, and one VPS SSH-host-key-unreachable blip fixed by `gh
run rerun`) - none were code defects; production was reconfirmed healthy every time. This
session's own two merges (W4-REAPER, W7-INVARIANTS) each needed exactly one boot-wiring follow-up
commit in `server/src/index.js` because the unit's own file ownership excluded that file - check
whether a future unit's "written but not scheduled" pattern repeats before assuming it's wired.

**Next action:** dispatch Wave 3 - W8-CONGRUENCE (depends on W0-AUDIT + W3-UI-STATUS, both done;
driven by the now-closed GAP-MAP.md P0 items). Consider whether any of the six unowned findings
above should become their own bounded units first or in parallel - that decision belongs to
planning (Archie's role), not something to invent unilaterally mid-execution.

**Files that matter now:** `forge-pack/CONTRACT.md`, `forge-pack/03-plan/WORK-UNITS.yaml`,
`docs/GAP-MAP.md`, `docs/INVARIANTS.md` (new, W7-INVARIANTS - the full Section-7 audit),
`server/src/lib/leadStatus.js`, `client/src/lib/leadStatus.js` (a different file, client-side
vocabulary), `AGENTS.md`, `docs/HUMAN-GATES.md`, `forge-pack/state/BLOCKERS.md`.
`docs/GROUND-TRUTH.md` is stale (dated 15 August) - do not act on its file-path/machine claims.

**The one thing not to forget:** nothing is routing commercially. Zero active RouteGroup rows.
The deliverable is Gate C, not construction.
