#!/bin/bash
# Runs inside the `backup` service: nightly pg_dump + tar of /data, prune old files, then copy to off-site targets.
#   backup.sh        loop forever: one backup a day at BACKUP_HOUR, plus one whenever the admin page asks for it
#   backup.sh once   one backup; exit status is non-zero if anything failed (local or off-site)
#
# Off-site targets are configured on the app's admin "Backups" page. The app writes rclone.conf and targets.json into
# RCLONE_DIR (a volume shared with the app); this script writes status.json there for the page to show.
set -uo pipefail
# Backups hold every password hash and plan: only the owner (root in the container) may read them.
umask 077
BACKUP_HOUR="${BACKUP_HOUR:-3}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
DATA_DIR="${DATA_DIR:-/data}"
RCLONE_DIR="${RCLONE_DIR:-$BACKUP_DIR/.rclone}"
POLL_SECONDS="${POLL_SECONDS:-5}"
RCLONE_CONF="$RCLONE_DIR/rclone.conf"
TARGETS_JSON="$RCLONE_DIR/targets.json"
STATUS_JSON="$RCLONE_DIR/status.json"
RUN_NOW="$RCLONE_DIR/run-now"
# Keeps one slow or hung remote from blocking the others (and the next backup) forever.
RCLONE_FLAGS=(--config "$RCLONE_CONF" --contimeout 30s --timeout 10m --retries 3 --low-level-retries 5)

# Directory 700, files 600 (also fixes backups made by older versions of this script).
secure_dir() {
  mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR" || echo "[backup] WARNING: could not restrict $BACKUP_DIR" >&2
  find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'db-*.dump' -o -name 'files-*.tar.gz' -o -name '*.tmp' \) -exec chmod 600 {} + 2>/dev/null || true
}

# The app runs as an unprivileged user (uid 1000) and must be able to write its config here.
prepare_rclone_dir() {
  mkdir -p "$RCLONE_DIR" 2>/dev/null || return 0
  chown 1000:1000 "$RCLONE_DIR" 2>/dev/null || true
  chmod 755 "$RCLONE_DIR" 2>/dev/null || true
}

# Copy new backups to every enabled target, apply remote retention, record the outcome. Returns non-zero if any target failed.
offsite() {
  [ -s "$TARGETS_JSON" ] || return 0
  if ! command -v rclone >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    echo "[backup] WARNING: rclone/jq missing in this image; skipping off-site copy" >&2; return 0
  fi
  local rc=0 results; results=$(mktemp) || return 1
  local t
  while IFS= read -r t; do
    local id name remote days
    id=$(jq -r '.id' <<<"$t"); name=$(jq -r '.name' <<<"$t")
    remote=$(jq -r '.remote' <<<"$t"); days=$(jq -r '.retention_days // 30' <<<"$t")
    echo "[backup] off-site: $name"
    local err="" ok=true bytes=0 out
    # Everything still on local disk (and younger than the remote retention) that is not on the remote yet. That also
    # uploads files an earlier failed run missed.
    local age=(); [ "$days" -gt 0 ] 2>/dev/null && age=(--max-age "${days}d")
    if ! out=$(rclone "${RCLONE_FLAGS[@]}" copy "$BACKUP_DIR" "$remote" --max-depth 1 \
          --include 'db-*.dump' --include 'files-*.tar.gz' "${age[@]}" 2>&1 >/dev/null); then
      ok=false; err="copy failed: $(tail -n 3 <<<"$out" | tr '\n' ' ')"
    elif [ "$days" -gt 0 ] 2>/dev/null; then
      if ! out=$(rclone "${RCLONE_FLAGS[@]}" delete "$remote" --min-age "${days}d" \
            --include 'db-*.dump' --include 'files-*.tar.gz' 2>&1 >/dev/null); then
        ok=false; err="remote cleanup failed: $(tail -n 3 <<<"$out" | tr '\n' ' ')"
      else
        rclone "${RCLONE_FLAGS[@]}" rmdirs "$remote" --leave-root >/dev/null 2>&1 || true
      fi
    fi
    # Total size now stored on the remote (best effort).
    if [ "$ok" = true ]; then
      bytes=$(rclone "${RCLONE_FLAGS[@]}" size "$remote" --json 2>/dev/null | jq -r '.bytes // 0' 2>/dev/null || echo 0)
    fi
    [[ "$bytes" =~ ^[0-9]+$ ]] || bytes=0
    err="${err:0:500}"
    [ "$ok" = true ] || { rc=1; echo "[backup] FAILED: off-site $name: $err" >&2; }
    jq -nc --arg target "$id" --arg name "$name" --argjson ok "$ok" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg error "$err" --argjson bytes "$bytes" \
      '{target:$target,name:$name,ok:$ok,at:$at,error:$error,bytes:$bytes}' >>"$results"
  done < <(jq -c '.[] | select(.enabled == true)' "$TARGETS_JSON" 2>/dev/null)
  if [ -s "$results" ]; then
    jq -s '.' "$results" >"$STATUS_JSON.tmp" && chmod 644 "$STATUS_JSON.tmp" && mv "$STATUS_JSON.tmp" "$STATUS_JSON" \
      || echo "[backup] WARNING: could not write $STATUS_JSON" >&2
  fi
  rm -f "$results"
  return $rc
}

run_backup() {
  local ts; ts=$(date +%Y%m%d-%H%M%S)
  local db="$BACKUP_DIR/db-$ts.dump" files="$BACKUP_DIR/files-$ts.tar.gz"
  echo "[backup] $ts starting"
  secure_dir
  prepare_rclone_dir
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
  local rc=0
  offsite || rc=1
  echo "[backup] done"
  return $rc
}

if [ "${1:-}" = "once" ]; then run_backup; exit $?; fi

# Next scheduled run as epoch seconds.
next_run() {
  local now next; now=$(date +%s); next=$(date -d "today ${BACKUP_HOUR}:00" +%s)
  [ "$next" -le "$now" ] && next=$(date -d "tomorrow ${BACKUP_HOUR}:00" +%s)
  echo "$next"
}

prepare_rclone_dir
next=$(next_run)
echo "[backup] next scheduled run in $((next-$(date +%s)))s; watching $RUN_NOW for run-now requests"
while true; do
  if [ -e "$RUN_NOW" ]; then
    rm -f "$RUN_NOW"
    echo "[backup] run requested from the admin page"
    run_backup || echo "[backup] FAILED (see above)" >&2
  elif [ "$(date +%s)" -ge "$next" ]; then
    run_backup || echo "[backup] FAILED (see above); will retry at the next scheduled run" >&2
    next=$(next_run)
    echo "[backup] next run in $((next-$(date +%s)))s"
  fi
  sleep "$POLL_SECONDS"
done
