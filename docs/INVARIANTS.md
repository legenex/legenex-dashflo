# Invariant to constraint audit

Work unit W7-INVARIANTS, forge-pack/03-plan/WORK-UNITS.yaml, contract ref
Section 7. For each commercial invariant this codebase actually depends on,
this records which database constraint or single-statement claim enforces it,
with a file and line citation, or says plainly that none does.

Read against the current code at commit `a07130e` plus the two units merged
immediately before this one: W1-FLAGS (the `lead_flags_write_once` trigger in
`server/src/db/schema.js`) and W2-STATUS (`server/src/lib/leadStatus.js`).

## How to read the enforcement tier

- **DB constraint.** A UNIQUE index, a CHECK constraint, a trigger, or a
  foreign key. Holds even against a bug in application code or a raw SQL
  statement run outside the app entirely. This is the strong tier.
- **App-only.** A check inside a function, a runtime assertion. Real, and
  sometimes the right tool, but a different code path that does not call
  through the same function can bypass it. Weaker tier.
- **Gap.** Nothing enforces it today, in either tier.

Section 7 of `forge-pack/CONTRACT.md`, verbatim, is the list this audit is
scored against: lost leads, duplicate commercial sends or sales, dedupe
failure, wrong routing, cap oversell, incorrect sale price, revenue, cost or
gross profit, insecure secrets, cross-buyer or cross-supplier data leakage,
untraceable commercial actions, unsafe retries, silent processing failures,
corrupted production data, or inability to roll back safely.

## Summary table

| # | Invariant | Tier | Enforcing constraint |
|---|---|---|---|
| 1 | Transport-level dedupe (a retried post is not processed twice) | DB constraint | `lead_receipts.transport_key UNIQUE` |
| 2 | A receipt cannot claim "concluded" with no recorded outcome | DB constraint | `lead_receipts_terminal_coherent` CHECK |
| 3 | A receipt's status is always one of four known values | DB constraint | `lead_receipts_status_check` CHECK |
| 4 | Cap oversell (a cap counter never exceeds its limit) | DB constraint | `e_cap_counter` unique index on `scope_key` + CAS `UPDATE` |
| 5 | Duplicate commercial sale via a duplicate cap reservation | **Was a gap, now closed** | new `e_cap_reservation` unique index on `(idempotency_key, route_member_id)` |
| 6 | A lead is sold to at most one buyer (the winner claim) | DB constraint (derived) | same `e_cap_counter` unique index, used as a claim primitive |
| 7 | Money never un-sells itself (`is_sold`, `sale_price_effective`, etc. are write-once) | DB constraint | `lead_flags_write_once_trg` trigger |
| 8 | `lead_status`/`processing_state` writes never touch a money field | App-only | `assertNoMoneyFieldWritten` in `leadStatus.js` |
| 9 | Business duplicate-lead detection (same person, different submission) | App-only, by design | identity match in `leadStatus.js`; not DB-constraint-shaped, see below |
| 10 | Wrong routing (the routing engine picks the correct destination) | Not constraint-shaped | pure-function test coverage + engine-parity gate, see below |
| 11 | Supplier API keys are hash-only at rest | Convention, not enforced | `ApiKey.json` schema comment; no CHECK forbids the legacy field |
| 12 | Cross-buyer / cross-supplier data leakage | App-only, real gap for a DB tier | `server/src/lib/entityPolicy.js` |
| 13 | Untraceable commercial actions (audit trail integrity) | App-only, partial | `DeliveryAttempt`/`RouteDecisionTrace`, no DB immutability |
| 14 | Unsafe retries (a retried delivery attempt does not double-send or double-bill) | DB constraint (via #5) + app-only pre-check | reservation claim + `isLeadAlreadySold` |
| 15 | Silent processing failures | DB constraint | same `lead_receipts_terminal_coherent` CHECK as #2 |

Each is expanded below with citations.

## 1. Transport-level dedupe

**Tier: DB constraint.**

`server/src/db/receiptSchema.js:57`, `transport_key TEXT NOT NULL UNIQUE` on
`lead_receipts`. `server/src/lib/receipts.js:158-178`'s `commitReceipt()`
inserts with `ON CONFLICT (transport_key) DO NOTHING` and re-reads the
existing row on conflict, so two concurrent posts of the same key cannot both
create a receipt. This is not a read-then-write in application code; the
uniqueness is the database's.

Proven live by `server/test/durableReceipt.test.js`'s own "survives a
concurrent double post of the same key" test, and re-proven here through the
real inbound entry point by `server/test/idempotency.test.js`, Group A: a
sequential retry, a retry carrying an explicit client `Idempotency-Key`, and a
genuinely concurrent double post (`Promise.all`, not sequential awaits) each
create exactly one `Lead` row and exactly one `lead_receipts` row.

## 2 and 15. A receipt cannot go silent

**Tier: DB constraint.**

`server/src/db/receiptSchema.js:91-95`:

```sql
CONSTRAINT lead_receipts_terminal_coherent
  CHECK (
    (status IN ('done', 'failed') AND terminal_outcome IS NOT NULL)
    OR (status IN ('received', 'claimed') AND terminal_outcome IS NULL)
  )
```

A row cannot be marked concluded without recording what it concluded to. This
is what makes "silently dropped" (Section 7's own phrase) unrepresentable at
the database level, not merely undocumented in application code. Exercised
directly in `server/test/durableReceipt.test.js` ("rejects a terminal row with
no outcome at the database level").

## 3. A receipt's status is one of four values

**Tier: DB constraint.** `server/src/db/receiptSchema.js:86-87`,
`lead_receipts_status_check` CHECK, `status IN ('received', 'claimed', 'done',
'failed')`.

## 4. Cap oversell

**Tier: DB constraint.**

`server/src/db/schema.js:87-93`:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS e_cap_counter_scope_key_idx
  ON e_cap_counter ((data->>'scope_key'));
```

`client/src/lib/distribution/capStore.js:144-157` (`makeEntityCapStore`'s
`incrementIfBelow`) reads the counter, then commits with a compare-and-swap
`UPDATE ... WHERE id = $1 AND count = $2`, retrying on a lost CAS. The
schema.js comment on this index (lines 72-86) explains exactly why the index
is load-bearing and not redundant with the CAS loop: without it, two
concurrent first-time callers on a brand-new `scope_key` can each see an empty
pre-check `filter()` and both successfully `INSERT` their own counter row,
which defeats the CAS loop entirely (it is only atomic against a single
*existing* row). `ensureCounter` (`capStore.js:119-142`) catches the resulting
unique-violation and re-reads the row the other caller won.

Proven under genuine concurrency, against the real database, by
`server/test/capRace.test.js`: twelve concurrent `reserve()` calls against a
cap of one slot, fired with `Promise.all` so all twelve are in flight against
Postgres at once. Exactly one wins; the real `e_cap_counter` row (not just the
function's return values) reads `count = 1` afterward, never more.

## 5. Duplicate commercial sale via a duplicate cap reservation (closed gap)

**Tier: was app-only, now DB constraint.**

`server/src/schemas/entities/CapReservation.json`'s own top comment claims:
"Uniqueness (idempotency_key, route_member_id) guarantees no double-consume on
retry." Reading `server/src/db/schema.js` in full (required reading for this
unit) shows no such constraint exists anywhere. `CapReservation` was an
ordinary `e_*` JSONB entity table with only the generic `id` primary key every
entity gets.

What actually held the line was entirely application code:
`client/src/lib/distribution/reservation.js:19-59` (`reserve()`) only ever
calls `store.putReservation()` after winning an atomic claim through
`store.claim()`, and that claim happens to be backed by a real constraint one
level removed: the claim key is itself a `CapCounter` row, protected by the
`e_cap_counter` unique index above. So the guarantee held in practice, but
only because every writer happened to go through `reserve()`. A second writer
(a script, a future code path, a bug that calls `putReservation()` directly)
would hit no constraint at all and could create a second `CapReservation` row
for a slot that was already consumed. That is precisely a duplicate commercial
sale, Section 7's second-listed never-acceptable outcome.

**Closed additively** in `server/src/db/invariantConstraints.js`
(`ensureCapReservationUniqueness`): a real unique index,

```sql
CREATE UNIQUE INDEX IF NOT EXISTS e_cap_reservation_idem_member_idx
  ON e_cap_reservation ((data->>'idempotency_key'), (data->>'route_member_id'))
  WHERE data->>'idempotency_key' IS NOT NULL AND data->>'route_member_id' IS NOT NULL;
```

Before creating it, the function queries for any existing pair with more than
one row and refuses to add the index (logging loudly instead) if it finds
one, since this module has no live-production evidence that no such row
already exists, unlike the CapCounter index's own rollout (schema.js's
comment on it records that zero existing rows were confirmed by hand before
it shipped). A bare `CREATE UNIQUE INDEX` over a real violation would fail
outright and, since it runs at boot, would stop the application from
starting; the check trades a slower rollout of this one constraint for never
turning an unrelated deploy into an outage. See the "Follow-up needed" section
below: this module is not yet wired into boot.

Proven in `server/test/capRace.test.js` ("W7-INVARIANTS closed gap"): a raw
`INSERT` with a duplicate `(idempotency_key, route_member_id)` pair, bypassing
`reserve()` entirely, is rejected by the database with a constraint-name error
(not by anything in `reservation.js`, since that code path is never called).
A second test confirms the index does not falsely collide when only one of
the two fields matches.

Minor related finding, not fixed here (touching `server/src/schemas/**` is
forbidden to this unit): `CapReservation.json`'s `state` enum lists only
`reserved`, `finalized`, `released`, but `reservation.js:45-49` writes
`state: 'failed'` on a cap-exceeded attempt. The JSONB column has no CHECK
enforcing the enum either way, so this does not break anything functionally,
but the schema's own documentation of its data disagrees with the code that
writes it.

## 6 and 14. One winner per lead, and a retry cannot double-sell or double-bill

**Tier: DB constraint (via the claim primitive) plus an app-level pre-check.**

`client/src/lib/distribution/distributeRun.js:84-91` (`isLeadAlreadySold`) and
`:226` (the winner claim, `capStore.claim(winnerClaimKey(ctx.leadId))`) use the
exact same `e_cap_counter` unique-index-backed claim primitive as the cap
counters above: `claim(key)` is `incrementIfBelow('claim:' + key, 1)`
(`capStore.js:176-179`), so only the first caller to accept a real 2xx
response from a destination can ever win `winner:{leadId}`.

This is the mechanism `server/src/lib/nativeRetryRunner.js` depends on for
safety: its own module comment states the retry send "goes through
reserveAndDeliver - the EXACT same cap-reservation / lead-winner-claim /
wallet-debit primitive the primary send path uses." Two layers close the
double-sale risk (`distributeRun.js:101-114`'s own comment names them): the
pre-send `isLeadAlreadySold` peek (best-effort, avoids even attempting a
second PII send), and the atomic winner claim taken only after a real accepted
response (the actual correctness guarantee under a genuine race between two
workers).

Proven in `server/test/idempotency.test.js`, Group B, against a real loopback
HTTP mock destination and the real `e_cap_counter`/`e_cap_reservation` tables:

- Replaying an already-ACCEPTED attempt with the identical `(idempotencyKey,
  attemptNumber)` is caught at the lead-level winner-claim layer
  (`SUPERSEDED` / `LEAD_ALREADY_SOLD`) before any second POST, any second
  wallet debit, or any second cap consumption.
- Replaying an already-REJECTED attempt (destination declined, so no winner
  claim was ever set) is caught at the reservation layer itself
  (`REJECTED` / `ALREADY_RESERVED`, from #5's constraint), never sent a second
  time, and the wallet is never touched.

## 7. Money never un-sells itself

**Tier: DB constraint. The flagship example.**

`server/src/db/schema.js:119-159`, the `lead_flags_write_once_trg` trigger
W1-FLAGS added. Once `is_sold`, `sold_at`, `sale_price_effective`,
`is_returned`, `returned_at`, `is_converted`, `converted_at`, or
`conversion_type` already holds a "set" value on a `Lead` row, an `UPDATE`
that tries to change it has that one key silently pinned back to its original
value while every other column in the same statement still applies. The
trigger's own comment explains precisely why this has to be a database-level
constraint rather than a check inside `Repo.update()`:
`server/src/db/repo.js:208-222`'s `update()` does a blind top-level JSONB
merge (`data = data || $2::jsonb`) for any entity, so a status-sync webhook, a
re-run of a backfill, or code that does not exist yet could all overwrite
these keys the exact same way any other field is overwritten. The trigger
fires on the real `UPDATE` regardless of caller, including a raw SQL statement
that never goes through `Repo` at all, which is exactly the bar this audit is
checking against.

This is the good example the orienting notes for this unit pointed at, and
having read the current code, that assessment holds: it is a real commercial
invariant (money never un-sells itself) enforced by an actual trigger, not
merely documented as one.

## 8. `lead_status`/`processing_state` writes never touch a money field

**Tier: App-only, and honestly weaker than #7.**

`server/src/lib/leadStatus.js:600-610`, `assertNoMoneyFieldWritten()`: every
patch `statusPatch()`/`leadStatusPatch()` builds is checked against
`MONEY_FIELDS_NEVER_WRITTEN` (`leadStatus.js:564-573`) and throws if a money
key appears. This is real protection, and it is exercised (not merely
asserted about) per the module's own adversarial-QA note at lines 594-599. But
it is a different, weaker enforcement tier than #7's trigger: it only
protects callers that route their writes through `statusPatch()`,
`newVocabularyFields()`, or `leadStatusPatch()`. Anything that calls
`Lead.update()` directly with one of the eight money keys skips this check
entirely, and #7's trigger is what actually stops that write from taking
effect regardless. In other words, #8 is a second, earlier line of defense
inside one module, and #7 is the one that holds even if #8 is bypassed or a
future module never adopts it. This is exactly the "assess honestly rather
than assume everything already has a real constraint" instruction for this
unit: #8 alone would not be enough, and it is not the invariant's true
backstop. No further work item is proposed here since #7 already closes the
gap #8 alone would leave open.

## 9. Business duplicate-lead detection

**Tier: App-only, and deliberately not a DB constraint.**

`server/src/lib/leadStatus.js:997-1027` (`findDuplicateOriginal`, used by the
migration) and the live equivalent in `server/src/functions/leadbyteWebhook.js`
(`merged_into`, lines around 442-455) link a duplicate lead to its survivor by
matching normalized email/mobile identity, not by a hard key. This is
deliberate and correct: a real person legitimately re-submitting months later
is not a database-uniqueness violation, and a DB-level unique constraint on
email or mobile would incorrectly reject that resubmission outright. The
transport-level dedupe in #1 (the same payload, retried) is the invariant that
genuinely is DB-constraint-shaped; business-identity dedupe is a judgment call
that belongs in application code and should stay there. Not a gap.

## 10. Wrong routing

**Tier: not constraint-shaped; out of scope for a database audit.**

Correct routing is a property of the routing engine's decision logic
(`client/src/lib/distribution/engine.js`, `distribute.js`), which is a pure
function over its inputs. There is no database constraint that could express
"the engine chose the right destination"; that guarantee comes from the
engine's own test suite and from `scripts/check-engine-parity.mjs`'s blocking
check that the generated backend bundle
(`server/src/functions/routingEngine.generated.js`) matches the client source
byte for byte, so the server never runs a second, silently drifted
implementation. Recorded here so the audit is explicit about which items in
Section 7's list are and are not database-constraint questions, rather than
silently skipping one.

## 11. Supplier API keys are hash-only at rest

**Tier: convention, not enforced at either tier.**

`server/src/schemas/entities/ApiKey.json`, the `raw_key` field: "LEGACY
cleartext key. Retained only until the hash path is proven against real
supplier traffic, then purged. Never write this on a new key." `key_hash`
(SHA-256 hex, `server/src/lib/apiKeys.js:123`) is the credential of record.
There is no CHECK constraint forbidding a write to `raw_key`, and there could
not usefully be one on a generic JSONB column without also removing the field
from the schema. This is accurately described in the schema comment as a
still-open cleanup (purge `raw_key` once the hash path is proven), not
something this unit's additive-constraint tool can close: it needs a schema
change to `ApiKey.json`, which is in `server/src/schemas/**` and forbidden to
this unit. Recorded as a finding for whichever unit owns that file.

## 12. Cross-buyer / cross-supplier data leakage

**Tier: app-only. A genuine gap at the DB tier, and out of this unit's reach.**

`server/src/lib/entityPolicy.js` is the entire enforcement surface: role
resolution (`ROLE.PORTAL` for `linked_buyer_id`/`linked_supplier_id`, line 39),
per-entity read/write authorization, and field projection (the
`User`-entity allowlist at line 315, and the credential-field exclusion
around line 215). `server/src/routes/entities.js` calls
`authorizeEntity()`/`projectRead()`/`sanitizeWrite()` before touching a row.
This is real and reasonably careful application-layer authorization, but it
is the only layer: every entity lives in a generic `e_<name>` JSONB table
queried through one shared, service-role Postgres connection
(`server/src/db/pool.js`), with no Postgres row-level security policy scoping
rows to a buyer or supplier session. A bug in `entityPolicy.js`, a new route
that forgets to call it, or a raw query against the database would see every
buyer's and every supplier's rows with no database-level boundary at all.

This is assessed honestly as a real gap, and it is **not** something an
additive constraint can close within this unit's reach. Closing it for real
means either Postgres RLS policies keyed to a session variable set per
request (a genuine architecture change touching how every entity route
connects to the database) or splitting cross-tenant tables, neither of which
is a same-pattern additive index or trigger. It needs its own work unit with
its own risk review, not a line added here.

## 13. Untraceable commercial actions

**Tier: app-only, partial.**

`DeliveryAttempt` and `RouteDecisionTrace` rows are the audit trail for a
routing decision and a delivery outcome. They are written at the right points
(`distributeRun.js`'s `trace()` helper, `directPost.js`'s
"persist the attempt BEFORE sending" comment at line 168). But, like every
other `e_*` entity, nothing at the database level stops a later `UPDATE` or
`DELETE` against either table: `Repo.update()` and `Repo.delete()`
(`server/src/db/repo.js:208-233`) work identically on these tables as on any
other. No code path in this codebase currently deletes or rewrites a
`DeliveryAttempt`/`RouteDecisionTrace` row after the fact (not found by
searching `server/src` for such a call), so there is no live exploit today,
but there is also no constraint that would prevent one being introduced later.
Making these tables genuinely append-only (a trigger that refuses `UPDATE`
and `DELETE` after a row reaches a terminal state, mirroring the pattern
`lead_flags_write_once_trg` already establishes for a different purpose) would
close this cleanly and is exactly the kind of additive trigger this unit's
tool is for. It is not added in this pass because it was not the invariant
named in this unit's acceptance steps (the cap-race and replay tests were),
and adding it deserves its own review of which terminal states should lock
each table rather than being folded in here. Recorded as a good candidate for
a focused follow-up unit.

## Follow-up needed outside this unit's file ownership

`server/src/db/invariantConstraints.js` (`ensureInvariantConstraints`) is
written and is exercised directly by both test files in this unit, but it is
**not yet called from the boot sequence**. `server/src/index.js` calls
`ensureSchema()` at line 30; the follow-up is one import and one line calling
`ensureInvariantConstraints()` immediately after it. This is left undone by
this unit deliberately: `server/src/index.js` is not in W7-INVARIANTS'
`files_owned`, and two other units' work landed in adjacent shared
bootstrapping code immediately before this one. Until that one line is added,
the CapReservation uniqueness index closed in item 5 above exists in code and
is proven by tests, but is not applied to a real running deployment.

## What was verified live, not just read

- `server/test/capRace.test.js`: twelve genuinely concurrent (`Promise.all`)
  `reserve()` calls against a cap of one slot, against a real disposable
  Postgres database. Exactly one wins, every time across repeated runs; the
  real `e_cap_counter` row reads `count = 1`, never more. A second suite in
  the same file proves the new `CapReservation` unique index (item 5) rejects
  a raw duplicate insert that bypasses `reserve()` entirely.
- `server/test/idempotency.test.js`: the real `server/src/functions/processLead.js`
  entry point, run twice with an identical inbound payload (sequential retry
  with no idempotency header, sequential retry with an explicit
  client-supplied `Idempotency-Key`, and a genuinely concurrent double post)
  creates exactly one `Lead` row and exactly one `lead_receipts` row every
  time. Separately, `client/src/lib/distribution/distributeRun.js`'s
  `reserveAndDeliver()`, the exact primitive `nativeRetryRunner.js` uses to
  resend a due attempt, is replayed against a real loopback mock destination:
  an already-accepted attempt is never posted, debited, or cap-consumed a
  second time; an already-rejected attempt is answered from its existing
  reservation, never sent again, and never billed.

Both suites run against a real, disposable PostgreSQL database created and
dropped by the test file itself, not an in-memory double, for the same reason
`server/test/durableReceipt.test.js` already gives: the properties under test
are database properties, and an in-memory double would pass even if the real
thing oversold or double-sold.
