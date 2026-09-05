# Blockers

One entry per blocker. Delete when resolved and record the resolution in `PROGRESS.md`.

Format:

```
## <unit id>  <short title>
Blocked by:    <unit id | owner | external>
Evidence:      <what was tried, what happened, what was ruled out>
Smallest unblock:
Raised:        YYYY-MM-DD
```

---

## W13-OFFSITE  no off-site backup provider chosen
Blocked by: owner
Evidence: `deploy/backup/offsite.env` does not exist on the VPS, so the off-site sync step is a deliberate no-op. Nightly local backups run and are restore-verified.
Smallest unblock: a provider choice and a credential placed in the production secret mechanism. Alternatively an explicit decision to accept local-only backups through cutover.
Raised: 2026-09-04

## W12-CANARY  live activation is owner authority
Blocked by: owner
Evidence: `docs/HUMAN-GATES.md` Gate C. This is by design, not a defect.
Smallest unblock: owner approval of `docs/GATE-C-PACKET.md`.
Raised: 2026-09-04

## NEW-UNIT-NEEDED  three real duplicate-send / silent-cascade defects found in the live distribution engine
Blocked by: no work unit currently owns `client/src/lib/distribution/distribute.js`, `distributeRun.js` or `deliveryAttempt.js`.
Evidence: W6-FIXTURES (server/test/fixtureOutcomes.test.js, three tests explicitly named `KNOWN GAP: ...`,
verified independently against the real engine, not asserted) found, by direct execution:
  1. `distributeLead`'s per-candidate loop does not stop when one destination's outcome is ambiguous
     (e.g. a timeout) - it moves on to the next destination in the same run exactly as it would after an
     ordinary rejection. If that second destination then accepts, the run reports a clean sale with no
     trace the first destination's true outcome was ever unknown. This is precisely the double-commercial-
     send risk CONTRACT.md section 7 lists as never-acceptable at cutover.
  2. `classifyResponse` has no state between accepted/rejected for an unmatched 2xx body unless
     `requireAccept` is configured (not mandatory today) - the exact historical Walker false positive
     already recorded in `docs/STATE.md`. A destination this misclassifies is recorded as sold, never
     routed to a needs-review state.
  3. `distributeRun.js`'s `toRunStatus` only classifies a run ambiguous when an ERROR attempt's
     `error_class` is exactly `'timeout'` or `'network_error'`. A real Node/undici connection drop throws
     `"fetch failed"`, matching neither string, so it resolves `RUN.ERROR_CLEAN` (fallback-eligible)
     instead of `RUN.AMBIGUOUS` - a real request whose true outcome is unknown gets treated as a clean
     miss and is eligible for an unsafe retry/cascade.
Smallest unblock: a new bounded work unit (suggest a W4b or fold into W7-INVARIANTS' scope, both already
touch adjacent safety surface) owning exactly `client/src/lib/distribution/distribute.js`,
`distributeRun.js`, `deliveryAttempt.js` plus their tests, to: (a) stop the per-run candidate loop on any
ambiguous outcome rather than cascading, (b) make `requireAccept` mandatory or add a genuine
"needs review" classification for an unmatched 2xx, (c) broaden the ambiguous check to any ERROR attempt
with `http_status === null` rather than string-matching `error_class`. This should land and be verified
before W4-REAPER (which assumes ambiguous outcomes already surface correctly) and before Gate C.
Raised: 2026-09-05

## NEW-UNIT-NEEDED  Buyer Draft to Active has no delivery-test gate
Blocked by: no work unit currently owns `client/src/pages/operations/OperationsBuyers.jsx`'s status transition.
Evidence: W9-ONBOARDING verified, while completing D9, that D9's own acceptance line ("Draft to Active
gated on a passing delivery test") does not exist in the live code. `OperationsBuyers.jsx`'s `transition()`
is an instant status-only write (`api.entities.Buyer.update(buyer.id, { status: nextStatus })`) with no
delivery-test precondition at all - an operator can promote any Draft buyer straight to Active with zero
proof its delivery endpoint actually works. This is separate from GAP-59 (onboarding pipeline no longer
blocks on missing Xero/Stripe, fixed) and from GAP-57 (vertical capture, fixed) - both of those are done;
this one is not, and was out of W9-ONBOARDING's file ownership (`client/src/components/tables/**` is
forbidden for that unit, and OperationsBuyers.jsx's transition control lives in operations-page territory).
Smallest unblock: a small bounded unit owning `OperationsBuyers.jsx`'s transition control (or wherever the
canonical status-change action lives) plus a delivery-test call (the existing `campaignDeliveryTest.js`/
`deliveryMockSend.js` machinery from W6-FIXTURES's read context is the natural mechanism to gate on) that
blocks Draft to Active until a delivery test against that buyer's configured destination has passed.
Should land before Gate C, since D9 names this as a completion requirement, not an enhancement.
Raised: 2026-09-05

## NEW-UNIT-NEEDED  webhook.js/leadbyteWebhook.js precedence guard, and a wider unowned-file list than first thought
Blocked by: no work unit owns `server/src/functions/webhook.js` or `server/src/functions/leadbyteWebhook.js`.
Evidence: independent adversarial QA on W2-STATUS confirmed, by direct quote, that these two live write paths
set `final_status`/`lead_status` with no precedence guard at all (`webhook.js:505` unconditional
`if (status && status !== existing.final_status) { patch.final_status = status; }`; `webhook.js:604` create
branch same; `leadbyteWebhook.js`'s create branch likewise, plus a `buyer_returned` bypass at `:370-377`).
Correction to the original framing: this is **two** distinct, mutually contradictory precedence orders in
live code, not three - `leadbyteWebhook.js:19-28`'s `STATUS_PRECEDENCE` and `client/src/lib/leadIdentity.js:
112-124` are byte-identical once one array is reversed, both ranking Sold and Converted **above** Returned,
the opposite of forge-pack/CONTRACT.md D1's `returned > converted > sold` rule. W2-STATUS's own test suite
now pins this disagreement deliberately (`leadStatus.test.js`, the "DISAGREES...on purpose" test) so a
future contributor cannot silently "fix" it to match the wrong order without the test making noise - but
note that specific test only asserts `outranksStatus(RETURNED, SOLD/CONVERTED)`, it does not itself read
either contradictory array, so don't rely on it alone as proof the gap is being watched.
Separately, the QA found the "orphaned files with no owner in WORK-UNITS.yaml" problem is roughly 7x larger
than first recorded: at least 14 files reference a retired status literal with no unit owning them, not 2.
Most importantly, **`server/src/functions/testCapiConnector.js` is live, authenticated, reachable production
code** (registered as `POST /api/functions/testCapiConnector`, called from `SettingsApiConnectors.jsx:343`)
- not dead tooling as the word "orphaned" might suggest. The fuller list includes `webhook.js`,
`leadbyteWebhook.js`, `SettingsApiConnectors.jsx`, `WebhookDeliverySettings.jsx` (which also *writes* a
fallback trigger config hardcoding the old key), `client/src/lib/distribution/distribute.js` (inside a
directory W3-UI-STATUS's own `files_forbidden` explicitly excludes it from touching), `PayloadTester.jsx`,
`CsvImporter.jsx`, `postingSpec.js`, `TriggerDataOverrides.jsx`, and `spec.js`.
Smallest unblock: a bounded unit (or two - the precedence guard and the trigger-literal cleanup are
separable) owning `webhook.js` and `leadbyteWebhook.js` to add an actual precedence check on every
final_status write (matching D1's order, reconciling which of the two existing wrong orders it replaces),
and a pass across the ~14-file list above to migrate every hardcoded old-style trigger key to the new
canonical ones now that W2-STATUS's dual-spelling shim exists as a bridge. Needs to land before the shim
(`leadStatus.js`'s `TRIGGER_ALIASES`) can ever be removed, and before Gate C - `testCapiConnector.js` being
live means this isn't cleanup, it's a real user-facing surface still speaking the old vocabulary.
Raised: 2026-09-05
