#!/bin/bash
# Off-box copy of the nightly wmt.db backup to the SANDBOX Lightsail box.
#
# Runs on PROD (3.14.128.194) at 04:15, after backup-db.sh (04:00) has written
# /opt/wmt/backups/wmt-YYYY-MM-DD.db.gz. Pushes the newest gz to the sandbox
# (18.225.235.28) using a dedicated restricted key (/root/.ssh/wmt-offsite,
# authorized with `restrict` on the sandbox ubuntu account), verifies the
# transferred file with gzip -t, then prunes the REMOTE set: 30-day retention
# plus a 500 MB total-size cap (oldest deleted first, never the newest).
#
# Deployed copy: /opt/wmt/offsite-backup.sh (prod, root:root 0755)
# Cron:          /etc/cron.d/wmt-db-offsite
# Log:           /var/log/wmt/offsite-backup.log
set -euo pipefail
BACKUP_DIR=/opt/wmt/backups
REMOTE=ubuntu@18.225.235.28
REMOTE_DIR=/opt/wmt/offsite-backups
KEY=/root/.ssh/wmt-offsite
OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)

LATEST=$(ls -1t "$BACKUP_DIR"/wmt-*.db.gz 2>/dev/null | head -1)
[ -n "$LATEST" ] && [ -s "$LATEST" ] || { echo "$(date -Is) ERROR: no local backup to sync"; exit 1; }
NAME=$(basename "$LATEST")

scp "${OPTS[@]}" "$LATEST" "$REMOTE:$REMOTE_DIR/"
# Integrity check on the remote copy before we trust it as a backup.
ssh "${OPTS[@]}" "$REMOTE" "gzip -t '$REMOTE_DIR/$NAME'"

# Remote prune: 30-day retention, then size cap (leave at least the newest file).
ssh "${OPTS[@]}" "$REMOTE" "
  find $REMOTE_DIR -name 'wmt-*.db.gz' -mtime +30 -delete
  total=\$(du -sm $REMOTE_DIR | cut -f1)
  while [ \"\$total\" -gt 500 ] && [ \$(ls -1 $REMOTE_DIR/wmt-*.db.gz | wc -l) -gt 1 ]; do
    rm -f \"\$(ls -1tr $REMOTE_DIR/wmt-*.db.gz | head -1)\"
    total=\$(du -sm $REMOTE_DIR | cut -f1)
  done
  echo \"remote: \$(ls -1 $REMOTE_DIR/wmt-*.db.gz | wc -l) files, \${total}MB\"
"
echo "$(date -Is) offsite sync OK: $NAME"
