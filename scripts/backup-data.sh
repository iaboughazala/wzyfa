#!/bin/bash
# Daily backup of wzyfa-search data to /var/backups/wzyfa-search/
# Run via cron:  0 3 * * *  /opt/wzyfa-search/scripts/backup-data.sh
set -e

BACKUP_DIR="/var/backups/wzyfa-search"
SRC="/opt/wzyfa-search/data"
DATE=$(date +%Y-%m-%d)
LOG="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR"
cd "$BACKUP_DIR"

# Create today's backup (tar.gz)
tar -czf "wzyfa-data-${DATE}.tar.gz" -C "$(dirname $SRC)" "$(basename $SRC)"

# Keep last 14 days, delete older
find . -name 'wzyfa-data-*.tar.gz' -mtime +14 -delete

# Log the result
SIZE=$(du -h "wzyfa-data-${DATE}.tar.gz" | cut -f1)
echo "[$(date -Is)] Backup created: wzyfa-data-${DATE}.tar.gz ($SIZE)" >> "$LOG"

# Print summary
echo "Backup: wzyfa-data-${DATE}.tar.gz ($SIZE)"
ls -lh "$BACKUP_DIR" | tail -5
