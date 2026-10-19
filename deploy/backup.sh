#!/bin/bash
# Runs inside the `backup` service: nightly pg_dump + tar of /data, prune old files.
set -euo pipefail
BACKUP_HOUR="${BACKUP_HOUR:-3}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

run_backup() {
  local ts; ts=$(date +%Y%m%d-%H%M%S)
  echo "[backup] $ts starting"
  pg_dump -Fc -f "/backups/db-$ts.dump.tmp" && mv "/backups/db-$ts.dump.tmp" "/backups/db-$ts.dump"
  tar -czf "/backups/files-$ts.tar.gz.tmp" -C /data . && mv "/backups/files-$ts.tar.gz.tmp" "/backups/files-$ts.tar.gz"
  find /backups -maxdepth 1 -type f \( -name 'db-*.dump' -o -name 'files-*.tar.gz' -o -name '*.tmp' \) -mtime +"$RETENTION_DAYS" -delete
  echo "[backup] done"
}

if [ "${1:-}" = "once" ]; then run_backup; exit 0; fi

while true; do
  now=$(date +%s)
  next=$(date -d "today ${BACKUP_HOUR}:00" +%s)
  [ "$next" -le "$now" ] && next=$(date -d "tomorrow ${BACKUP_HOUR}:00" +%s)
  echo "[backup] next run in $((next-now))s"
  sleep $((next-now))
  run_backup || echo "[backup] FAILED"
done
