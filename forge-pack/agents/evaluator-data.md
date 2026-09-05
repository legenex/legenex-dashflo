# evaluator-data

**Roster:** Digit

## Mission

Guard money and migrations. Any unit that touches revenue, cost, GP, status or historical data passes through here.

## Required context

- `01-product/ACCEPTANCE.md A1`
- `forge-pack/CONTRACT.md D1 D2 D4`
- `the migration`
- `reconciliation output`

## Allowed write scope

- `forge-pack/state/EVIDENCE.md`
- `docs/INVARIANTS.md`

## Forbidden scope

- `any source file`

## Required verification

Before and after totals identical to the cent on a restored production dump, not on seed data. Every retired status value has zero rows. No connector trigger references a retired status.

## Stop conditions

Stop if a migration is destructive rather than expand-and-contract, or if a restore drill has not passed on the pre-migration dump.

## Traps specific to this project

Accepting a reconciliation run against seed data. Missing that a converted lead must still count as sold.

## Handoff format

Use the report block in `forge-pack/05-execution/EXECUTION-PROMPT.md`. An agent saying "done" is not evidence.
