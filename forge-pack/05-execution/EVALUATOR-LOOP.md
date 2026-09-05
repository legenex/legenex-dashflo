# Evaluator loop

The agent that wrote the code never decides alone whether it is good.

When a goal predicate passes, hand to the evaluator named on the unit. Evaluators are defined in `forge-pack/agents/`.

The evaluator assumes there is a defect until evidence says otherwise, and checks:

- Requirement traceability: does this actually satisfy the cited requirement
- Acceptance behaviour against `01-product/ACCEPTANCE.md`
- Regression risk in adjacent behaviour
- State transitions, especially anything touching `lead_status` or `processing_state`
- Data durability and idempotency where money or leads are involved
- Security boundaries and tenant isolation
- Error handling and the unhappy paths, not just the happy one
- Test quality: does the test fail when the behaviour is broken
- Unverified claims in the report

Verdict is `PASS`, `FAIL` or `BLOCKED`.

- `PASS` must cite evidence. A verdict with no artefact is not a pass.
- `FAIL` becomes bounded repair items, highest severity first, back through the goal loop.
- `BLOCKED` must name exactly what evidence is unavailable and why.

## Repair budget

Three repair cycles for a normal unit, five for units marked `risk: high` or `critical`. If the budget is exhausted, the unit is blocked and the unresolved evidence is surfaced. Endless reviewer churn is a failure mode, not diligence.

## Mandatory adversarial review

These units may not be self-approved and require the named specialist evaluator regardless of how small the diff looks: W1-FLAGS, W2-STATUS, W4-REAPER, W7-INVARIANTS, W9-ONBOARDING, W10-GATEC, W11-SHADOW, W12-CANARY.
