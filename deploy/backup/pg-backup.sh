#!/usr/bin/env bash
# Automated PostgreSQL backup for DashFlo production.
#
# Installed via cron for the dashflo user (see deploy/backup/pg-backup.cron).
# Dumps the live database with pg_dump -Fc (custom format, restorable with
# pg_restore) through the running db container, and writes it under
# /var/backups/dashflo, outside every Docker volume, so a bad migration, a
# container rebuild, or a volume removal cannot take the backup with it.
# Dumps older than the retention window are pruned.
#
# This is on-host storage only. It protects against a bad migration,
# accidental data loss, or operator error, not against losing the VPS
# itself: see docs/BACKUP-RESTORE.md for off-server replication status and
# the restore procedure.

set -euo pipefail

COMPOSE_DIR="/opt/apps/dashflo"
BACKUP_DIR="/var/backups/dashflo"
RETENTION_DAYS="${DASHFLO_BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/dashflo-$STAMP.dump"
LOG="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

log() { printf '%s [backup] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }

cd "$COMPOSE_DIR"

partial="$DEST.partial"
if ! docker compose exec -T db pg_dump -U dashflo -Fc dashflo_staging > "$partial"; then
  log "FAILED: pg_dump did not complete cleanly, removing partial output"
  rm -f "$partial"
  exit 1
fi

if [ ! -s "$partial" ]; then
  log "FAILED: pg_dump produced an empty file"
  rm -f "$partial"
  exit 1
fi

install -m 600 "$partial" "$DEST"
rm -f "$partial"

size="$(stat -c '%s' "$DEST" 2>/dev/null || echo unknown)"
log "OK: wrote $DEST ($size bytes)"

removed=0
while IFS= read -r -d '' old; do
  rm -f "$old"
  log "pruned $old"
  removed=$((removed + 1))
done < <(find "$BACKUP_DIR" -maxdepth 1 -name 'dashflo-*.dump' -mtime "+$RETENTION_DAYS" -print0)

log "backup run complete, $removed old dump(s) pruned"
