# AgentOS Runbook

## Install

Place this project pack in the AgentOS project context and copy `forge-pack/` into the DashFlo repository root on the working branch if it is not already present. The pack is documentation, state and deterministic verification helpers.

## Start once

Bossman reads the outer `agentos/` contract and `bootstrap/START-AGENTOS.md`, reconciles the existing DashFlo project context, Kanban and `#dashflo`, then starts the highest-priority unblocked units from `03-plan/WORK-UNITS.yaml`.

Nick does not paste Wave 0 or later wave prompts.

## Resume after any context reset

Read, in order:

1. `state/HANDOFF.md`
2. `state/BLOCKERS.md`
3. `state/BACKLOG.md`
4. current unit in `03-plan/WORK-UNITS.yaml`
5. Hermes DashFlo Kanban

Reconcile against live repo/test evidence. Do not reconstruct project state from Buzz history.

## Execution

For each unit:

1. assign the correct permanent specialist
2. use the approved repo-capable coding path
3. respect `files_owned` / `files_forbidden`
4. run the goal predicate
5. run the required gate
6. hand to the named independent evaluator
7. repair bounded findings
8. update repo state and Hermes Kanban
9. automatically unlock the next dependency-satisfied unit

## Blockers

After two attempts with no new evidence, stop retrying, record the blocker and continue another independent unit. Reach Nick only if the critical path requires his authority.

## Production

Use the established GitHub/deployment path and live runtime evidence. Do not invent a parallel production deployment mechanism. Code deployment and commercial activation are separate. Gate C approval is required for live commercial routing.

## Human authority

See `03-plan/HUMAN-PATH.md`, repository `docs/HUMAN-GATES.md`, and outer `agentos/AUTONOMY-AND-APPROVALS.md`.

## Incident rule

If production degrades, prefer the proven rollback/kill switch over a forward fix through a red gate. Preserve lead durability and evidence.
