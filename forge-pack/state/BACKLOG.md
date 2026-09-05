# Backlog

Mirrors `03-plan/WORK-UNITS.yaml` in execution order. Status: `ready`, `in-progress`, `review`, `blocked`, `done`.

| Unit | Wave | Status | Owner | Depends on | Note |
|---|---|---|---|---|---|
| W0-AUDIT | 0 | done | Dexter | none | docs/GAP-MAP.md, 63 items (27 P0/32 post-cutover/4 closed). Merged `0673145`, deployed |
| W1-FLAGS | 0 | done | Dexter | none | Merged `2ca7c1a`, deployed. Independently QA'd (adversarial review found and repaired a real gap: `precedence_unverified` exception added, see PROGRESS.md). NOT yet backfilled against real production data - that remains a follow-up before any report actually switches onto these flags |
| W5-EMPTY-STATES | 0 | done | Dexter | none | Merged `16f6835`, deployed. Fixed a real bug: AI card rendered red "ANTHROPIC_API_KEY is not set" next to a fake 100% confidence score, exactly the CONTRACT.md section 3 example |
| W6-FIXTURES | 0 | done | Dexter | none | Merged `cf4dad5`+`53a86bf`, deployed. Found 3 real safety defects in client/src/lib/distribution/** (ambiguous outcomes don't stop cascade, unmatched-2xx false-accept, connection-drop misclassified) - recorded as a new unowned blocker, see BLOCKERS.md |
| W13-OFFSITE | 0 | blocked | Dexter | owner: provider choice | Raise in first digest |
| W2-STATUS | 1 | ready | Dexter | W1-FLAGS (done) | **Bottleneck.** Strongest agent, full repair budget. Should also account for the webhook.js/leadbyteWebhook.js precedence-guard gap W1-FLAGS's QA found |
| W9-ONBOARDING | 1 | ready | Dexter | W0-AUDIT (done) | Completion, not build. GAP-57/GAP-59 in docs/GAP-MAP.md are the two blocking findings: vertical never captured (dead component wired in instead of the live one), and Xero/Stripe steps throw unconditionally and block the whole pipeline despite being out of scope until after cutover |
| W3-UI-STATUS | 2 | ready | Dexter | W2-STATUS | |
| W4-REAPER | 2 | ready | Dexter | W2-STATUS | Adversarial review required |
| W7-INVARIANTS | 2 | ready | Dexter | W2-STATUS | Audit first, code only where missing |
| W8-CONGRUENCE | 3 | ready | Dexter | W0-AUDIT, W3-UI-STATUS | Driven by GAP-MAP |
| W10-GATEC | 4 | ready | Bossman | six units | Evidence assembly, no code |
| W11-SHADOW | 5 | ready | Digit | W10-GATEC | Freeze in effect |
| W12-CANARY | 6 | blocked | owner | W11-SHADOW | **Owner authority. No agent activates live routing** |
