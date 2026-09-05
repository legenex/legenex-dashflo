# Wave 01: The status migration

**Target date:** Sun 7 Sep
**Units:** W2-STATUS, W9-ONBOARDING

## Read first

1. `forge-pack/00-intake/AUDIT.md`
2. `forge-pack/CONTRACT.md`
3. `AGENTS.md` and `docs/GROUND-TRUTH.md`
4. `forge-pack/state/HANDOFF.md`
5. Your unit in `forge-pack/03-plan/WORK-UNITS.yaml`, then only the paths in its `read_context`

Do not read the whole project. Read your unit's context.

## Why this wave exists

W2-STATUS is the bottleneck of the whole plan and carries risks 1, 2 and 4. Give it the strongest agent and the full repair budget. It runs alone against the schema files; W9-ONBOARDING is deliberately the only other unit in this wave because it touches a disjoint tree.

## Write ownership

W2-STATUS owns every schema file plus processLead.js and intake.js. W9-ONBOARDING owns the onboarding functions and client/src/pages/onboarding only.

Two agents in this wave never write the same path. If you need a file you do not own, stop and record it in `state/BLOCKERS.md`.

## Human prerequisites

See `forge-pack/03-plan/HUMAN-PATH.md`. If a unit in this wave has `human_input: REQUIRED`, deliver the packet and move to another unit. Do not wait.

## Acceptance and predicates

Each unit's `acceptance_steps` and `goal_predicate` are in `WORK-UNITS.yaml`. Cross-referenced in `forge-pack/06-qa/ACCEPTANCE-MATRIX.md`.

Run the unit predicate, then `npm run gate`. A gate run with the database suites skipped is not evidence.

## Evaluator

Named per unit. The builder never passes its own work. See `forge-pack/05-execution/EVALUATOR-LOOP.md`.

## Stop conditions

- Two attempts with no new evidence: `forge-pack/05-execution/STALL-POLICY.md`
- Any owner gate in `docs/HUMAN-GATES.md`
- Any risk of a destructive production action, a duplicate commercial send, or credential exposure

## State to update before you finish

`state/PROGRESS.md`, `state/EVIDENCE.md`, `state/BACKLOG.md`, and `state/HANDOFF.md`. Append to `state/DECISIONS.md` if you made a call the contract did not cover.

## Do not claim completion without evidence

A passing command with its output is evidence. "Done" is not. Finish with the report format in `forge-pack/05-execution/EXECUTION-PROMPT.md`.
