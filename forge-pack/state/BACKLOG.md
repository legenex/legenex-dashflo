# Backlog

Mirrors `03-plan/WORK-UNITS.yaml` in execution order. Status: `ready`, `in-progress`, `review`, `blocked`, `done`.

| Unit | Wave | Status | Owner | Depends on | Note |
|---|---|---|---|---|---|
| W0-AUDIT | 0 | done | Dexter | none | docs/GAP-MAP.md, 63 items (27 P0/32 post-cutover/4 closed). Merged `0673145`, deployed |
| W1-FLAGS | 0 | done | Dexter | none | Merged `2ca7c1a`, deployed. Independently QA'd (adversarial review found and repaired a real gap: `precedence_unverified` exception added, see PROGRESS.md). NOT yet backfilled against real production data - that remains a follow-up before any report actually switches onto these flags |
| W5-EMPTY-STATES | 0 | done | Dexter | none | Merged `16f6835`, deployed. Fixed a real bug: AI card rendered red "ANTHROPIC_API_KEY is not set" next to a fake 100% confidence score, exactly the CONTRACT.md section 3 example |
| W6-FIXTURES | 0 | done | Dexter | none | Merged `cf4dad5`+`53a86bf`, deployed. Found 3 real safety defects in client/src/lib/distribution/** (ambiguous outcomes don't stop cascade, unmatched-2xx false-accept, connection-drop misclassified) - recorded as a new unowned blocker, see BLOCKERS.md |
| W13-OFFSITE | 0 | blocked | Dexter | owner: provider choice | Raise in first digest |
| W2-STATUS | 1 | done | Dexter | W1-FLAGS (done) | Merged `f19dd0e` (`321b3d9`+repair `bcfe017`), deployed. Two rounds: round 1 passed code review but failed unit-completion QA (no invokable migration, webhooks never wrote new fields); round 2 fixed both plus 3 smaller issues. Migration script exists (`npm --prefix server run migrate:status-vocabulary`) but has not run against real production data |
| W9-ONBOARDING | 1 | done | Dexter | W0-AUDIT (done) | Merged `13c8dea`, deployed. Fixed GAP-57 and GAP-59. Found a new gap (Buyer Draft-to-Active has no delivery-test gate) - see BLOCKERS.md |
| W3-UI-STATUS | 2 | ready | Dexter | W2-STATUS (done) | Its own goal predicate (check-status-vocabulary.mjs) currently fails with 80 residual hits - most are legitimately this unit's job, a few are unowned files flagged in BLOCKERS.md |
| W4-REAPER | 2 | ready | Dexter | W2-STATUS (done) | Adversarial review required. Use `isExcludedFromRedrive()` and the processed_at/leadbyte_outcome_at guidance already left in server/src/lib/leadStatus.js's comments - do not re-derive redrive-eligibility logic from scratch |
| W7-INVARIANTS | 2 | ready | Dexter | W2-STATUS (done) | Audit first, code only where missing |
| W8-CONGRUENCE | 3 | ready | Dexter | W0-AUDIT, W3-UI-STATUS | Driven by GAP-MAP |
| W10-GATEC | 4 | ready | Bossman | six units | Evidence assembly, no code |
| W11-SHADOW | 5 | ready | Digit | W10-GATEC | Freeze in effect |
| W12-CANARY | 6 | blocked | owner | W11-SHADOW | **Owner authority. No agent activates live routing** |
