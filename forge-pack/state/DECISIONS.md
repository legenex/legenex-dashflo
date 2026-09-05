# DECISIONS

The binding decisions are D1 to D11 in `CONTRACT.md` section 4. They are not duplicated here, so there is one source of truth.

This file records decisions made **during execution** that change or clarify the locked plan. Append only. Each entry: date, decision, alternatives considered, evidence, who decided.

Format:

```
## YYYY-MM-DD  <short title>
Decision:
Alternatives:
Evidence:
Decided by:  <agent id | owner>
Contract impact:  <none | amends CONTRACT section X>
```

---

## 2026-09-04  DNC removal withdrawn
Decision: DNC stays exactly as built, enabled, with its tests and its Gate C evidence line unchanged. A suppressed lead maps to `rejected` with `REJECTED_DNC`.
Alternatives: disable behind a flag; delete.
Evidence: owner instruction, 4 September. `docs/HUMAN-GATES.md` Gate C requires DNC all-path evidence.
Decided by: owner
Contract impact: CONTRACT D3.
