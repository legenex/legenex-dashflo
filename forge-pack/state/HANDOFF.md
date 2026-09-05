# Handoff

The minimum a fresh session needs. Keep this short and current. Overwrite, do not append.

This file (inside the DashFlo repo itself) is now the canonical live copy. The original at
`Legenex AgentOS/projects/dashflo/forge-pack/state/HANDOFF.md` is a historical snapshot only
as of 2026-09-05 — update this one, not that one.

**Current state:** Wave 0 DONE (all four dispatchable units), merged and deployed clean. Current
`main` HEAD is `2ca7c1a`.

**Wave 0 results, all merged to `main` and deployed to production:**
- `0673145` W0-AUDIT — `docs/GAP-MAP.md`, 63 items (27 P0 / 32 post-cutover / 4 closed).
- `16f6835` W5-EMPTY-STATES — fixed a real bug: the AI Analyst card rendered a red
  `"ANTHROPIC_API_KEY is not set"` error next to a fake 100% confidence score.
- `cf4dad5`/`53a86bf` W6-FIXTURES — 13 fixtures against the real engine; found three real
  duplicate-send-risk defects in `client/src/lib/distribution/**`, recorded as a new blocker
  (see BLOCKERS.md), not fixed (out of this unit's file ownership).
- `2ca7c1a` W1-FLAGS — 8 immutable derived money flags + write-once Postgres trigger.
  Independently adversarially reviewed; one blocking gap found and repaired in the same session
  (`precedence_unverified` exception in the backfill — see BLOCKERS.md and PROGRESS.md for detail).
  **Not yet backfilled against real production data** — no report reads these flags yet.

**W13-OFFSITE:** still blocked on Nick choosing an off-site backup provider and placing a
credential in the production secret mechanism. Not dispatched, not blocking anything else.

**New, currently unowned findings from Wave 0 that need their own bounded unit before Gate C**
(see `BLOCKERS.md` for full detail — do not re-discover these from scratch):
1. Three duplicate-send/silent-cascade defects in `client/src/lib/distribution/{distribute,
   distributeRun,deliveryAttempt}.js`, found by W6-FIXTURES.
2. `server/src/functions/webhook.js` (create ~604, update ~505) and `leadbyteWebhook.js`
   (create branch) can write `final_status` straight to Converted/Returned with no precedence
   guard against a prior Sold — found during W1-FLAGS's adversarial QA. W1-FLAGS worked around
   this defensively (flags the affected rows rather than trusting them silently) but the actual
   guard still needs adding in those two files before a real backfill runs.

**Last successful verification:** `npm run gate` fully green at `2ca7c1a` under
`LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8` (this Mac's default `en_ZA` locale otherwise fails one
unrelated, pre-existing test — `migrationPreviewReport.test.jsx` expects `"1,942"`, en_ZA
renders `"1 942"` — confirmed as a machine-locale artifact, invisible in CI; always set those
two env vars when running tests/gate on this machine). GitHub Actions deployed every Wave 0
merge successfully; one transient self-resolving deploy-race failure occurred from pushing two
commits within seconds of each other (the remote script's own SHA-match safety check caught it
correctly) — space out pushes, wait for each deploy to clear before pushing the next.

**Next action:** dispatch Wave 1 — W2-STATUS (depends on W1-FLAGS, now done; this is the
bottleneck, largest single item, give it the most careful review) and W9-ONBOARDING (depends on
W0-AUDIT, now done; GAP-57 and GAP-59 in `docs/GAP-MAP.md` are its two blocking findings).

**Files that matter now:** `forge-pack/CONTRACT.md`, `forge-pack/03-plan/WORK-UNITS.yaml`,
`docs/GAP-MAP.md`, `AGENTS.md`, `docs/HUMAN-GATES.md`, `forge-pack/state/BLOCKERS.md`.
`docs/GROUND-TRUTH.md` is stale (dated 15 August, describes a different local machine setup) —
do not act on its file-path/machine-state claims.

**The one thing not to forget:** nothing is routing commercially. Zero active RouteGroup rows.
The deliverable is Gate C, not construction.
