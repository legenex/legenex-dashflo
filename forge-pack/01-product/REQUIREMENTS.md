# REQUIREMENTS

Stable IDs. Every requirement has a verification method and a failure consequence. Cited by work units and by `03-plan/TRACEABILITY.md`.

| ID | Requirement | Why it matters | Source | Priority | Verification | Failure consequence |
|---|---|---|---|---|---|---|
| R-DATA-01 | Lead status is exactly the seven values in D1 | Owner decision; the vocabulary drives filters, reports and connector triggers | USER | P0 | `server/test/leadStatus.test.js` | Reports and connectors disagree about what a lead is |
| R-DATA-02 | `processing_state` is a separate internal field and a crash never changes `lead_status` | Collapsing Failed into queued is only safe with this split | CONTRACT D1 | P0 | crash and restart test in W4 | Leads disappear from operator view after a crash |
| R-DATA-03 | Money is computed from `is_sold`, `sale_price_effective`, `is_returned`, `is_converted`, never from `lead_status` | Otherwise conversions silently decrement revenue | CONTRACT D2 | P0 | before and after reconciliation to the cent | Revenue drifts down quietly as conversions arrive |
| R-DATA-04 | All 1,984 existing leads migrate with zero rows on a retired value | Partial migration means two vocabularies in one table | AUDIT | P0 | migration test asserting zero | Silent reporting gaps |
| R-DATA-05 | Every connector trigger array is remapped in the same migration | `on_duplicates` and `on_received` map to retiring values | AUDIT | P0 | test asserting no trigger references a retired status | Webhooks stop firing with no error |
| R-DATA-06 | Historical `Error` leads are excluded from re-drive | Thirty code sites treat Error as terminal | AUDIT | P0 | `migrated_at` marker test | Old failures get injected into live distribution |
| R-SEC-01 | DNC enforcement remains in place and enabled, unchanged | Owner decision 4 Sep; Gate C requires DNC all-path evidence | USER | P0 | existing DNC tests pass unchanged | Suppressed leads reach buyers |
| R-SEC-02 | A DNC-suppressed lead is durably stored and takes `rejected` with `REJECTED_DNC` | Must be visible and explainable, not silently dropped | CONTRACT D3 | P0 | fixture `mva-dnc-suppressed` | Invisible suppression, no audit trail |
| R-SEC-03 | The onboarding form is rate limited, leaks no buyer existence, and exposes no internal data | Only new unauthenticated public surface | CONTRACT D9 | P0 | IDOR and tenant-leakage checks | Buyer enumeration, data exposure |
| R-OPS-01 | Stuck leads are detected and safely resumed, and unresolvable ones surface with the stage they stalled at | The backstop for no-lost-leads | CONTRACT D1 | P0 | `server/test/reapStuckLeads.test.js` | Leads sit invisible in queued forever |
| R-OPS-02 | An ambiguous delivery outcome is never auto-resumed or cascaded | Duplicate-sale prevention beats cascade volume | v1 section 19.8 | P0 | ambiguous timeout fixture | Duplicate commercial sale |
| R-OPS-03 | Only one lead can consume the final cap slot under concurrency | Cap oversell is on the never-list | v1 section 32.3 | P0 | `server/test/capRace.test.js` | Oversell and buyer dispute |
| R-OPS-04 | A repeated inbound request creates no second lead, sale, cost or routing run | Retried posts are normal | v1 section 32.1 | P0 | `server/test/idempotency.test.js` | Duplicate sale and double billing |
| R-UX-01 | Only All Leads carries a Status filter | Named defect in v1 section 3.3 | USER | P0 | `check-status-vocabulary.mjs` | Operators filter to impossible states |
| R-UX-02 | A metric with no data or an unavailable source never renders a number or a confidence score | Observed on the live Overview | SCREENSHOT | P0 | empty-state tests in W5 | The dashboard lies confidently |
| R-UX-03 | Top Rejection Reasons and Top Unsold Reasons are separate cards | Under D1 they are different problems with different owners | CONTRACT D1 | P0 | visual check in W3 | Supplier and routing problems get confused |
| R-UX-04 | Every list page shares search, filters, column controls, row actions, bulk select, empty and error states | v1 section 1.6 and 30.3 | USER | P0 | GAP-MAP closure check | The app keeps feeling unfinished |
| R-OPS-05 | Buyer cannot reach Active until required onboarding data is complete and a delivery test has passed | Prevents live routes with unproven delivery | CONTRACT D9 | P0 | `server/test/buyerOnboarding.test.js` | Live route to an untested endpoint |
| R-OPS-06 | Off-site backup replication exists or is an accepted, recorded no-op | Currently a silent no-op | AUDIT | P1 | restore from off-site copy | Single-site backup loss |
| R-GATE-01 | No agent activates live commercial routing | Owner authority | `docs/HUMAN-GATES.md` | P0 | human sign-off in CUTOVER-LOG | Uncontrolled commercial exposure |
| R-GATE-02 | Any effective price or supplier payout change on a live route is a Gate C decision item | Owner decision 4 Sep | USER | P0 | Gate C packet check | Wrong pricing bills silently |
