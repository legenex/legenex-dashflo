# Production data cutover runbook

Prepared 27 August 2026. This is the exact procedure for replacing the
current, empty production database (`dashflo_staging` on the Boston VPS,
`srv1907687`, `2.25.138.44`) with the verified Aug 22 recovery candidate.

This is a human-gated action under `AGENTS.md` section 13 ("production data
import") and is not executed automatically. Nothing in this document has
been run against production. It exists so the cutover, once approved, is a
five-minute mechanical procedure rather than a design exercise done under
time pressure.

## What this replaces

The current production database is schema-only: 97 tables, 0 rows, rebuilt
clean after the 27 August VPS loss (see "Production VPS lost and rebuilt on
a new host" in `docs/STATE.md`). No real user has registered against it and
no real traffic has been served. Replacing it loses nothing, because there
is nothing in it to lose.

## The artifact

- File: `dashflo-recovery-final-2026-08-27.dump`
  (`pg_dump -Fc`, PostgreSQL 16, ~18.2 MB)
- SHA-256: `889ef3d8b6637649ac7a964c717fa6f765df6d5d39b035d5c0f91e6457e8a506`
- Location: `~/Documents/Projects/dashflo-recovery-backup/artifacts/` on the
  operator's workstation (local only, never committed, never uploaded
  anywhere but the VPS at cutover time).
- Contents: the Aug 22 Base44 migration export (`migration_import_runs` id
  `06fcea8b2a82f00937032c5f`, 93 entities, 154,620 records, 0 failed, 0
  skipped, 0 conflicts) applied through the repository's own
  `runMigrationImport()`, with `ensureSchema()`/`ensureMigrationImportSchema()`
  already run, `backfill-buyer-identity.js` and `backfill-api-key-hashes.js`
  already verified clean (nothing to apply), and the four
  investigated count deltas against the 15 August dump resolved and
  documented in `docs/STATE.md` rather than blindly merged back.
- Verified restore: restored with `pg_restore --no-owner --no-acl` into a
  freshly created, disposable `postgres:16` container unrelated to the one
  that produced the dump. Table count, per-table row sum (154,620, exact),
  and the single `migration_import_runs` row all matched after restore. The
  current `main` application then booted directly against that restored
  copy and answered `GET /api/health` with `{"status":"ok"}`.

## Pre-cutover checklist

1. `npm run gate` passes at the `main` commit currently deployed to
   production. Confirm with `git -C /opt/apps/dashflo rev-parse HEAD` on the
   VPS against the latest green commit.
2. `docker compose ps` on the VPS shows both `dashflo-app` and `dashflo-db`
   healthy.
3. The artifact's SHA-256 matches the value above, checked again
   immediately before use (`shasum -a 256` locally, then again on the VPS
   after transfer).
4. A backup of the current (empty) production database exists from
   immediately before the cutover, not an older one. Not merely the daily
   cron dump: take one by hand in step 2 of the procedure below.
5. `NATIVE_RETRY_WORKER_ENABLED` stays absent from `server/.env`,
   `BASE44_SYNC_ENABLED` stays `0`. Confirmed present in this state as of 27
   August; reconfirm at cutover time, since this file governs delivery
   safety independently of the database contents.

## Procedure

Run from an SSH session on the VPS (`ssh dashflo-vps`, now pointed at
`2.25.138.44`), from `/opt/apps/dashflo`. Expected downtime: under two
minutes (the application container is stopped only for the duration of the
database swap; restoring 154,620 rows from an 18 MB dump took a few seconds
in local testing).

```bash
cd /opt/apps/dashflo

# 1. Stop the app so nothing writes during the swap.
docker compose stop app

# 2. Final pre-cutover safety backup of the current (empty) database, named
#    distinctly from the routine daily cron dumps so it is easy to find.
docker compose exec -T db pg_dump -U dashflo -Fc dashflo_staging \
  > /var/backups/dashflo/pre-cutover-$(date -u +%Y%m%dT%H%M%SZ).dump

# 3. Transfer the verified artifact from the operator's workstation and
#    confirm its checksum survived the transfer unchanged.
#    (run from the workstation, not the VPS)
scp ~/Documents/Projects/dashflo-recovery-backup/artifacts/dashflo-recovery-final-2026-08-27.dump \
  dashflo@2.25.138.44:/tmp/
ssh dashflo-vps "sha256sum /tmp/dashflo-recovery-final-2026-08-27.dump"
#    must print 889ef3d8b6637649ac7a964c717fa6f765df6d5d39b035d5c0f91e6457e8a506

# 4. Replace the database. Drop and recreate rather than --clean restore,
#    since starting from a truly empty database removes any chance of a
#    leftover object from the rebuilt schema colliding with the restore.
docker compose exec -T db psql -U dashflo -d postgres \
  -c "DROP DATABASE dashflo_staging;"
docker compose exec -T db psql -U dashflo -d postgres \
  -c "CREATE DATABASE dashflo_staging OWNER dashflo;"
docker compose exec -T db pg_restore -U dashflo -d dashflo_staging \
  --no-owner --no-acl < /tmp/dashflo-recovery-final-2026-08-27.dump

# 5. Bring the app back.
docker compose up -d --no-deps app

# 6. Remove the transferred dump from /tmp; the checksum-verified copy of
#    record stays only on the operator's workstation and in the dated
#    backup this procedure itself takes in step 2.
rm -f /tmp/dashflo-recovery-final-2026-08-27.dump
```

## Post-cutover verification

```bash
docker compose ps                                   # both healthy
curl -s https://api.dashflo.io/api/health            # {"status":"ok"}
docker compose exec -T db psql -U dashflo -d dashflo_staging -c \
  "SELECT count(*) FROM e_lead;"                     # 1984
docker compose exec -T db psql -U dashflo -d dashflo_staging -c \
  "SELECT count(*) FROM e_buyer;"                     # 13
docker compose exec -T db psql -U dashflo -d dashflo_staging -c \
  "SELECT id FROM migration_import_runs;"             # 06fcea8b2a82f00937032c5f
grep -c '^NATIVE_RETRY_WORKER_ENABLED=' server/.env   # 0 (still absent)
grep '^BASE44_SYNC_ENABLED=' server/.env              # =0
```

Then, outside SSH: confirm `https://app.dashflo.io` serves the login screen
and that one of the three real accounts (`nick@legenex.com`,
`james@legenex.com`, `danelle@legenex.com`) can sign in with its real
password. This is the one step in this whole runbook that only the operator
can do, since nobody else holds those passwords.

## Rollback

If anything in verification fails, restore the pre-cutover backup taken in
step 2 the same way:

```bash
cd /opt/apps/dashflo
docker compose stop app
docker compose exec -T db psql -U dashflo -d postgres \
  -c "DROP DATABASE dashflo_staging;"
docker compose exec -T db psql -U dashflo -d postgres \
  -c "CREATE DATABASE dashflo_staging OWNER dashflo;"
docker compose exec -T db pg_restore -U dashflo -d dashflo_staging \
  --no-owner --no-acl < /var/backups/dashflo/pre-cutover-<timestamp>.dump
docker compose up -d --no-deps app
```

This returns production to the empty, schema-only state it was in before
the cutover, with zero data loss (there was no data to lose) and the
application fully functional, just without the recovered records.

## What this does not do

- Does not touch `distribution_mode`. No row in the restored
  `e_app_settings` sets it, so the application's own default
  (`legacy_only`, see `server/src/lib/nativeRetryRunner.js`) continues to
  govern. Native commercial delivery stays off after cutover exactly as it
  was before.
- Does not enable `NATIVE_RETRY_WORKER_ENABLED` or `BASE44_SYNC_ENABLED`.
  Neither is touched by a database restore; both are `server/.env` values
  and stay whatever they already are.
- Does not reissue TLS, touch nginx, or restart Docker beyond the one `app`
  container cycle described above.
- Does not delete `dashflo_recovery`, `dashflo_recovery_final`, or
  `dashflo_aug15_compare` on the operator's workstation. Those stay until
  this cutover has been verified successful and the operator's own rollback
  confidence is established, per the standing instruction for this
  recovery.
