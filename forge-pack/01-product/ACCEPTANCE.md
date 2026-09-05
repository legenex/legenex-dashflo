# ACCEPTANCE

Observable criteria. Each maps to a unit predicate in `06-qa/ACCEPTANCE-MATRIX.md`. No criterion here is satisfied by inspection or by an agent's confidence.

## A1. The status migration preserves money exactly

Restore a production dump into a disposable database. Record total revenue, sold count and gross profit using the current status-based queries. Run the flag backfill and the status migration. Re-run the same totals using the flag-based queries. **The three numbers must be identical to the cent.** Then mark one sold lead converted and re-run: the totals must not move.

## A2. No lead is lost across a crash

Post a fixture lead through the real intake path. Terminate the process between the durable write and routing. Restart. The lead is present at `queued` with `processing_state` reflecting where it stopped. The reaper recovers it. Exactly one routing run and at most one sale result exist afterwards.

## A3. An ambiguous delivery never becomes a second sale

Point a route at the mock buyer's accept-then-drop mode. Run a lead. Routing stops. `processing_state` is `ambiguous`. No cascade occurs, no sale is recorded, and the lead appears in a reconciliation queue. Re-run the reaper: it does not resume it.

## A4. Caps do not oversell under concurrency

Set a cap with one slot remaining. Process multiple eligible leads concurrently. Exactly one consumes the slot. The others route elsewhere or become `unsold`. Counters remain correct after retries and induced failures.

## A5. A replayed inbound post changes nothing

Post a lead. Post the byte-identical request again with the same idempotency key. No second lead, no second routing run, no second sale, no second supplier cost. The original result is returned.

## A6. DNC still blocks every path

Run the existing DNC all-path tests unchanged. A suppressed lead is durably stored, reaches `rejected` with `REJECTED_DNC`, reaches no buyer, creates no sale, revenue or cap usage, and is visible with its reason on Lead Detail.

## A7. Connector triggers survive the migration

For every `ApiConnector`, `LeadByteConnector` and `InboundWebhookRoute` row, assert no trigger key references a retired status. Fire one webhook per remapped trigger against the mock and confirm it still fires.

## A8. The dashboard tells the truth when there is no data

Load Overview against an empty lead table. Revenue, CPL, Profit and Data Quality render no-data states. No zeros presented as facts, no confidence score. Unset `ANTHROPIC_API_KEY`: the analyst card renders a quiet not-configured state and no red error appears anywhere on Overview.

## A9. Lead tabs filter correctly

Sold, Unsold, Disqualified and Rejected tabs render no Status filter. All Leads does. Unsold reason breakdown is available as a dimension on the Distribution report.

## A10. Onboarding is safe as a public surface

From a clean unauthenticated browser session, complete the form via the link: the submission stores against the correct buyer with a version record and fires an internal alert. Submit incomplete: exact missing fields flagged, buyer blocked from Active. Revoke the token: link dead. Load a token for another buyer: nothing leaks and the page does not confirm whether that buyer exists.

## A11. Gate C is evidence, not assertion

Every line of the Gate C evidence list in `docs/HUMAN-GATES.md` is present with artefacts, including DNC all-path evidence. The kill switch is demonstrated. Rollback to LeadByte is rehearsed. No question in the packet is answerable by code, tests, exports or history.

## A12. The canary reconciles

Across the observation window: zero lost leads, zero duplicate commercial sends, accepted and rejected and technical outcomes reconciling to buyer records, revenue and supplier cost and GP reconciling to source, rollback available throughout.
