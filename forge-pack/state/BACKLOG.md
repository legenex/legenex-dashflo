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
| W3-UI-STATUS | 2 | done | Dexter | W2-STATUS (done) | Merged `7b15563`, deployed. Deleted 4 confirmed-dead files (Leads.jsx, LeadsRejections.jsx, ExportColumnsDialog.jsx, TopRejectionReasons.jsx). Status filter now only shown on the All Leads tab |
| W4-REAPER | 2 | done | Dexter | W2-STATUS (done) | Merged `96c00cb`+repair `53d2842`+`cbb8c76`, deployed. Adversarial QA found and repaired two real gaps: bypassed kill switch, and classification not actually controlling what got resent (batch resend of ambiguous/excluded leads despite UI saying "never resumed automatically") - fixed with an `onlyLeadIds` allowlist scoping `nativeRetryRunner.js` |
| W7-INVARIANTS | 2 | done | Dexter | W2-STATUS (done) | Merged `aa17634`+boot-wiring `5a7b03c`, deployed. Full invariant-to-constraint audit (`docs/INVARIANTS.md`, 15 items scored against CONTRACT.md Section 7); closed one real gap (CapReservation had no DB-level uniqueness despite its own schema comment claiming one - added a real unique index, verified under genuine concurrency). Found 3 more real, currently unowned gaps - see BLOCKERS.md (cross-tenant RLS, audit-trail append-only, two stale schema fields) |
| W8-CONGRUENCE | 3 | ready | Dexter | W0-AUDIT, W3-UI-STATUS | Driven by GAP-MAP |
| W10-GATEC | 4 | ready | Bossman | six units | Evidence assembly, no code |
| W11-SHADOW | 5 | ready | Digit | W10-GATEC | Freeze in effect |
| W12-CANARY | 6 | blocked | owner | W11-SHADOW | **Owner authority. No agent activates live routing** |
