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
