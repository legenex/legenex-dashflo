# Traceability

Requirement to unit to acceptance to evidence. No orphans in either direction.

| Requirement | Unit | Acceptance | Evidence artefact |
|---|---|---|---|
| R-DATA-01 | W2-STATUS | A1, A9 | `leadStatus.test.js` output |
| R-DATA-02 | W2-STATUS, W4-REAPER | A2 | crash and restart transcript |
| R-DATA-03 | W1-FLAGS | A1 | before and after reconciliation |
| R-DATA-04 | W2-STATUS | A1 | migration row counts |
| R-DATA-05 | W2-STATUS | A7 | connector remap report |
| R-DATA-06 | W2-STATUS, W4-REAPER | A2 | `migrated_at` exclusion test |
| R-SEC-01 | W2-STATUS | A6 | existing DNC all-path test output, unchanged |
| R-SEC-02 | W2-STATUS, W6-FIXTURES | A6 | fixture `mva-dnc-suppressed` |
| R-SEC-03 | W9-ONBOARDING | A10 | IDOR and tenant-leakage output |
| R-OPS-01 | W4-REAPER | A2 | reaper test output |
| R-OPS-02 | W4-REAPER, W6-FIXTURES | A3 | ambiguous timeout fixture |
| R-OPS-03 | W7-INVARIANTS | A4 | `capRace.test.js` output |
| R-OPS-04 | W7-INVARIANTS | A5 | `idempotency.test.js` output |
| R-UX-01 | W3-UI-STATUS | A9 | `check-status-vocabulary.mjs` |
| R-UX-02 | W5-EMPTY-STATES | A8 | screenshots at empty, stale, healthy |
| R-UX-03 | W3-UI-STATUS | A9 | Overview screenshot |
| R-UX-04 | W8-CONGRUENCE | none directly, GAP-MAP closure | GAP-MAP closed items |
| R-OPS-05 | W9-ONBOARDING | A10 | onboarding test output |
| R-OPS-06 | W13-OFFSITE | none directly | restore-from-off-site drill |
| R-GATE-01 | W12-CANARY | A11, A12 | owner sign-off in CUTOVER-LOG |
| R-GATE-02 | W10-GATEC | A11 | Gate C packet pricing section |

Every unit traces to at least one requirement. W0-AUDIT is the exception and exists to size R-UX-04 and R-OPS-05 before they are planned, which is a risk-reduction objective rather than a requirement.
