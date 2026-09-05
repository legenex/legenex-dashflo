# Progress

Append one entry per session. Newest at the bottom. Keep entries short: outcomes, not narration.

Format:

```
## YYYY-MM-DD  <unit id>
Attempted:
Changed:
Verified:      <command and result>
Remains:
Next unit:
```

---

## 2026-09-04  pack created
Attempted: consolidate v1, v2 and v2.1 into one contract and generate an execution pack.
Changed: `forge-pack/` created. No application code touched.
Verified: work graph validated acyclic, 14 units, 7 waves, no shared write ownership within a wave.
Remains: everything in `state/BACKLOG.md`.
Next unit: W0-AUDIT and W1-FLAGS in parallel.

## 2026-09-05  Wave 0 (W0-AUDIT, W1-FLAGS, W5-EMPTY-STATES, W6-FIXTURES)
Attempted: installed forge-pack into the repo (`3c65720`); dispatched all four Wave 0 units in
parallel, each in its own worktree/branch with exclusive file ownership; independently reviewed
and merged each to `main` (builder never certified its own work).
Changed:
- `docs/GAP-MAP.md` added (`0673145`): 63 items, 27 P0, 32 post-cutover, 4 closed. Two P0 findings
  block W9-ONBOARDING directly: GAP-57 (the onboarding form's vertical field is dead code, the
  wired form has no vertical field at all, so D9's "per-vertical form" is unmet) and GAP-59
  (`onboardBuyer.js`'s Xero/Stripe steps throw unconditionally with no credential, blocking every
  downstream in-scope onboarding step, even though D9 defers Xero/Stripe past cutover).
- `client/src/components/overview/**`, `Overview.jsx` fixed (`16f6835`): Revenue/CPL/Profit now
  show explicit no-data states on an empty lead table instead of `$0`; the AI Analyst card no
  longer renders a red `"ANTHROPIC_API_KEY is not set"` error (now a quiet not-configured message
  linking to Settings > API Keys) - a real, live bug matching CONTRACT.md section 3's exact
  example; Data Quality now shows "Unavailable" (linked to Settings > Data Sources) instead of a
  false 100% score when feeds are stale/empty.
- `server/test/fixtures/**`, `fixtureOutcomes.test.js` added (`cf4dad5`): 13 named synthetic
  fixtures run through the real distribution engine end to end. Found and pinned (as documented
  `KNOWN GAP` tests, not fixed - out of scope, owned by no current unit) three real safety defects
  in `client/src/lib/distribution/{distribute,distributeRun,deliveryAttempt}.js`: an ambiguous
  outcome does not stop cross-destination cascade in the same run (duplicate-sale risk), an
  unmatched 2xx response defaults to accepted without `requireAccept` configured (the historical
  Walker false positive), and a real connection drop's `error_class` ("fetch failed") does not
  match the ambiguous-classification whitelist, so it resolves as a clean fallback-eligible miss
  instead. Recorded in `BLOCKERS.md` as a new unowned unit needed before W4-REAPER/Gate C.
- `server/src/schemas/entities/Lead.json`, `server/src/db/schema.js`, `server/src/lib/leadFlags.js`,
  `server/test/leadFlags.test.js` added (`2ca7c1a`, D2): 8 immutable derived money flags
  (is_sold/sold_at/sale_price_effective/is_returned/returned_at/is_converted/converted_at/
  conversion_type), enforced write-once at both the app layer and a Postgres trigger. Independent
  adversarial QA proved the trigger genuinely holds (raw-SQL probes, 13 assertions) and found one
  real blocking gap before repair: `webhook.js`/`leadbyteWebhook.js`'s create paths can write
  Converted/Returned with no prior Sold and no precedence guard, which combined with permanent
  immutability could lock a wrong `is_sold=true` in forever. Repaired (`20e1e76`, same session)
  with a `precedence_unverified` backfill exception that surfaces every such row for human review
  instead of silently trusting it - `is_sold` semantics themselves were not redesigned (out of
  scope; the actual fix needs a precedence guard in webhook.js/leadbyteWebhook.js, not owned by
  this unit). QA also found the reconciliation tests' baseline didn't match the actual primary
  revenue calculation (`overviewFinance.js`/`reportMetrics.js` sum revenue unconditionally, never
  exposed to the D2 drift; only `partnerMetrics.js`'s buyerMetrics and a secondary `booked_revenue`
  stat use the vulnerable Sold-only filter) - reworded to be accurate rather than overstated.
Verified: `npm run gate` green at every merge (`LC_ALL=en_US.UTF-8` - this Mac's `en_ZA` default
locale otherwise fails one unrelated, pre-existing number-formatting test, invisible in CI).
GitHub Actions deployed every merge to production successfully (one transient, self-resolving
deploy-race failure from pushing two commits within seconds of each other - the remote script's
own SHA-match safety check caught it correctly; the very next run succeeded and production health
was reconfirmed at the correct commit; not a code defect).
Remains: W13-OFFSITE still blocked on Nick (backup provider choice). The webhook.js precedence
gap and the three distribution-engine safety defects are new, currently unowned findings that
should get their own bounded units before Gate C - see `BLOCKERS.md`.
Next unit: Wave 1 - W2-STATUS and W9-ONBOARDING, both now unblocked.
