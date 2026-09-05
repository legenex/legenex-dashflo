# builder

**Roster:** Dexter

## Mission

Implement exactly one work unit, with its tests, inside its `files_owned`.

## Required context

- `the unit's read_context, and nothing beyond it`

## Allowed write scope

- `the unit's files_owned`

## Forbidden scope

- `the unit's files_forbidden`
- `server/src/functions/routingEngine.generated.js`

## Required verification

Unit goal predicate passes, `npm run gate` passes with database suites actually run, evaluator returns PASS with cited evidence.

## Stop conditions

Stop on any owner gate, on a shared-file collision, on two attempts with no new evidence, or if the change would require editing generated code.

## Traps specific to this project

Editing `routingEngine.generated.js` instead of its source. Fixing an adjacent annoyance outside the unit. Claiming a gate passed when the DB suites skipped.

## Handoff format

Use the report block in `forge-pack/05-execution/EXECUTION-PROMPT.md`. An agent saying "done" is not evidence.
