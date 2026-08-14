# Human gates

Claude should not ask Bru for ordinary engineering choices. Use these gates only when human authority, live access, or an irreversible business decision is required.

## Gate A: workspace control

Required before integrating autonomous work with `main`.

Claude provides:

- current and audited commits;
- evidence of the hourly auto-sync or other writer;
- recommended pause or branch isolation method;
- delta summary if `main` moved.

Bru decides:

1. Pause the upstream auto-sync for the cutover period, recommended.
2. Keep it running but quarantine its commits on a separate branch.

Claude can continue on an isolated branch while waiting. It cannot safely merge to a branch still being rewritten by an automated upstream process.

## Gate B: configuration and credentials

Required only after automated recovery has produced an exception list.

Claude provides one packet containing:

- recovered buyers, suppliers, campaigns, routes, prices, caps, schedules, and endpoint counts;
- unresolved business ambiguities with a recommended answer for each;
- credential reference names that must be populated, never values;
- supplier response contracts that cannot be inferred from fixtures or history;
- any proposed change to the under-five-second accepted or rejected response contract;
- keys that need rotation because the current storage model may have exposed them.

Bru supplies decisions and places credentials directly into the approved production secret mechanism. Credentials are never pasted into chat, spreadsheets, issues, commits, or test fixtures.

Claude continues all work that uses mocks and placeholder references while waiting.

## Gate C: live staging and first supplier cutover

Required before live external calls, production data imports, deploys, money writes, or native delivery.

Claude provides:

- green root gate at an exact commit;
- independent general and security reviews;
- authorization matrix;
- receipt crash and replay evidence;
- DNC all-path evidence;
- routing and shadow discrepancy report;
- portal isolation evidence;
- delivery and billing idempotency evidence;
- migration and monetary reconciliation;
- backup restore drill;
- load and latency results;
- first-supplier manifest, success thresholds, kill switch, and rollback.

Bru approves specific actions, environment, time window, and first supplier. Approval for one action does not imply approval for every later supplier.

## Gate D: broader cutover and retirement

Required after the first supplier has run for the agreed observation period.

Claude provides:

- first-supplier lead counts and outcomes against source totals;
- latency, backlog, delivery, return, and ledger reconciliation;
- incidents and resolved discrepancies;
- recommended next suppliers and observation windows;
- Base44 and LeadByte retirement checklist;
- data retention and rollback implications.

Bru approves the next tranche and, eventually, retirement of the old systems.

## Decision packet template

```
GATE: <A, B, C, or D>
WHY NOW:
RECOMMENDATION:
DECISIONS REQUIRED:
1. <decision, recommended option, consequence>
CREDENTIAL REFERENCES REQUIRED:
EVIDENCE:
WORK CONTINUING WITHOUT BRU:
BLOCKED WORK:
```

If the packet contains a question that code, tests, exports, repository history, or a safe local experiment could answer, it is not ready to send.
