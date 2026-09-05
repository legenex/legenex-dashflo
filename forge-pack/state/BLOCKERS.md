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

## NEW-UNIT-NEEDED  cross-buyer / cross-supplier data leakage has no DB-tier boundary
Blocked by: no work unit owns this; it is an architecture change, not an additive constraint.
Evidence: W7-INVARIANTS' full invariant audit (`docs/INVARIANTS.md` item 12) found the entire enforcement
surface is `server/src/lib/entityPolicy.js` (role resolution, per-entity read/write authorization, field
projection) called from `server/src/routes/entities.js`. Every entity lives in a generic `e_<name>` JSONB
table queried through one shared, service-role Postgres connection (`server/src/db/pool.js`), with no
Postgres row-level security policy scoping rows to a buyer or supplier session. A bug in `entityPolicy.js`,
a new route that forgets to call it, or a raw query would see every buyer's and every supplier's rows with
no database-level boundary at all. This is real and reasonably careful application-layer authorization
today, not a live exploit, but it is the only layer.
Smallest unblock: not closeable by an additive index/trigger the way items 1-7 in `docs/INVARIANTS.md` were.
Needs its own work unit with its own risk review to design either Postgres RLS policies keyed to a session
variable set per request, or splitting cross-tenant tables. Should be scoped and risk-reviewed before Gate C
commits to the current single-connection-role architecture at scale, though it does not block the units
already in flight.
Raised: 2026-09-05

## NEW-UNIT-NEEDED  DeliveryAttempt/RouteDecisionTrace have no DB-level append-only guarantee
Blocked by: no work unit owns this.
Evidence: W7-INVARIANTS' audit (`docs/INVARIANTS.md` item 13) found the commercial audit trail
(`DeliveryAttempt`, `RouteDecisionTrace`) is written at the right points, but nothing at the database level
stops a later `UPDATE`/`DELETE` against either table - `Repo.update()`/`Repo.delete()` work identically on
these as on any other entity. No code path currently rewrites or deletes either table after the fact (the
audit searched `server/src` for such a call and found none), so there is no live exploit today, but nothing
would prevent one being introduced later.
Smallest unblock: a focused unit adding a trigger that refuses `UPDATE`/`DELETE` once a row reaches a
terminal state, mirroring the pattern `lead_flags_write_once_trg` (W1-FLAGS) already establishes. Needs its
own review of which terminal states should lock each table; not folded into W7-INVARIANTS since this wasn't
one of that unit's named acceptance steps (cap-race and replay were).
Raised: 2026-09-05

## NEW-UNIT-NEEDED  ApiKey.json legacy raw_key field still purgeable; CapReservation.json state enum is stale
Blocked by: both are schema edits, and `server/src/schemas/**` was forbidden to W7-INVARIANTS.
Evidence: `docs/INVARIANTS.md` items 5 and 11. (a) `ApiKey.json`'s own comment calls `raw_key` "LEGACY
cleartext key. Retained only until the hash path is proven against real supplier traffic, then purged" -
`key_hash` (SHA-256) is already the credential of record (`server/src/lib/apiKeys.js:123`); this is a
still-open cleanup, not a new finding, but no unit currently owns closing it. (b) `CapReservation.json`'s
`state` enum lists only `reserved`/`finalized`/`released`, but `client/src/lib/distribution/reservation.js:
45-49` writes `state: 'failed'` on a cap-exceeded attempt - functionally harmless (the JSONB column has no
CHECK enforcing the enum either way) but the schema's own documentation disagrees with the code that writes
it.
Smallest unblock: a small bounded unit touching only these two schema files - purge `raw_key` (once the hash
path's production track record supports it) and add `'failed'` to `CapReservation.json`'s `state` enum.
Low risk, not blocking Gate C, but should not be forgotten.
Raised: 2026-09-05
