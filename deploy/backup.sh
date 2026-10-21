#!/bin/bash
# Runs inside the `backup` service: nightly pg_dump + tar of /data, prune old files.
#   backup.sh        loop forever, one backup a day at BACKUP_HOUR
#   backup.sh once   one backup; exit status is non-zero if anything failed
set -uo pipefail
# Backups hold every password hash and plan: only the owner (root in the container) may read them.
umask 077
BACKUP_HOUR="${BACKUP_HOUR:-3}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
DATA_DIR="${DATA_DIR:-/data}"

# Directory 700, files 600 (also fixes backups made by older versions of this script).
secure_dir() {
  mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR" || echo "[backup] WARNING: could not restrict $BACKUP_DIR" >&2
  find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'db-*.dump' -o -name 'files-*.tar.gz' -o -name '*.tmp' \) -exec chmod 600 {} + 2>/dev/null || true
}

run_backup() {
  local ts; ts=$(date +%Y%m%d-%H%M%S)
  local db="$BACKUP_DIR/db-$ts.dump" files="$BACKUP_DIR/files-$ts.tar.gz"
  echo "[backup] $ts starting"
  secure_dir
  # Leftovers of an interrupted run are never valid backups.
  rm -f "$BACKUP_DIR"/*.tmp

  if ! pg_dump -Fc -f "$db.tmp"; then
    echo "[backup] FAILED: pg_dump" >&2; rm -f "$db.tmp"; return 1
  fi
  chmod 600 "$db.tmp"
  mv "$db.tmp" "$db" || { echo "[backup] FAILED: could not finalize $db" >&2; return 1; }

  if ! tar -czf "$files.tmp" -C "$DATA_DIR" .; then
    echo "[backup] FAILED: tar of $DATA_DIR" >&2; rm -f "$files.tmp"
    rm -f "$db"   # keep dump and files as a matching pair
    return 1
  fi
  chmod 600 "$files.tmp"
  mv "$files.tmp" "$files" || { echo "[backup] FAILED: could not finalize $files" >&2; rm -f "$db"; return 1; }

  # Only now that a complete pair exists is it safe to drop old ones.
  find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'db-*.dump' -o -name 'files-*.tar.gz' \) -mtime +"$RETENTION_DAYS" -delete \
    || { echo "[backup] WARNING: pruning old backups failed" >&2; }
  echo "[backup] done"
}

if [ "${1:-}" = "once" ]; then run_backup; exit $?; fi

while true; do
  now=$(date +%s)
  next=$(date -d "today ${BACKUP_HOUR}:00" +%s)
  [ "$next" -le "$now" ] && next=$(date -d "tomorrow ${BACKUP_HOUR}:00" +%s)
  echo "[backup] next run in $((next-now))s"
  sleep $((next-now))
  run_backup || echo "[backup] FAILED (see above); will retry at the next scheduled run" >&2
done
