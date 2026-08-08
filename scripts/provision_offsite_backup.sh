#!/bin/sh
set -eu

APP_DIR=${SYSTEMFORGE_APP_DIR:-/opt/systemforge}
CONFIG_SOURCE=${1:-}
PASSWORD_SOURCE=${2:-}
TARGET_DIR=${SYSTEMFORGE_OFFSITE_TARGET_DIR:-/etc/systemforge}
CONFIG_TARGET=${SYSTEMFORGE_OFFSITE_CONFIG:-"$TARGET_DIR/offsite-backup.env"}
PASSWORD_TARGET=${SYSTEMFORGE_RESTIC_PASSWORD_FILE:-"$TARGET_DIR/restic-password"}
RESTIC_BIN=${SYSTEMFORGE_RESTIC_BIN:-restic}
INIT_OFFSITE=${SYSTEMFORGE_INIT_OFFSITE_BACKUP:-"$APP_DIR/scripts/init_offsite_backup.sh"}
INSTALL_CRON=${SYSTEMFORGE_INSTALL_BACKUP_CRON:-"$APP_DIR/scripts/install_backup_cron.sh"}
CONFIG_PREVIOUS=
PASSWORD_PREVIOUS=
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
  if test -n "$PREVIOUS" && test -f "$PREVIOUS"; then
    sudo -n install -o "$(id -un)" -g "$(id -gn)" -m 0600 "$PREVIOUS" "$TARGET"
  else
    sudo -n rm -f "$TARGET"
  fi
}

cleanup() {
  STATUS=$?
  trap - EXIT HUP INT TERM
  if test "$SUCCESS" != true && test "$TARGETS_TOUCHED" = true; then
    restore_previous "$CONFIG_TARGET" "$CONFIG_PREVIOUS"
    restore_previous "$PASSWORD_TARGET" "$PASSWORD_PREVIOUS"
  fi
  test -z "$CONFIG_PREVIOUS" || rm -f "$CONFIG_PREVIOUS"
  test -z "$PASSWORD_PREVIOUS" || rm -f "$PASSWORD_PREVIOUS"
  exit "$STATUS"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

test -n "$CONFIG_SOURCE" || fail "configuration source path is required."
test -n "$PASSWORD_SOURCE" || fail "repository password source path is required."
case "$TARGET_DIR" in
  /*) ;;
  *) fail "target directory must be absolute." ;;
esac
test "$TARGET_DIR" != / || fail "target directory is too broad."
test ! -L "$TARGET_DIR" || fail "target directory must not be a symbolic link: $TARGET_DIR"
safe_target "$CONFIG_TARGET" "configuration target"
safe_target "$PASSWORD_TARGET" "repository password target"
secure_source "$CONFIG_SOURCE" "configuration"
secure_source "$PASSWORD_SOURCE" "repository password"
test -x "$INIT_OFFSITE" || fail "repository initializer is not executable: $INIT_OFFSITE"
test -x "$INSTALL_CRON" || fail "backup schedule installer is not executable: $INSTALL_CRON"
sudo -n true || fail "passwordless sudo is required for production backup provisioning."

if ! command -v "$RESTIC_BIN" >/dev/null 2>&1; then
  sudo -n apt-get update
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y restic
fi
command -v "$RESTIC_BIN" >/dev/null 2>&1 || fail "restic is unavailable after package installation."

umask 077
if test -f "$CONFIG_TARGET"; then
  CONFIG_PREVIOUS=$(mktemp)
  cp "$CONFIG_TARGET" "$CONFIG_PREVIOUS"
fi
if test -f "$PASSWORD_TARGET"; then
  PASSWORD_PREVIOUS=$(mktemp)
  cp "$PASSWORD_TARGET" "$PASSWORD_PREVIOUS"
fi

sudo -n install -d -o "$(id -un)" -g "$(id -gn)" -m 0700 "$TARGET_DIR"
TARGETS_TOUCHED=true
sudo -n install -o "$(id -un)" -g "$(id -gn)" -m 0600 "$CONFIG_SOURCE" "$CONFIG_TARGET"
sudo -n install -o "$(id -un)" -g "$(id -gn)" -m 0600 "$PASSWORD_SOURCE" "$PASSWORD_TARGET"

SYSTEMFORGE_OFFSITE_CONFIG="$CONFIG_TARGET" \
  SYSTEMFORGE_RESTIC_BIN="$RESTIC_BIN" \
  "$INIT_OFFSITE"
SYSTEMFORGE_APP_DIR="$APP_DIR" "$INSTALL_CRON"

SUCCESS=true
echo "Encrypted off-site backup repository and nightly schedule are provisioned."
