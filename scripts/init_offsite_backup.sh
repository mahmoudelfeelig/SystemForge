#!/bin/sh
set -eu

CONFIG_FILE=${SYSTEMFORGE_OFFSITE_CONFIG:-/etc/systemforge/offsite-backup.env}
RESTIC_BIN=${SYSTEMFORGE_RESTIC_BIN:-restic}

fail() {
  echo "Off-site repository initialization failed: $*" >&2
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

if "$RESTIC_BIN" cat config >/dev/null 2>&1; then
  echo "Encrypted off-site repository is already initialized and readable."
  exit 0
fi

"$RESTIC_BIN" init
"$RESTIC_BIN" check
echo "Encrypted off-site repository initialized and checked."
