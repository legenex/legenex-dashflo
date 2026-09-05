# Wave 04: Gate C packet

**Target date:** Thu 11 Sep
**Units:** W10-GATEC

## Read first

1. `forge-pack/00-intake/AUDIT.md`
2. `forge-pack/CONTRACT.md`
3. `AGENTS.md` and `docs/GROUND-TRUTH.md`
4. `forge-pack/state/HANDOFF.md`
5. Your unit in `forge-pack/03-plan/WORK-UNITS.yaml`, then only the paths in its `read_context`

Do not read the whole project. Read your unit's context.

## Why this wave exists

No code. Assemble evidence against the Gate C list in docs/HUMAN-GATES.md, including DNC all-path evidence which stands unchanged. Demonstrate the kill switch, rehearse the rollback. Any question a test could answer does not belong in the packet.

## Write ownership

Owns docs/GATE-C-PACKET.md only.

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
