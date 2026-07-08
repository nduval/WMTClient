#!/bin/bash
# Daily SQLite backup for /opt/wmt/wmt.db.
# Uses sqlite3 .backup for an atomic snapshot (safe under live writes via better-sqlite3).
# Retains 14 days; oldest pruned. Output: /opt/wmt/backups/wmt-YYYY-MM-DD.db.gz
#
# Replaces the JSON backup feature that was removed from admin.php on
# 2026-05-10 — that one walked stale JSON, this one captures DB state.
#
# Deployed copy: /opt/wmt/backup-db.sh (prod). Cron: /etc/cron.d/wmt-db-backup (04:00).
# Off-box sync of these files to the sandbox: ops/offsite-backup.sh (04:15).
# This repo copy was pulled from prod 2026-07-07 so the script is under version control.
set -euo pipefail
BACKUP_DIR=/opt/wmt/backups
DB=/opt/wmt/wmt.db
RETAIN_DAYS=14
mkdir -p "$BACKUP_DIR"
TS=$(date +%Y-%m-%d)
TMP=$(mktemp /tmp/wmt-snapshot.XXXX.db)
sqlite3 "$DB" ".backup '$TMP'"
gzip -c "$TMP" > "$BACKUP_DIR/wmt-$TS.db.gz"
rm -f "$TMP"
# Prune anything older than retention window
find "$BACKUP_DIR" -name 'wmt-*.db.gz' -mtime +$RETAIN_DAYS -delete
echo "$(date -Is) backup complete: $BACKUP_DIR/wmt-$TS.db.gz ($(stat -c%s $BACKUP_DIR/wmt-$TS.db.gz) bytes)"
