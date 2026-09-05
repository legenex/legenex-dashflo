# Build plan

Waves derived mechanically from the graph. A unit enters a wave only when every dependency is complete.

| Wave | Units | Concurrency | Notes |
|---|---|---|---|
| 0 | W0-AUDIT, W1-FLAGS, W5-EMPTY-STATES, W6-FIXTURES, W13-OFFSITE | 4 agents, W13 blocked on a human decision | W1 is the highest-value unit here. W0 unblocks two later units |
| 1 | W2-STATUS, W9-ONBOARDING | 2 agents | W2 alone owns the schema files. Nothing else touches them this wave |
| 2 | W3-UI-STATUS, W4-REAPER, W7-INVARIANTS | 3 agents | Disjoint trees |
| 3 | W8-CONGRUENCE | 1 agent | Driven by GAP-MAP.md |
| 4 | W10-GATEC | 1 agent | Assembly and evidence, no code |
| 5 | W11-SHADOW | 1 agent | Real traffic, commercial sending disabled |
| 6 | W12-CANARY | Human-gated | Owner approval required before any action |

## Calendar

| Date | Waves | Gate |
|---|---|---|
| Fri 5 Sep | 0 | Gap map produced, flags landed on staging |
| Sun 7 Sep | 1 | Status migration green on a restored production copy |
| Tue 9 Sep | 2, 3 | Surfaces closed |
| Thu 11 Sep | 4 | Gate C packet delivered to the owner |
| Fri 12 Sep | freeze | Fixes, tests and cutover only |
| Mon 15 Sep | 5 | Shadow clean, every discrepancy explained |
| Tue 16 Sep | 6 | First supplier live |

## Concurrency policy

Two to four agents. Not six. The shared schema is the constraint in waves 0 and 1, and the graph does not widen enough afterwards to justify more. More agents on this graph produces merge coordination, not throughput.

## If a gate slips

Re-plan against the deliverable, which is Gate C, not against the feature list. Testing is never the buffer. The buffer is W9-ONBOARDING, which drops back to post-cutover if it is not green at the freeze, and W8-CONGRUENCE, which can ship partially with the remainder deferred item by item in GAP-MAP.md.
