# Stall policy

A loop is stalled when two consecutive attempts produce no new evidence, or when the same failure recurs without a new hypothesis.

On stall:

1. Stop retrying. A third identical attempt is not persistence.
2. Write the exact failure to `state/BLOCKERS.md`: what was attempted, what happened, what was ruled out.
3. Name the smallest missing fact or decision that would unblock it.
4. Move to another unblocked unit if one exists. Idle waiting is a process failure.
5. Escalate to the owner **only** if the blocker is on the critical path and requires human authority.

Before declaring blocked, you must have: reproduced it, read the relevant code and tests and `docs/STATE.md`, searched the repo, tried at least two materially different approaches, and asked a specialist agent.

## Escalation filter

If code, tests, exports, repository history or a safe local experiment could answer the question, it is not an escalation. That rule is `docs/HUMAN-GATES.md`, and it is the reason the human path is five items long.

## Attempt limit

Three materially different approaches. Not three retries of one approach. Escalate sooner if continuing risks production, commercial exposure, or if the requirement itself turns out to be ambiguous.
