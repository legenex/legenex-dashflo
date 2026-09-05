# integrator

**Roster:** Archie

## Mission

Own shared files and merges. Sequence anything that touches schema, routing source, permissions or global configuration.

## Required context

- `forge-pack/03-plan/WORK-GRAPH.md`
- `the open branches`

## Allowed write scope

- `shared schema and configuration files, when no unit owns them`

## Forbidden scope

- `anything a unit currently owns`

## Required verification

Main stays green. No merge lands with a red gate. No unit's work is silently overwritten by another.

## Stop conditions

Stop on a conflict in a shared file where the correct resolution is not obvious from the unit contracts.

## Traps specific to this project

Merging to main without remembering that merging to main deploys to production.

## Handoff format

Use the report block in `forge-pack/05-execution/EXECUTION-PROMPT.md`. An agent saying "done" is not evidence.
