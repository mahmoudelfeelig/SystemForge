#!/bin/sh
set -eu

APP_DIR=${SYSTEMFORGE_APP_DIR:-/opt/systemforge}
BACKUP_DIR=${SYSTEMFORGE_BACKUP_DIR:-/opt/systemforge-backups}
CONFIG_FILE=${SYSTEMFORGE_OFFSITE_CONFIG:-/etc/systemforge/offsite-backup.env}
RESTIC_BIN=${SYSTEMFORGE_RESTIC_BIN:-restic}
BACKUP_HOST=${SYSTEMFORGE_RESTIC_HOST:-systemforge-production}
BACKUP_TAG=${SYSTEMFORGE_RESTIC_TAG:-systemforge-postgres}
RESTORE_VERIFIER=${SYSTEMFORGE_RESTORE_VERIFIER:-"$APP_DIR/scripts/verify_backup_restore.sh"}
STATUS_FILE=${SYSTEMFORGE_OFFSITE_RESTORE_STATUS_FILE:-"$BACKUP_DIR/offsite-restore.status"}

fail() {
  echo "Off-site restore drill failed: $*" >&2
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

case "$BACKUP_DIR" in
  '' | /) fail "backup directory is too broad." ;;
esac
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
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
command -v "$RESTIC_BIN" >/dev/null 2>&1 || fail "restic binary was not found: $RESTIC_BIN"
test -x "$RESTORE_VERIFIER" || fail "restore verifier is not executable: $RESTORE_VERIFIER"

RESTORE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/systemforge-offsite-restore.XXXXXX")
STATUS_TEMP=""
cleanup() {
  rm -rf "$RESTORE_DIR"
  if test -n "$STATUS_TEMP"; then
    rm -f "$STATUS_TEMP"
  fi
}
trap cleanup EXIT HUP INT TERM

"$RESTIC_BIN" snapshots --host "$BACKUP_HOST" --tag "$BACKUP_TAG" --latest 1 --json >/dev/null
"$RESTIC_BIN" restore latest \
  --host "$BACKUP_HOST" \
  --tag "$BACKUP_TAG" \
  --target "$RESTORE_DIR"

DUMP_COUNT=$(find "$RESTORE_DIR" -type f -name 'systemforge.*.dump' | wc -l)
test "$DUMP_COUNT" -eq 1 || fail "expected exactly one restored PostgreSQL dump, found $DUMP_COUNT."
RESTORED_DUMP=$(find "$RESTORE_DIR" -type f -name 'systemforge.*.dump' -print)
"$RESTORE_VERIFIER" "$RESTORED_DUMP"

RESTORED_SHA256=$(sha256sum "$RESTORED_DUMP")
RESTORED_SHA256=${RESTORED_SHA256%% *}
MIGRATION_MANIFEST_SHA256=${SYSTEMFORGE_MIGRATION_MANIFEST_SHA256:-$(
  cd "$APP_DIR"
  find apps/api/migrations -type f -name '*.sql' -print \
    | LC_ALL=C sort \
    | while IFS= read -r migration; do sha256sum "$migration"; done \
    | sha256sum \
    | cut -d ' ' -f 1
)}
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STATUS_TEMP="$STATUS_FILE.partial.$$"
umask 077
{
  printf 'last_restore_utc=%s\n' "$STAMP"
  printf 'restored_filename=%s\n' "$(basename "$RESTORED_DUMP")"
  printf 'restored_sha256=%s\n' "$RESTORED_SHA256"
  printf 'migration_manifest_sha256=%s\n' "$MIGRATION_MANIFEST_SHA256"
  printf 'backup_host=%s\n' "$BACKUP_HOST"
  printf 'backup_tag=%s\n' "$BACKUP_TAG"
} > "$STATUS_TEMP"
chmod 600 "$STATUS_TEMP"
mv "$STATUS_TEMP" "$STATUS_FILE"
STATUS_TEMP=""

cleanup
trap - EXIT HUP INT TERM
echo "Verified an independently restored off-site PostgreSQL backup."
