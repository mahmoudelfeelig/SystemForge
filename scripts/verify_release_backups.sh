#!/bin/sh
set -eu

APP_DIR=${SYSTEMFORGE_APP_DIR:-/opt/systemforge}
BACKUP_DIR=${SYSTEMFORGE_BACKUP_DIR:-/opt/systemforge-backups}
CONFIG_FILE=${SYSTEMFORGE_OFFSITE_CONFIG:-/etc/systemforge/offsite-backup.env}
BACKUP_STATUS=${SYSTEMFORGE_OFFSITE_STATUS_FILE:-"$BACKUP_DIR/offsite-backup.status"}
RESTORE_STATUS=${SYSTEMFORGE_OFFSITE_RESTORE_STATUS_FILE:-"$BACKUP_DIR/offsite-restore.status"}
RUN_BACKUPS=${SYSTEMFORGE_RUN_BACKUPS:-"$APP_DIR/scripts/run_backups.sh"}
RUN_RESTORE=${SYSTEMFORGE_VERIFY_OFFSITE_RESTORE:-"$APP_DIR/scripts/verify_offsite_restore.sh"}
NOW_EPOCH=${SYSTEMFORGE_NOW_EPOCH:-$(date -u +%s)}
MAX_BACKUP_AGE_SECONDS=${SYSTEMFORGE_MAX_BACKUP_AGE_SECONDS:-3600}
MAX_RESTORE_AGE_SECONDS=${SYSTEMFORGE_MAX_RESTORE_AGE_SECONDS:-7776000}

fail() {
  echo "Production backup gate failed: $*" >&2
  exit 1
}

secure_file() {
  FILE=$1
  LABEL=$2
  test -f "$FILE" || fail "$LABEL file does not exist: $FILE"
  test -r "$FILE" || fail "$LABEL file is not readable: $FILE"
  MODE=$(stat -c '%a' "$FILE")
  case "$MODE" in
    400 | 600) ;;
    *) fail "$LABEL file must use mode 0400 or 0600, not $MODE: $FILE" ;;
  esac
  OWNER_UID=$(stat -c '%u' "$FILE")
  test "$OWNER_UID" = "$(id -u)" || fail "$LABEL file must be owned by the effective user: $FILE"
}

field() {
  FILE=$1
  KEY=$2
  sed -n "s/^$KEY=//p" "$FILE" | tail -1
}

timestamp_epoch() {
  VALUE=$1
  date -u -d "$VALUE" +%s 2>/dev/null
}

require_fresh_status() {
  FILE=$1
  LABEL=$2
  TIME_FIELD=$3
  MAX_AGE=$4
  secure_file "$FILE" "$LABEL"
  TIMESTAMP=$(field "$FILE" "$TIME_FIELD")
  test -n "$TIMESTAMP" || fail "$LABEL does not contain $TIME_FIELD."
  EPOCH=$(timestamp_epoch "$TIMESTAMP") || fail "$LABEL contains an invalid UTC timestamp."
  AGE=$((NOW_EPOCH - EPOCH))
  test "$AGE" -ge 0 || fail "$LABEL timestamp is in the future."
  test "$AGE" -le "$MAX_AGE" || fail "$LABEL is stale by $AGE seconds."
}

positive_integer() {
  VALUE=$1
  LABEL=$2
  case "$VALUE" in
    '' | *[!0-9]*) fail "$LABEL must be a non-negative integer." ;;
  esac
}

positive_integer "$NOW_EPOCH" "current epoch"
positive_integer "$MAX_BACKUP_AGE_SECONDS" "maximum backup age"
positive_integer "$MAX_RESTORE_AGE_SECONDS" "maximum restore age"
secure_file "$CONFIG_FILE" "off-site configuration"
test -x "$RUN_BACKUPS" || fail "backup runner is not executable: $RUN_BACKUPS"
test -x "$RUN_RESTORE" || fail "restore runner is not executable: $RUN_RESTORE"
test -d "$APP_DIR/apps/api/migrations" || fail "migration directory is missing."

MIGRATION_MANIFEST_SHA256=$(
  cd "$APP_DIR"
  find apps/api/migrations -type f -name '*.sql' -print \
    | LC_ALL=C sort \
    | while IFS= read -r migration; do sha256sum "$migration"; done \
    | sha256sum \
    | cut -d ' ' -f 1
)
case "$MIGRATION_MANIFEST_SHA256" in
  *[!0-9a-f]* | '') fail "migration manifest digest could not be calculated." ;;
esac
test "${#MIGRATION_MANIFEST_SHA256}" -eq 64 || fail "migration manifest digest is invalid."
export SYSTEMFORGE_MIGRATION_MANIFEST_SHA256="$MIGRATION_MANIFEST_SHA256"

SYSTEMFORGE_APP_DIR="$APP_DIR" \
  SYSTEMFORGE_BACKUP_DIR="$BACKUP_DIR" \
  SYSTEMFORGE_OFFSITE_CONFIG="$CONFIG_FILE" \
  SYSTEMFORGE_OFFSITE_STATUS_FILE="$BACKUP_STATUS" \
  "$RUN_BACKUPS"

require_fresh_status "$BACKUP_STATUS" "off-site backup status" last_backup_utc "$MAX_BACKUP_AGE_SECONDS"

RESTORE_REQUIRED=true
if test -f "$RESTORE_STATUS" && test -r "$RESTORE_STATUS"; then
  RESTORE_MODE=$(stat -c '%a' "$RESTORE_STATUS")
  RESTORE_OWNER=$(stat -c '%u' "$RESTORE_STATUS")
  RESTORE_TIME=$(field "$RESTORE_STATUS" last_restore_utc)
  RESTORE_MIGRATIONS=$(field "$RESTORE_STATUS" migration_manifest_sha256)
  if test "$RESTORE_MODE" = 600 \
    && test "$RESTORE_OWNER" = "$(id -u)" \
    && test "$RESTORE_MIGRATIONS" = "$MIGRATION_MANIFEST_SHA256" \
    && RESTORE_EPOCH=$(timestamp_epoch "$RESTORE_TIME"); then
    RESTORE_AGE=$((NOW_EPOCH - RESTORE_EPOCH))
    if test "$RESTORE_AGE" -ge 0 && test "$RESTORE_AGE" -le "$MAX_RESTORE_AGE_SECONDS"; then
      RESTORE_REQUIRED=false
    fi
  fi
fi

if test "$RESTORE_REQUIRED" = true; then
  SYSTEMFORGE_APP_DIR="$APP_DIR" \
    SYSTEMFORGE_BACKUP_DIR="$BACKUP_DIR" \
    SYSTEMFORGE_OFFSITE_CONFIG="$CONFIG_FILE" \
    SYSTEMFORGE_OFFSITE_RESTORE_STATUS_FILE="$RESTORE_STATUS" \
    "$RUN_RESTORE"
fi

require_fresh_status "$RESTORE_STATUS" "off-site restore status" last_restore_utc "$MAX_RESTORE_AGE_SECONDS"
test "$(field "$RESTORE_STATUS" migration_manifest_sha256)" = "$MIGRATION_MANIFEST_SHA256" \
  || fail "restore evidence does not cover the current migration manifest."
test "$(field "$BACKUP_STATUS" backup_host)" = "$(field "$RESTORE_STATUS" backup_host)" \
  || fail "backup and restore evidence use different host labels."
test "$(field "$BACKUP_STATUS" backup_tag)" = "$(field "$RESTORE_STATUS" backup_tag)" \
  || fail "backup and restore evidence use different tags."

echo "Production backup gate passed with current encrypted backup and restore evidence."
