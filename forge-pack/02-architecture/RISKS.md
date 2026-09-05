# RISKS

Ranked by expected damage, not by likelihood alone.

| # | Risk | Why it is credible | Mitigation | Owner |
|---|---|---|---|---|
| 1 | The status migration silently changes historical revenue | 1,984 leads change status; money queries currently read status | W1-FLAGS lands first; A1 requires identical totals to the cent before and after | W1, W2 |
| 2 | Connector triggers stop firing after the migration | `on_duplicates` and `on_received` map to retiring values, and a trigger matching nothing throws no error | Remap in the same migration; test asserting no trigger references a retired status | W2 |
| 3 | A duplicate commercial sale during the canary | Ambiguity after a timeout is the classic cause | A3, R-OPS-02, existing receipts and idempotency, no auto-resume on ambiguous | W4, W7, W12 |
| 4 | Historical `Error` leads get re-driven into live distribution | Thirty code sites treat Error as terminal; under D1 those leads become recoverable | `migrated_at` marker excluded by the reaper | W2, W4 |
| 5 | Someone deletes working capability to hit the date | The v2 draft did exactly this with ZIP, county and weekly caps before the audit | D5: grep the REASON map and schemas before deferring anything | Orchestrator |
| 6 | Scope creep past the freeze | Twelve days, and onboarding just came back into scope | D11 freeze on 12 Sep applies to the owner as well | Orchestrator |
| 7 | The onboarding public endpoint leaks buyer existence | Only new unauthenticated surface | R-SEC-03, A10, existing IDOR checks | W9 |
| 8 | Agents burn the window rediscovering project state | v1 described a system that does not match the code | `00-intake/AUDIT.md` is read before anything else | All |
| 9 | Off-site backup stays a silent no-op through cutover | `offsite.env` absent, easy to forget | W13, and it is on the human path | Owner |
| 10 | Parallel agents collide on shared schema files | `Lead.json` and `db/schema.js` are touched by two units | W1 and W2 are sequenced, never concurrent; `files_owned` is exclusive | Orchestrator |
