#!/bin/sh
set -eu

APP_DIR=${SYSTEMFORGE_APP_DIR:-/opt/systemforge}
BACKUP_DIR=${SYSTEMFORGE_BACKUP_DIR:-/opt/systemforge-backups}
CONFIG_SOURCE=${1:-}
PASSWORD_SOURCE=${2:-}
RESTIC_SOURCE=${3:-}
TARGET_DIR=${SYSTEMFORGE_OFFSITE_TARGET_DIR:-"$BACKUP_DIR/.offsite"}
CONFIG_TARGET=${SYSTEMFORGE_OFFSITE_CONFIG:-"$TARGET_DIR/offsite-backup.env"}
PASSWORD_TARGET=${SYSTEMFORGE_RESTIC_PASSWORD_FILE:-"$TARGET_DIR/restic-password"}
RESTIC_BIN=${SYSTEMFORGE_RESTIC_BIN:-"$TARGET_DIR/restic"}
RESTIC_SHA256=${SYSTEMFORGE_RESTIC_SHA256:-}
INIT_OFFSITE=${SYSTEMFORGE_INIT_OFFSITE_BACKUP:-"$APP_DIR/scripts/init_offsite_backup.sh"}
INSTALL_CRON=${SYSTEMFORGE_INSTALL_BACKUP_CRON:-"$APP_DIR/scripts/install_backup_cron.sh"}
CONFIG_PREVIOUS=
PASSWORD_PREVIOUS=
RESTIC_PREVIOUS=
TARGETS_TOUCHED=false
SUCCESS=false

fail() {
  echo "Off-site backup provisioning failed: $*" >&2
  exit 1
}

secure_source() {
  FILE=$1
  LABEL=$2
  test -f "$FILE" || fail "$LABEL source does not exist: $FILE"
  test ! -L "$FILE" || fail "$LABEL source must not be a symbolic link: $FILE"
  test -r "$FILE" || fail "$LABEL source is not readable: $FILE"
  MODE=$(stat -c '%a' "$FILE")
  case "$MODE" in
    400 | 600) ;;
    *) fail "$LABEL source must use mode 0400 or 0600, not $MODE: $FILE" ;;
  esac
  OWNER_UID=$(stat -c '%u' "$FILE")
  test "$OWNER_UID" = "$(id -u)" || fail "$LABEL source must be owned by the effective user: $FILE"
}

secure_restic_source() {
  FILE=$1
  test -f "$FILE" || fail "restic source does not exist: $FILE"
  test ! -L "$FILE" || fail "restic source must not be a symbolic link: $FILE"
  test -r "$FILE" || fail "restic source is not readable: $FILE"
  MODE=$(stat -c '%a' "$FILE")
  case "$MODE" in
    500 | 600 | 700) ;;
    *) fail "restic source must use mode 0500, 0600, or 0700, not $MODE: $FILE" ;;
  esac
  OWNER_UID=$(stat -c '%u' "$FILE")
  test "$OWNER_UID" = "$(id -u)" || fail "restic source must be owned by the effective user: $FILE"
}

safe_target() {
  VALUE=$1
  LABEL=$2
  case "$VALUE" in
    "$TARGET_DIR"/*) ;;
    *) fail "$LABEL must stay below $TARGET_DIR." ;;
  esac
  test ! -L "$VALUE" || fail "$LABEL must not be a symbolic link: $VALUE"
}

restore_previous() {
  TARGET=$1
  PREVIOUS=$2
  MODE=$3
  if test -n "$PREVIOUS" && test -f "$PREVIOUS"; then
    install -m "$MODE" "$PREVIOUS" "$TARGET"
  else
    rm -f "$TARGET"
  fi
}

cleanup() {
  STATUS=$?
  trap - EXIT HUP INT TERM
  if test "$SUCCESS" != true && test "$TARGETS_TOUCHED" = true; then
    restore_previous "$CONFIG_TARGET" "$CONFIG_PREVIOUS" 0600
    restore_previous "$PASSWORD_TARGET" "$PASSWORD_PREVIOUS" 0600
    restore_previous "$RESTIC_BIN" "$RESTIC_PREVIOUS" 0700
  fi
  test -z "$CONFIG_PREVIOUS" || rm -f "$CONFIG_PREVIOUS"
  test -z "$PASSWORD_PREVIOUS" || rm -f "$PASSWORD_PREVIOUS"
  test -z "$RESTIC_PREVIOUS" || rm -f "$RESTIC_PREVIOUS"
  exit "$STATUS"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

test -n "$CONFIG_SOURCE" || fail "configuration source path is required."
test -n "$PASSWORD_SOURCE" || fail "repository password source path is required."
test -n "$RESTIC_SOURCE" || fail "restic source path is required."
case "$BACKUP_DIR" in
  /*) ;;
  *) fail "backup directory must be absolute." ;;
esac
test "$BACKUP_DIR" != / || fail "backup directory is too broad."
case "$TARGET_DIR" in
  "$BACKUP_DIR"/*) ;;
  *) fail "target directory must stay below $BACKUP_DIR." ;;
esac
test ! -L "$BACKUP_DIR" || fail "backup directory must not be a symbolic link: $BACKUP_DIR"
test ! -L "$TARGET_DIR" || fail "target directory must not be a symbolic link: $TARGET_DIR"
safe_target "$CONFIG_TARGET" "configuration target"
safe_target "$PASSWORD_TARGET" "repository password target"
safe_target "$RESTIC_BIN" "restic target"
secure_source "$CONFIG_SOURCE" "configuration"
secure_source "$PASSWORD_SOURCE" "repository password"
secure_restic_source "$RESTIC_SOURCE"
case "$RESTIC_SHA256" in
  '' | *[!0-9a-f]*) fail "SYSTEMFORGE_RESTIC_SHA256 must be a lowercase SHA-256 digest." ;;
esac
test "${#RESTIC_SHA256}" -eq 64 \
  || fail "SYSTEMFORGE_RESTIC_SHA256 must contain exactly 64 characters."
SOURCE_SHA256=$(sha256sum "$RESTIC_SOURCE")
SOURCE_SHA256=${SOURCE_SHA256%% *}
test "$SOURCE_SHA256" = "$RESTIC_SHA256" || fail "restic source checksum does not match the pinned release."
test -x "$INIT_OFFSITE" || fail "repository initializer is not executable: $INIT_OFFSITE"
test -x "$INSTALL_CRON" || fail "backup schedule installer is not executable: $INSTALL_CRON"

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
if test -f "$CONFIG_TARGET"; then
  CONFIG_PREVIOUS=$(mktemp)
  cp "$CONFIG_TARGET" "$CONFIG_PREVIOUS"
fi
if test -f "$PASSWORD_TARGET"; then
  PASSWORD_PREVIOUS=$(mktemp)
  cp "$PASSWORD_TARGET" "$PASSWORD_PREVIOUS"
fi
if test -f "$RESTIC_BIN"; then
  RESTIC_PREVIOUS=$(mktemp)
  cp "$RESTIC_BIN" "$RESTIC_PREVIOUS"
fi

install -d -m 0700 "$TARGET_DIR"
TARGETS_TOUCHED=true
install -m 0600 "$CONFIG_SOURCE" "$CONFIG_TARGET"
install -m 0600 "$PASSWORD_SOURCE" "$PASSWORD_TARGET"
install -m 0700 "$RESTIC_SOURCE" "$RESTIC_BIN"
INSTALLED_SHA256=$(sha256sum "$RESTIC_BIN")
INSTALLED_SHA256=${INSTALLED_SHA256%% *}
test "$INSTALLED_SHA256" = "$RESTIC_SHA256" || fail "installed restic checksum changed unexpectedly."
"$RESTIC_BIN" version >/dev/null

SYSTEMFORGE_OFFSITE_CONFIG="$CONFIG_TARGET" \
  SYSTEMFORGE_RESTIC_BIN="$RESTIC_BIN" \
  "$INIT_OFFSITE"
SYSTEMFORGE_APP_DIR="$APP_DIR" \
  SYSTEMFORGE_BACKUP_DIR="$BACKUP_DIR" \
  SYSTEMFORGE_OFFSITE_CONFIG="$CONFIG_TARGET" \
  SYSTEMFORGE_RESTIC_BIN="$RESTIC_BIN" \
  "$INSTALL_CRON"

SUCCESS=true
echo "Encrypted off-site backup repository and nightly schedule are provisioned."
