#!/bin/sh
# Point-in-time copy of the DB using SQLite's online backup (safe while the app is running).
# Keeps the newest $KEEP copies. Example cron (02:30 nightly):
#   30 2 * * * DB_PATH=/data/gym.db BACKUP_DIR=/data/backups /app/scripts/backup.sh
set -e
DB_PATH="${DB_PATH:-./data/gym.db}"
BACKUP_DIR="${BACKUP_DIR:-./data/backups}"
KEEP="${KEEP:-14}"

mkdir -p "$BACKUP_DIR"
out="$BACKUP_DIR/gym-$(date -u +%Y%m%dT%H%M%SZ).db"
sqlite3 "$DB_PATH" ".backup '$out'"
# Single self-contained file (the copy inherits WAL mode otherwise), then verify it.
sqlite3 "$out" "PRAGMA journal_mode=DELETE;" > /dev/null
sqlite3 "$out" "PRAGMA integrity_check;" | grep -qx ok
rm -f "$out-shm" "$out-wal"
echo "Backed up to $out"

ls -1t "$BACKUP_DIR"/gym-*.db | tail -n +"$((KEEP + 1))" | xargs -r rm --
