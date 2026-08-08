#!/bin/sh
set -eu

TEST_ROOT=$(mktemp -d)
APP_DIR="$TEST_ROOT/app"
BACKUP_DIR="$TEST_ROOT/backups"
CONFIG_FILE="$TEST_ROOT/offsite-backup.env"
BACKUP_STATUS="$BACKUP_DIR/offsite-backup.status"
RESTORE_STATUS="$BACKUP_DIR/offsite-restore.status"
CALL_LOG="$TEST_ROOT/calls.log"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$APP_DIR/apps/api/migrations" "$APP_DIR/scripts" "$BACKUP_DIR"
printf '%s\n' 'create table release_gate_test (id integer);' \
  > "$APP_DIR/apps/api/migrations/001_release_gate.sql"
printf '%s\n' 'RESTIC_REPOSITORY=sftp:test-backup:systemforge' > "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"
: > "$CALL_LOG"

cat > "$APP_DIR/scripts/run_backups.sh" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' backup >> "$FAKE_CALL_LOG"
# Cross a wall-clock second so the gate cannot reuse a pre-backup timestamp.
sleep 1.1
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
umask 077
{
  printf 'last_backup_utc=%s\n' "$STAMP"
  printf 'backup_host=systemforge-production\n'
  printf 'backup_tag=systemforge-postgres\n'
} > "$SYSTEMFORGE_OFFSITE_STATUS_FILE"
EOF

cat > "$APP_DIR/scripts/verify_offsite_restore.sh" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' restore >> "$FAKE_CALL_LOG"
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
umask 077
{
  printf 'last_restore_utc=%s\n' "$STAMP"
  printf 'migration_manifest_sha256=%s\n' "$SYSTEMFORGE_MIGRATION_MANIFEST_SHA256"
  printf 'backup_host=systemforge-production\n'
  printf 'backup_tag=systemforge-postgres\n'
} > "$SYSTEMFORGE_OFFSITE_RESTORE_STATUS_FILE"
EOF
chmod 700 \
  "$APP_DIR/scripts/run_backups.sh" \
  "$APP_DIR/scripts/verify_offsite_restore.sh"

run_gate() {
  FAKE_CALL_LOG="$CALL_LOG" \
    SYSTEMFORGE_APP_DIR="$APP_DIR" \
    SYSTEMFORGE_BACKUP_DIR="$BACKUP_DIR" \
    SYSTEMFORGE_OFFSITE_CONFIG="$CONFIG_FILE" \
    SYSTEMFORGE_OFFSITE_STATUS_FILE="$BACKUP_STATUS" \
    SYSTEMFORGE_OFFSITE_RESTORE_STATUS_FILE="$RESTORE_STATUS" \
    sh scripts/verify_release_backups.sh
}

run_gate
test "$(grep -c '^backup$' "$CALL_LOG")" -eq 1
test "$(grep -c '^restore$' "$CALL_LOG")" -eq 1
test "$(stat -c '%a' "$BACKUP_STATUS")" = 600
test "$(stat -c '%a' "$RESTORE_STATUS")" = 600

run_gate
test "$(grep -c '^backup$' "$CALL_LOG")" -eq 2
test "$(grep -c '^restore$' "$CALL_LOG")" -eq 1

printf '%s\n' 'alter table release_gate_test add column name text;' \
  >> "$APP_DIR/apps/api/migrations/001_release_gate.sql"
run_gate
test "$(grep -c '^backup$' "$CALL_LOG")" -eq 3
test "$(grep -c '^restore$' "$CALL_LOG")" -eq 2

chmod 644 "$CONFIG_FILE"
set +e
run_gate >/dev/null 2>&1
INSECURE_CONFIG_STATUS=$?
set -e
test "$INSECURE_CONFIG_STATUS" -ne 0
test "$(grep -c '^backup$' "$CALL_LOG")" -eq 3
chmod 600 "$CONFIG_FILE"

rm -f "$RESTORE_STATUS"
FAKE_RESTORE_FAILURE=true
export FAKE_RESTORE_FAILURE
cat > "$APP_DIR/scripts/verify_offsite_restore.sh" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' restore >> "$FAKE_CALL_LOG"
test "${FAKE_RESTORE_FAILURE:-false}" != true
EOF
chmod 700 "$APP_DIR/scripts/verify_offsite_restore.sh"
set +e
run_gate >/dev/null 2>&1
RESTORE_FAILURE_STATUS=$?
set -e
test "$RESTORE_FAILURE_STATUS" -ne 0
test ! -f "$RESTORE_STATUS"

echo "Production release backup gate tests passed."
