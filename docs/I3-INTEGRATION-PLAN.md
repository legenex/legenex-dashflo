# I3 pipeline integration plan

Status: Ready, not started

Date: 15 August 2026

Owner: Lead integrator only. No parallel agent edits `processLead.js`.

This is step 2 of the work loop, "read the implementation and all callers",
recorded so the integration itself can be executed directly. Line numbers are
against `server/src/functions/processLead.js` at commit `acb55da`.

## Acceptance

From `EXECUTION-PLAN.md`: all real callers covered, dry runs inert, the under
five second contract measured.

From the invariants: authenticate, commit a sanitized durable receipt, then run
business validation, with global DNC first among business validations. A
committed receipt is replayable after a crash, and replay cannot double-deliver
or double-bill.

## The two modules being wired in

Both exist, are tested, and are called by nothing yet.

- `server/src/lib/receipts.js` with `server/src/db/receiptSchema.js`. Commit,
  claim, complete, release. 19 tests against real PostgreSQL 16 on port 5433.
- `server/src/lib/dncEnforcement.js`. `checkLeadSuppression`, `mayContinue`,
  `suppressionAudit`. 27 tests. The decision is three-valued: CLEAR,
  SUPPRESSED, UNAVAILABLE.

## Insertion points in processLead.js

The handler entry is line 1287. The relevant sequence today:

| Line | What is there now |
|---|---|
| 1343 | `isDryRun` is read from `payload._dry_run` |
| 1353 to 1373 | AUTH. `resolveActiveApiKey`, then a 401 envelope on failure |
| 1375 | `supplierAttribution` resolved |
| 1381 to 1431 | DRY RUN block. Returns before any entity write |
| 1433 | `ApiKey.update`, the first write of the live path |
| 1456 | `db.entities.Lead.create`, the first durable record today |
| 1940 | `checkRequiredFields`, the first business validation today |

Two edits, in this order.

### Edit 1: commit the receipt

Insert after line 1431, the closing brace of the dry run block, and before line
1433. That position is load bearing in both directions:

- After the dry run return, so a validation still writes nothing. A dry run
  must not create a receipt.
- Before `ApiKey.update` and before `Lead.create`, so the receipt is the first
  durable write on the live path and the pre-create window closes.

Derive the transport key with `deriveTransportKey`, preferring a supplier
supplied idempotency key when one is present. Sanitize with
`sanitizeReceiptPayload`, which is what keeps the authorization header, cookies
and the raw API key out of the stored row.

On `duplicate: true`, return the existing outcome rather than reprocessing. That
is the transport level retry case and it is what stops a double delivery when a
supplier retries a request it already made.

### Edit 2: global DNC, first business validation

Insert immediately after the receipt commits, before `Lead.create` at 1456 and
well before `checkRequiredFields` at 1940. The requirement is that DNC is the
first business validation, so nothing else may run before it.

Handle all three decisions:

- CLEAR: continue.
- SUPPRESSED: complete the receipt with a terminal suppressed outcome, persist
  the lead with the stable reason from `suppressionAudit`, deliver to nobody,
  bill nobody. The lead is retained and auditable. Return a rejected envelope
  carrying `DNC_SUPPRESSED`.
- UNAVAILABLE: do not deliver and do not reject. Release the receipt so it stays
  in the pending backlog and is retried. The lead is not lost, and nobody who
  opted out is contacted. This is the case that a boolean check would have got
  wrong.

Use `mayContinue(decision)` rather than testing `suppressed`, so UNAVAILABLE
cannot be mistaken for permission to proceed.

## All callers, and what each needs

`webhook.js` is not in this list on purpose. It authenticates with
`resolveApiKey` but does not invoke `processLead`, so confirm during the
integration whether it is a real intake path that has been missed or a
supplier facing surface that legitimately does not ingest.

| Caller | Site | Real or inert | Needs |
|---|---|---|---|
| `leads.js` | 46, 52 | Real | Receipt and DNC through the shared path |
| `leadbyteWebhook.js` | 3 references | Real | Receipt and DNC. Also still lacks its own caller verification, a known Gate B item |
| `callWebhook.js` | 79, 90 | Real | Call records ingest here. Receipt and DNC |
| `syncGoogleSheets.js` | 148, 149 | Real | CSV and sheet rows. Receipt and DNC, and it must stay restartable |
| `validate.js` | 53 | Inert | Must remain inert. Assert no receipt, no DNC entry write, no counters |
| `recoverTrustedForm.js` | 165 | Comment only | Confirm it re-invokes through the canonical path rather than writing directly |

## Tests to write before the edit

- A receipt exists before any `Lead` row does, observed by ordering, not by
  reading the code.
- A dry run creates no receipt, no lead, and does not move the ApiKey counters.
- A transport retry of the same key delivers once and bills once.
- A suppressed lead is retained, carries `DNC_SUPPRESSED`, and produces no
  delivery attempt and no ledger entry.
- With `DNC_HASH_KEY` unset, a lead is held and retryable rather than delivered
  or rejected, and the receipt stays in the pending backlog.
- A crash between receipt and completion leaves exactly one terminal outcome
  after replay.
- Each of the four real callers reaches the same code path. The cheapest honest
  form is a shared assertion helper run per caller, so "identical across every
  real intake source" is a test rather than a claim.
- Route member suppression still behaves as it does today. Already covered in
  `server/test/dncEnforcement.test.js` and must stay green.

## Measurement

The supplier response contract is under five seconds and the accepted or
rejected shape must not change without Gate B. Measure the post to response
time before and after the edit on the same machine, and record both. The receipt
commit adds one insert and the DNC check adds at most two indexed lookups by
hash, so the expected cost is small, but "expected" is not measured.

## Rollback

Both modules are additive and nothing reads them until this edit lands, so the
rollback is reverting the integration commit alone. The `lead_receipts` table
can be left in place; it is inert without a caller.

## Risks specific to this task

- `Lead.buyer_id` is overloaded. Do not touch it here. R1 added
  `buyer_record_id` and `buyer_code` additively and that is the identity path.
- The file is 2621 lines and mixes intake, enrichment, routing, delivery and
  billing. Keep this edit to intake ordering. Anything else is a separate task.
- Date bucketing depends on `America/Regina`. Preserve it.
- Supplier source codes can carry suffixes and the longest prefix behaviour is
  compatibility sensitive. Do not alter it while in this file.
