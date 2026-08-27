# DashFlo PostgreSQL backup and restore

Read this before touching production backups or performing a restore. It
describes the automated on-host backup and the manual restore procedure
adopted after the original Hostinger VPS was permanently wiped with no
recoverable backup on 27 August 2026.

## What exists today

- `deploy/backup/pg-backup.sh` dumps the live `dashflo_staging` database with
  `pg_dump -Fc` (custom format) through the running `db` container, and
  writes it to `/var/backups/dashflo/dashflo-<UTC timestamp>.dump` on the VPS
  host, outside every Docker volume. A container rebuild or a volume removal
  cannot take the backup with it.
- `deploy/backup/pg-backup.cron` runs it daily at 03:00 UTC as the `dashflo`
  user. Install by merging its one line into `dashflo`'s crontab on the VPS,
  the same way `deploy/cron/base44-sync.cron` is installed.
- Dumps older than `DASHFLO_BACKUP_RETENTION_DAYS` (default 14) are pruned on
  every run. `/var/backups/dashflo` and each dump are mode 700/600, readable
  only by `dashflo` and root, which is the access control this stage
  provides.
- Every run appends one line to `/var/backups/dashflo/backup.log`: `OK` with
  the byte size, or `FAILED` with the reason. There is no push alert yet; see
  Gaps below.

## Verified working as the `dashflo` user, 27 August 2026

`/var/backups/dashflo` was created `root:root` mode 700 during initial VPS
setup, so the `dashflo` cron user could not write to it; the one dump present
before this fix was written by a manual root-privileged test, not by cron.
Fixed with `chown -R dashflo:dashflo /var/backups/dashflo` (mode stays 700).

Verified end to end as `dashflo`, not root, running the exact crontab command
(`flock -n /tmp/dashflo-pg-backup.cron.lock
/opt/apps/dashflo/deploy/backup/pg-backup.sh >> /var/backups/dashflo/cron.log
2>&1`):

- exit code 0
- new dump written: `dashflo-20260827T190026Z.dump`, 163583 bytes, `file`
  confirms `PostgreSQL custom database dump - v1.15-0`
- `backup.log` recorded `OK: wrote ... (163583 bytes)`
- `/var/backups/dashflo` is `700 dashflo:dashflo`; every `.dump` file is `600
  dashflo:dashflo`; `cron.log` was tightened from cron's default `664` to
  `600`. The containing directory being `700` already blocked any other user
  from traversing to the files regardless.
- restored the fresh dump with `pg_restore --no-owner` into a disposable
  `dashflo_restore_verify` database in the same container, clean exit, no
  errors
- restored database has 97 tables in `public`, matching live `dashflo_staging`
  exactly (97)
- exact row count across every table in the restored database is 0, matching
  live `dashflo_staging`, which is correct: this is the clean rebuilt database
  from the 27 August VPS recovery with no data imported yet
- scratch database dropped after verification

This closes on-host backup verification. Off-server replication remains open,
see below.

## What is still missing

- **Off-server storage.** Every dump above lives on the same VPS as the
  database it backs up. If that VPS is lost the way the old one was, these
  backups are lost with it. This is the same failure this stage exists to
  prevent, and it is not yet closed.

  Closing it needs a provider decision from the operator: object storage
  (S3, Backblaze B2, or similar) and a credential for it. Once chosen,
  extend `pg-backup.sh` (or add a second script invoked right after it) to
  upload the just-written dump, and store the upload credential the same way
  every other production secret is stored, in `server/.env` or the
  destination's own credential store, never in this repository.

- **Failure alerting.** A failed run is visible in `backup.log` and in
  `journalctl` / cron's own mail if the host has a working local MTA, but
  nothing pages anyone. Wiring `check_url`-style monitoring, a dead man's
  switch (e.g. a scheduled ping to a monitoring provider on success), or an
  email through the already-configured SMTP settings once they exist are all
  reasonable follow-ups.

- **Scheduled restore drill.** The procedure below has been exercised once,
  by hand, against a disposable database (see Evidence in `docs/STATE.md`
  for the date). Nothing runs it on a schedule.

## Restore procedure

This restores into a **disposable** database first. Do not point production
at a restored dump without deciding that deliberately; restoring over a live
`dashflo_staging` is a destructive production data operation and needs the
same approval any other one does.

1. Pick the dump: `ls -la /var/backups/dashflo/*.dump`
2. Create a scratch database inside the running container:
   ```
   docker compose exec db createdb -U dashflo dashflo_restore_verify
   ```
3. Restore into it:
   ```
   cat /var/backups/dashflo/dashflo-<timestamp>.dump | \
     docker compose exec -T db pg_restore -U dashflo -d dashflo_restore_verify --no-owner
   ```
4. Verify: connect and spot-check row counts against what the log recorded,
   or against another known-good source.
   ```
   docker compose exec db psql -U dashflo -d dashflo_restore_verify -c \
     "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
   ```
5. Drop the scratch database once satisfied:
   ```
   docker compose exec db dropdb -U dashflo dashflo_restore_verify
   ```

### Restoring into production

Only after the steps above prove the dump is good, and only with explicit
operator approval:

1. Stop the app so nothing writes during the restore:
   `docker compose stop app`
2. Restore, dropping and recreating first so the target is exactly the dump,
   not the dump merged into whatever is already there:
   ```
   docker compose exec db dropdb -U dashflo dashflo_staging
   docker compose exec db createdb -U dashflo dashflo_staging
   cat /var/backups/dashflo/dashflo-<timestamp>.dump | \
     docker compose exec -T db pg_restore -U dashflo -d dashflo_staging --no-owner
   ```
3. Start the app back up: `docker compose up -d app`
4. Verify `/api/health` and a login before considering it done.

## Why `pg_dump -Fc` and not a filesystem snapshot

The custom `pg_dump` format is portable across the exact PostgreSQL major
version in use (16), restorable selectively with `pg_restore` if only part
of the data is needed, and does not require stopping the database or
freezing the underlying volume the way a raw filesystem or block snapshot
would. It is the same format the pre-refresh verification dump documented in
`docs/STATE.md` used.
