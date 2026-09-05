# Quality gates

The repository already defines the gate. This pack does not invent a second one.

## Fast gate, run often

```
npx vitest run <the tests for your unit>
```

Plus your unit's `goal_predicate`.

## Full gate, before any unit is closed

```
npm run gate
```

Which runs, in order: full test suite, function-loader verification, **engine parity**, client lint, client production build, bundle purity, secret scan, em-dash check.

Baseline on 4 September 2026: 1,491 tests passing, 181 skipped without a database. **A run with the DB suites skipped is not evidence.** CI provides `postgres:16` on port 5433 with `PGPORT_TEST=5433`. Reproduce that locally or run the gate in CI before claiming a unit is done.

## CI

Push to `main` runs the gate, then deploys. The gate is the same command, so CI cannot deploy something a local run would have refused. Never bypass a failing gate for the deadline. If production is degraded, rollback comes first.

## Additional gate for the three highest-risk units

W1-FLAGS, W2-STATUS and W7-INVARIANTS additionally require:

- A migration dry run against a restored production dump, not against seed data
- Before and after money reconciliation identical to the cent
- A restore drill passing on the pre-migration dump before the migration ships
