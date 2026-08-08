#!/bin/sh
set -eu

TEST_ROOT=$(mktemp -d)
FAKE_BIN="$TEST_ROOT/bin"
SOURCE_DIR="$TEST_ROOT/source"
CONFIG_SOURCE="$SOURCE_DIR/offsite-backup.env"
PASSWORD_SOURCE="$SOURCE_DIR/restic-password"
EVENTS="$TEST_ROOT/events"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

TARGET_DIR="$TEST_ROOT/etc/systemforge"
CONFIG_TARGET="$TARGET_DIR/offsite-backup.env"
PASSWORD_TARGET="$TARGET_DIR/restic-password"
mkdir -p "$FAKE_BIN" "$SOURCE_DIR"
printf '%s\n' 'RESTIC_REPOSITORY=s3:https://example.r2.cloudflarestorage.com/systemforge' \
  "RESTIC_PASSWORD_FILE=$PASSWORD_TARGET" > "$CONFIG_SOURCE"
printf '%s\n' 'test-repository-password' > "$PASSWORD_SOURCE"
chmod 600 "$CONFIG_SOURCE" "$PASSWORD_SOURCE"

cat > "$FAKE_BIN/restic" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$FAKE_BIN/sudo" <<'EOF'
#!/bin/sh
set -eu
test "${1:-}" != -n || shift
exec "$@"
EOF
cat > "$TEST_ROOT/init" <<'EOF'
#!/bin/sh
set -eu
printf 'init:%s\n' "$SYSTEMFORGE_OFFSITE_CONFIG" >> "$FAKE_EVENTS"
test "${FAKE_INIT_FAILURE:-false}" != true
EOF
cat > "$TEST_ROOT/cron" <<'EOF'
#!/bin/sh
set -eu
printf 'cron:%s\n' "$SYSTEMFORGE_APP_DIR" >> "$FAKE_EVENTS"
EOF
chmod +x "$FAKE_BIN/restic" "$FAKE_BIN/sudo" "$TEST_ROOT/init" "$TEST_ROOT/cron"

PATH="$FAKE_BIN:$PATH" \
FAKE_EVENTS="$EVENTS" \
SYSTEMFORGE_APP_DIR="$PWD" \
SYSTEMFORGE_OFFSITE_TARGET_DIR="$TARGET_DIR" \
SYSTEMFORGE_OFFSITE_CONFIG="$CONFIG_TARGET" \
SYSTEMFORGE_RESTIC_PASSWORD_FILE="$PASSWORD_TARGET" \
SYSTEMFORGE_INIT_OFFSITE_BACKUP="$TEST_ROOT/init" \
SYSTEMFORGE_INSTALL_BACKUP_CRON="$TEST_ROOT/cron" \
  sh scripts/provision_offsite_backup.sh "$CONFIG_SOURCE" "$PASSWORD_SOURCE"

test "$(stat -c '%a' "$CONFIG_TARGET")" = 600
test "$(stat -c '%a' "$PASSWORD_TARGET")" = 600
cmp "$CONFIG_SOURCE" "$CONFIG_TARGET"
cmp "$PASSWORD_SOURCE" "$PASSWORD_TARGET"
grep -Fq "init:$CONFIG_TARGET" "$EVENTS"
grep -Fq "cron:$PWD" "$EVENTS"

printf '%s\n' 'previous-config' > "$CONFIG_TARGET"
printf '%s\n' 'previous-password' > "$PASSWORD_TARGET"
chmod 600 "$CONFIG_TARGET" "$PASSWORD_TARGET"
set +e
PATH="$FAKE_BIN:$PATH" \
FAKE_EVENTS="$EVENTS" \
FAKE_INIT_FAILURE=true \
SYSTEMFORGE_APP_DIR="$PWD" \
SYSTEMFORGE_OFFSITE_TARGET_DIR="$TARGET_DIR" \
SYSTEMFORGE_OFFSITE_CONFIG="$CONFIG_TARGET" \
SYSTEMFORGE_RESTIC_PASSWORD_FILE="$PASSWORD_TARGET" \
SYSTEMFORGE_INIT_OFFSITE_BACKUP="$TEST_ROOT/init" \
SYSTEMFORGE_INSTALL_BACKUP_CRON="$TEST_ROOT/cron" \
  sh scripts/provision_offsite_backup.sh "$CONFIG_SOURCE" "$PASSWORD_SOURCE"
FAILURE_STATUS=$?
set -e
test "$FAILURE_STATUS" -ne 0
test "$(cat "$CONFIG_TARGET")" = previous-config
test "$(cat "$PASSWORD_TARGET")" = previous-password

chmod 644 "$CONFIG_SOURCE"
set +e
PATH="$FAKE_BIN:$PATH" \
SYSTEMFORGE_APP_DIR="$PWD" \
SYSTEMFORGE_OFFSITE_TARGET_DIR="$TARGET_DIR" \
SYSTEMFORGE_OFFSITE_CONFIG="$CONFIG_TARGET" \
SYSTEMFORGE_RESTIC_PASSWORD_FILE="$PASSWORD_TARGET" \
SYSTEMFORGE_INIT_OFFSITE_BACKUP="$TEST_ROOT/init" \
SYSTEMFORGE_INSTALL_BACKUP_CRON="$TEST_ROOT/cron" \
  sh scripts/provision_offsite_backup.sh "$CONFIG_SOURCE" "$PASSWORD_SOURCE"
MODE_STATUS=$?
set -e
test "$MODE_STATUS" -ne 0

echo "Off-site backup provisioning tests passed."
