#!/usr/bin/env bash
# Usage: deploy/restore.sh backups/db-YYYYmmdd-HHMMSS.dump [backups/files-YYYYmmdd-HHMMSS.tar.gz]
# Run from the repo root on the VPS. DESTROYS current data. Stops the app during restore.
set -euo pipefail
DB_DUMP="${1:?usage: $0 <db dump> [files tarball]}"
FILES_TAR="${2:-}"
[ -f "$DB_DUMP" ] || { echo "missing $DB_DUMP"; exit 1; }
read -r -p "This overwrites the live database${FILES_TAR:+ and files}. Type 'restore' to continue: " ok
[ "$ok" = "restore" ] || exit 1

docker compose stop app cloudflared backup
docker compose up -d db
docker compose exec -T db sh -c 'until pg_isready -U planmark; do sleep 1; done'
docker compose exec -T db pg_restore -U planmark -d planmark --clean --if-exists --no-owner < "$DB_DUMP"
if [ -n "$FILES_TAR" ]; then
  [ -f "$FILES_TAR" ] || { echo "missing $FILES_TAR"; exit 1; }
  docker compose run --rm --no-deps -T -v "$(pwd)/$(dirname "$FILES_TAR"):/in:ro" --user root --entrypoint sh app \
    -c "rm -rf /data/* /data/.[!.]* 2>/dev/null; tar -xzf /in/$(basename "$FILES_TAR") -C /data && chown -R node:node /data"
fi
docker compose up -d
echo "Restore complete."
