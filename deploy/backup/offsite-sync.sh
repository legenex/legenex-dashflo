#!/usr/bin/env bash
# Off-server replication of the on-host PostgreSQL backups.
#
# Runs immediately after deploy/backup/pg-backup.sh, from the same cron line.
# Copies every dump in /var/backups/dashflo to a remote configured with
# `rclone config` on the VPS host, so losing the VPS itself does not also
# lose its backups (the gap recorded in docs/BACKUP-RESTORE.md).
#
# Deliberately not fatal when unconfigured: exits 0 so the presence of this
# script, before an operator has chosen a provider and run `rclone config`,
# never breaks the on-host backup this depends on. Once a remote named
# OFFSITE_RCLONE_REMOTE exists, uploads start on the very next run with no
# other change needed.

set -euo pipefail

BACKUP_DIR="/var/backups/dashflo"
LOG="$BACKUP_DIR/offsite.log"
CONFIG_FILE="/opt/apps/dashflo/deploy/backup/offsite.env"

log() { printf '%s [offsite] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }

# Remote name and destination path/bucket, e.g. "b2:dashflo-backups" or
# "s3:my-bucket/dashflo". Set in offsite.env, which is host-local and
# gitignored, never committed, the same way server/.env is.
OFFSITE_RCLONE_REMOTE="${OFFSITE_RCLONE_REMOTE:-}"
if [ -f "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

if ! command -v rclone >/dev/null 2>&1; then
  log "SKIPPED: rclone is not installed"
  exit 0
fi

if [ -z "$OFFSITE_RCLONE_REMOTE" ]; then
  log "SKIPPED: OFFSITE_RCLONE_REMOTE is not set in $CONFIG_FILE, no provider configured yet"
  exit 0
fi

remote_name="${OFFSITE_RCLONE_REMOTE%%:*}:"
if ! rclone listremotes | grep -qF "$remote_name"; then
  log "SKIPPED: rclone remote '$remote_name' is not configured (run: rclone config)"
  exit 0
fi

# Copy only, never sync/delete: local retention (14 days) prunes the host
# copy, but the off-site copy is meant to outlive that, not mirror it.
if rclone copy "$BACKUP_DIR" "$OFFSITE_RCLONE_REMOTE" \
    --include "dashflo-*.dump" \
    --min-age 30s \
    --log-file "$LOG" --log-level INFO; then
  log "OK: copied dumps to $OFFSITE_RCLONE_REMOTE"
else
  log "FAILED: rclone copy to $OFFSITE_RCLONE_REMOTE did not complete cleanly"
  exit 1
fi
