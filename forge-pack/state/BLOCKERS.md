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
