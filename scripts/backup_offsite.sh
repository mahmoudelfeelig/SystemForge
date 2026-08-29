#!/bin/sh
set -eu

BACKUP_DIR=${SYSTEMFORGE_BACKUP_DIR:?SYSTEMFORGE_BACKUP_DIR is required}
CONFIG_FILE=${SYSTEMFORGE_OFFSITE_CONFIG:-"$BACKUP_DIR/.offsite/offsite-backup.env"}
RESTIC_BIN=${SYSTEMFORGE_RESTIC_BIN:-"$BACKUP_DIR/.offsite/restic"}
BACKUP_HOST=${SYSTEMFORGE_RESTIC_HOST:-systemforge-production}
BACKUP_TAG=${SYSTEMFORGE_RESTIC_TAG:-systemforge-postgres}
CHECK_SUBSET=${SYSTEMFORGE_RESTIC_CHECK_SUBSET:-5%}
STATUS_FILE=${SYSTEMFORGE_OFFSITE_STATUS_FILE:-"$BACKUP_DIR/offsite-backup.status"}
LOCK_FILE="$BACKUP_DIR/.offsite-backup.lock"
LOCK_WAIT_SECONDS=${SYSTEMFORGE_BACKUP_LOCK_WAIT_SECONDS:-300}
BACKUP_RUN_ID=${SYSTEMFORGE_BACKUP_RUN_ID:-scheduled}

fail() {
  echo "Off-site backup failed: $*" >&2
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

validate_repository() {
  if test -n "${RESTIC_REPOSITORY:-}" && test -n "${RESTIC_REPOSITORY_FILE:-}"; then
    fail "set only one of RESTIC_REPOSITORY or RESTIC_REPOSITORY_FILE."
  fi
  if test -n "${RESTIC_REPOSITORY:-}"; then
    REPOSITORY_LOCATION=$RESTIC_REPOSITORY
  elif test -n "${RESTIC_REPOSITORY_FILE:-}"; then
    case "$RESTIC_REPOSITORY_FILE" in
      /*) ;;
      *) fail "RESTIC_REPOSITORY_FILE must use an absolute path." ;;
    esac
    secure_file "$RESTIC_REPOSITORY_FILE" "repository location"
    REPOSITORY_LOCATION=$(sed -n '1p' "$RESTIC_REPOSITORY_FILE")
  else
    fail "RESTIC_REPOSITORY or RESTIC_REPOSITORY_FILE is required."
  fi
  case "$REPOSITORY_LOCATION" in
    sftp:* | s3:*) ;;
    *)
      test "${SYSTEMFORGE_ALLOW_LOCAL_RESTIC_REPOSITORY:-false}" = true || \
        fail "repository must use the sftp: or s3: backend for independent off-site storage."
      ;;
  esac
}

positive_integer() {
  VALUE=$1
  LABEL=$2
  case "$VALUE" in
    '' | *[!0-9]*) fail "$LABEL must be a non-negative integer." ;;
  esac
}

case "$BACKUP_DIR" in
  '' | /) fail "backup directory is too broad." ;;
esac
positive_integer "$LOCK_WAIT_SECONDS" "backup lock wait"
case "$BACKUP_RUN_ID" in
  *[!A-Za-z0-9._:-]* | '') fail "backup run identifier is malformed." ;;
esac
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
exec 9>"$LOCK_FILE"
flock -w "$LOCK_WAIT_SECONDS" 9 || fail "off-site backup lock remained busy for $LOCK_WAIT_SECONDS seconds."

secure_file "$CONFIG_FILE" "configuration"
set -a
# shellcheck disable=SC1090
. "$CONFIG_FILE"
set +a

validate_repository
test -n "${RESTIC_PASSWORD_FILE:-}" || fail "RESTIC_PASSWORD_FILE is required."
case "$RESTIC_PASSWORD_FILE" in
  /*) ;;
  *) fail "RESTIC_PASSWORD_FILE must use an absolute path." ;;
esac
secure_file "$RESTIC_PASSWORD_FILE" "repository password"
RESTIC_COMMAND=$(command -v "$RESTIC_BIN") || fail "restic binary was not found: $RESTIC_BIN"

test -n "$BACKUP_HOST" || fail "backup host label is empty."
test -n "$BACKUP_TAG" || fail "backup tag is empty."
test -n "$CHECK_SUBSET" || fail "integrity-check subset is empty."

BACKUP_FILE=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'systemforge.*.dump' -print | sort | tail -1)
test -n "$BACKUP_FILE" || fail "no verified PostgreSQL dump exists in $BACKUP_DIR."
test -f "$BACKUP_FILE" || fail "selected dump is missing: $BACKUP_FILE"

if ! "$RESTIC_COMMAND" snapshots --host "$BACKUP_HOST" --tag "$BACKUP_TAG" --json >/dev/null 2>&1; then
  fail "the encrypted repository is unavailable or uninitialized; run scripts/init_offsite_backup.sh explicitly."
fi

BACKUP_FILENAME=$(basename "$BACKUP_FILE")
(
  cd "$BACKUP_DIR"
  "$RESTIC_COMMAND" backup \
    --host "$BACKUP_HOST" \
    --tag "$BACKUP_TAG" \
    --skip-if-unchanged \
    "$BACKUP_FILENAME"
)
# Backup creation must be append-only. Remote retention is intentionally not
# reachable from an application checkout or an automatic deployment path.
"$RESTIC_COMMAND" check --read-data-subset="$CHECK_SUBSET"

SOURCE_SHA256=$(sha256sum "$BACKUP_FILE")
SOURCE_SHA256=${SOURCE_SHA256%% *}
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STATUS_TEMP="$STATUS_FILE.partial.$$"
trap 'rm -f "$STATUS_TEMP"' EXIT HUP INT TERM
umask 077
{
  printf 'last_backup_utc=%s\n' "$STAMP"
  printf 'backup_run_id=%s\n' "$BACKUP_RUN_ID"
  printf 'source_filename=%s\n' "$(basename "$BACKUP_FILE")"
  printf 'source_sha256=%s\n' "$SOURCE_SHA256"
  printf 'backup_host=%s\n' "$BACKUP_HOST"
  printf 'backup_tag=%s\n' "$BACKUP_TAG"
  printf 'integrity_check_subset=%s\n' "$CHECK_SUBSET"
} > "$STATUS_TEMP"
chmod 600 "$STATUS_TEMP"
mv "$STATUS_TEMP" "$STATUS_FILE"
trap - EXIT HUP INT TERM

echo "Encrypted off-site backup appended and integrity check completed for: $BACKUP_FILE"
