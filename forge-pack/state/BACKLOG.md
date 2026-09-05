# Backlog

Mirrors `03-plan/WORK-UNITS.yaml` in execution order. Status: `ready`, `in-progress`, `review`, `blocked`, `done`.

| Unit | Wave | Status | Owner | Depends on | Note |
|---|---|---|---|---|---|
| W0-AUDIT | 0 | ready | Sherlock | none | Read-only. Produces docs/GAP-MAP.md |
| W1-FLAGS | 0 | ready | Dexter | none | Highest value in wave 0. Must land before W2 |
| W5-EMPTY-STATES | 0 | ready | Dexter | none | Client only |
| W6-FIXTURES | 0 | ready | Dexter | none | Test only |
| W13-OFFSITE | 0 | blocked | Dexter | owner: provider choice | Raise in first digest |
| W2-STATUS | 1 | ready | Dexter | W1-FLAGS | **Bottleneck.** Strongest agent, full repair budget |
| W9-ONBOARDING | 1 | ready | Dexter | W0-AUDIT | Completion, not build |
| W3-UI-STATUS | 2 | ready | Dexter | W2-STATUS | |
| W4-REAPER | 2 | ready | Dexter | W2-STATUS | Adversarial review required |
| W7-INVARIANTS | 2 | ready | Dexter | W2-STATUS | Audit first, code only where missing |
| W8-CONGRUENCE | 3 | ready | Dexter | W0-AUDIT, W3-UI-STATUS | Driven by GAP-MAP |
| W10-GATEC | 4 | ready | Bossman | six units | Evidence assembly, no code |
| W11-SHADOW | 5 | ready | Digit | W10-GATEC | Freeze in effect |
| W12-CANARY | 6 | blocked | owner | W11-SHADOW | **Owner authority. No agent activates live routing** |
