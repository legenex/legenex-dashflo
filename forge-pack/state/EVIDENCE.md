# Evidence

Test results, migration dry runs, screenshots, reconciliations, evaluator verdicts. Anything cited as proof lives here or is linked from here.

Format:

```
## YYYY-MM-DD  <unit id>  <what was proved>
Command:
Result:
Artefact:
Evaluator verdict:
```

---

## 2026-09-04  baseline  repository test and gate baseline
Command: `npx vitest run`
Result: 1,491 passing, 181 skipped, 144 files. The 181 skips are database-dependent suites; CI runs them against `postgres:16` on port 5433.
Artefact: `forge-pack/00-intake/AUDIT.md`
Evaluator verdict: baseline accepted. Any future run showing fewer than 1,491 passing is a regression until proven otherwise.

## 2026-09-04  baseline  production is commercially dormant
Command: verified entries in `docs/STATE.md`
Result: 0 active RouteGroup rows. `e_lead` 1,984, `e_buyer` 13, `e_supplier` 5, 101 tables. `NATIVE_RETRY_WORKER_ENABLED` absent, `BASE44_SYNC_ENABLED=0`.
Artefact: `forge-pack/00-intake/AUDIT.md`
Evaluator verdict: this is the fact that defines the project. Nothing is routing.

## 2026-09-04  W2 and W3 sizing  the status change is 138 references, not a rename
Command: `node forge-pack/scripts/check-status-vocabulary.mjs` run against the clone at `f89b2e8`
Result: 138 retired status references across client and server. Concentrations: `server/src/functions/processLead.js` (approximately 30), `client/src/lib/leadStatus.js`, `client/src/lib/tagColors.js`, `client/src/lib/distributionMetrics.js`, `client/src/lib/overviewFinance.js`, `client/src/components/overview/*`, `client/src/pages/LeadsRejections.jsx`.
Notable findings that change the plan:
  - `client/src/lib/leadStatus.js` already exists and is the status vocabulary module. W3 edits it rather than creating a new one.
  - `client/src/pages/LeadsRejections.jsx` currently defines `REJECTED_STATUSES = ['Unsold','Duplicate','Error']`, which directly contradicts CONTRACT D1. It is a rename plus a semantic change, not a find and replace.
  - `processLead.js:635` holds the status to trigger map, and `BUILTIN_LEAD_STATUSES` at line 633 is the server-side vocabulary. Both are single points that the migration must update together.
  - `client/src/lib/distribution/distribute.js:151` sets `finalStatus = 'Duplicate'` inside the canonical engine source. Changing it regenerates the backend engine, so the parity check will be involved.
Artefact: this scan is reproducible; the script is the W3 goal predicate and currently exits 1, which is correct pre-migration.
Evaluator verdict: accepted as sizing evidence. W2 and W3 are larger than a rename and smaller than a rewrite.
