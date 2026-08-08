#!/bin/sh
set -eu

TEST_ROOT=$(mktemp -d)
TEST_BIN_DIR="$TEST_ROOT/bin"
BACKUP_DIR="$TEST_ROOT/backups"
CONFIG_FILE="$TEST_ROOT/offsite-backup.env"
PASSWORD_FILE="$TEST_ROOT/restic-password"
RESTIC_LOG="$TEST_ROOT/restic.log"
VERIFY_LOG="$TEST_ROOT/verify.log"
STATUS_FILE="$TEST_ROOT/offsite-backup.status"
RESTORE_STATUS_FILE="$TEST_ROOT/offsite-restore.status"
SOURCE_DUMP="$BACKUP_DIR/systemforge.20260808T120000Z.dump"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$TEST_BIN_DIR" "$BACKUP_DIR"
printf '%s\n' 'test repository password' > "$PASSWORD_FILE"
chmod 600 "$PASSWORD_FILE"
printf 'RESTIC_REPOSITORY=sftp:test-backup:systemforge\nRESTIC_PASSWORD_FILE=%s\n' \
  "$PASSWORD_FILE" > "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"
printf '%s\n' 'verified PostgreSQL custom dump' > "$SOURCE_DUMP"
chmod 600 "$SOURCE_DUMP"
: > "$RESTIC_LOG"
: > "$VERIFY_LOG"

cat > "$TEST_BIN_DIR/restic" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_RESTIC_LOG"
case "$1" in
  cat)
    test "${FAKE_REPOSITORY_READY:-true}" = true
    ;;
  snapshots)
    test "${FAKE_REPOSITORY_READY:-true}" = true
    ;;
  backup)
    test "${FAKE_BACKUP_FAILURE:-false}" != true
    ;;
  forget)
    test "${FAKE_FORGET_FAILURE:-false}" != true
    ;;
  check)
    test "${FAKE_CHECK_FAILURE:-false}" != true
    ;;
  restore)
    test "${FAKE_RESTORE_FAILURE:-false}" != true
    TARGET=""
    shift
    while test "$#" -gt 0; do
      if test "$1" = "--target"; then
        shift
        TARGET=$1
      fi
      shift
    done
    test -n "$TARGET"
    if test "${FAKE_RESTORE_EMPTY:-false}" != true; then
      mkdir -p "$TARGET/restored"
      cp "$FAKE_SOURCE_DUMP" "$TARGET/restored/$(basename "$FAKE_SOURCE_DUMP")"
    fi
    ;;
  init) ;;
  *) exit 64 ;;
esac
EOF

cat > "$TEST_BIN_DIR/verify-restore" <<'EOF'
#!/bin/sh
set -eu
test "$#" -eq 1
test -f "$1"
printf '%s\n' "$1" >> "$FAKE_VERIFY_LOG"
EOF
chmod 700 "$TEST_BIN_DIR/restic" "$TEST_BIN_DIR/verify-restore"

run_backup() {
  FAKE_RESTIC_LOG="$RESTIC_LOG" \
    FAKE_REPOSITORY_READY="${FAKE_REPOSITORY_READY:-true}" \
    FAKE_BACKUP_FAILURE="${FAKE_BACKUP_FAILURE:-false}" \
    FAKE_FORGET_FAILURE="${FAKE_FORGET_FAILURE:-false}" \
    FAKE_CHECK_FAILURE="${FAKE_CHECK_FAILURE:-false}" \
    SYSTEMFORGE_BACKUP_DIR="$BACKUP_DIR" \
    SYSTEMFORGE_OFFSITE_CONFIG="$CONFIG_FILE" \
    SYSTEMFORGE_RESTIC_BIN="$TEST_BIN_DIR/restic" \
    SYSTEMFORGE_OFFSITE_STATUS_FILE="$STATUS_FILE" \
    sh scripts/backup_offsite.sh
}

run_restore() {
  FAKE_RESTIC_LOG="$RESTIC_LOG" \
    FAKE_VERIFY_LOG="$VERIFY_LOG" \
    FAKE_SOURCE_DUMP="$SOURCE_DUMP" \
    FAKE_REPOSITORY_READY="${FAKE_REPOSITORY_READY:-true}" \
    FAKE_RESTORE_FAILURE="${FAKE_RESTORE_FAILURE:-false}" \
    FAKE_RESTORE_EMPTY="${FAKE_RESTORE_EMPTY:-false}" \
    SYSTEMFORGE_APP_DIR="$PWD" \
    SYSTEMFORGE_BACKUP_DIR="$BACKUP_DIR" \
    SYSTEMFORGE_OFFSITE_CONFIG="$CONFIG_FILE" \
    SYSTEMFORGE_RESTIC_BIN="$TEST_BIN_DIR/restic" \
    SYSTEMFORGE_RESTORE_VERIFIER="$TEST_BIN_DIR/verify-restore" \
    SYSTEMFORGE_OFFSITE_RESTORE_STATUS_FILE="$RESTORE_STATUS_FILE" \
    sh scripts/verify_offsite_restore.sh
}

run_backup
grep -q '^snapshots --host systemforge-production --tag systemforge-postgres --json$' "$RESTIC_LOG"
grep -q '^backup --host systemforge-production --tag systemforge-postgres --skip-if-unchanged systemforge.20260808T120000Z.dump$' "$RESTIC_LOG"
grep -q '^forget --host systemforge-production --tag systemforge-postgres --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune$' "$RESTIC_LOG"
grep -q '^check --read-data-subset=5%$' "$RESTIC_LOG"
test "$(stat -c '%a' "$STATUS_FILE")" = 600
grep -q '^source_filename=systemforge.20260808T120000Z.dump$' "$STATUS_FILE"
grep -q "^source_sha256=$(sha256sum "$SOURCE_DUMP" | cut -d ' ' -f 1)$" "$STATUS_FILE"

: > "$RESTIC_LOG"
rm -f "$STATUS_FILE"
FAKE_REPOSITORY_READY=false
export FAKE_REPOSITORY_READY
set +e
run_backup >/dev/null 2>&1
UNINITIALIZED_STATUS=$?
set -e
test "$UNINITIALIZED_STATUS" -ne 0
test ! -f "$STATUS_FILE"
test "$(grep -c '^backup ' "$RESTIC_LOG" || true)" -eq 0

FAKE_REPOSITORY_READY=true
export FAKE_REPOSITORY_READY
chmod 644 "$CONFIG_FILE"
set +e
run_backup >/dev/null 2>&1
INSECURE_CONFIG_STATUS=$?
set -e
test "$INSECURE_CONFIG_STATUS" -ne 0
chmod 600 "$CONFIG_FILE"

printf 'RESTIC_REPOSITORY=/tmp/not-independent\nRESTIC_PASSWORD_FILE=%s\n' \
  "$PASSWORD_FILE" > "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"
set +e
run_backup >/dev/null 2>&1
LOCAL_REPOSITORY_STATUS=$?
set -e
test "$LOCAL_REPOSITORY_STATUS" -ne 0
printf 'RESTIC_REPOSITORY=sftp:test-backup:systemforge\nRESTIC_PASSWORD_FILE=%s\n' \
  "$PASSWORD_FILE" > "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"

FAKE_CHECK_FAILURE=true
export FAKE_CHECK_FAILURE
set +e
run_backup >/dev/null 2>&1
CHECK_FAILURE_STATUS=$?
set -e
test "$CHECK_FAILURE_STATUS" -ne 0
test ! -f "$STATUS_FILE"
FAKE_CHECK_FAILURE=false
export FAKE_CHECK_FAILURE

: > "$RESTIC_LOG"
FAKE_REPOSITORY_READY=false \
  FAKE_RESTIC_LOG="$RESTIC_LOG" \
  SYSTEMFORGE_OFFSITE_CONFIG="$CONFIG_FILE" \
  SYSTEMFORGE_RESTIC_BIN="$TEST_BIN_DIR/restic" \
  sh scripts/init_offsite_backup.sh
grep -q '^cat config$' "$RESTIC_LOG"
grep -q '^init$' "$RESTIC_LOG"
grep -q '^check$' "$RESTIC_LOG"

: > "$RESTIC_LOG"
FAKE_REPOSITORY_READY=true \
  FAKE_RESTIC_LOG="$RESTIC_LOG" \
  SYSTEMFORGE_OFFSITE_CONFIG="$CONFIG_FILE" \
  SYSTEMFORGE_RESTIC_BIN="$TEST_BIN_DIR/restic" \
  sh scripts/init_offsite_backup.sh
test "$(wc -l < "$RESTIC_LOG")" -eq 1
grep -q '^cat config$' "$RESTIC_LOG"

: > "$RESTIC_LOG"
run_restore
grep -q '^snapshots --host systemforge-production --tag systemforge-postgres --latest 1 --json$' "$RESTIC_LOG"
grep -q '^restore latest --host systemforge-production --tag systemforge-postgres --target ' "$RESTIC_LOG"
test "$(wc -l < "$VERIFY_LOG")" -eq 1
test "$(stat -c '%a' "$RESTORE_STATUS_FILE")" = 600
grep -q '^restored_filename=systemforge.20260808T120000Z.dump$' "$RESTORE_STATUS_FILE"
grep -Eq '^migration_manifest_sha256=[0-9a-f]{64}$' "$RESTORE_STATUS_FILE"

rm -f "$RESTORE_STATUS_FILE"
FAKE_RESTORE_EMPTY=true
export FAKE_RESTORE_EMPTY
set +e
run_restore >/dev/null 2>&1
EMPTY_RESTORE_STATUS=$?
set -e
test "$EMPTY_RESTORE_STATUS" -ne 0
test ! -f "$RESTORE_STATUS_FILE"

CRONTAB_OUTPUT="$TEST_ROOT/crontab.txt"
CRON_BACKUP_DIR="$TEST_ROOT/cron-backups"
cat > "$TEST_BIN_DIR/crontab" <<'EOF'
#!/bin/sh
set -eu
if test "${1:-}" = "-l"; then
  printf '%s\n' '5 1 * * * unrelated-command'
  exit 0
fi
test "$#" -eq 1
cp "$1" "$FAKE_CRONTAB_OUTPUT"
EOF
chmod 700 "$TEST_BIN_DIR/crontab"
PATH="$TEST_BIN_DIR:$PATH" \
  FAKE_CRONTAB_OUTPUT="$CRONTAB_OUTPUT" \
  SYSTEMFORGE_APP_DIR=/opt/systemforge \
  SYSTEMFORGE_BACKUP_DIR="$CRON_BACKUP_DIR" \
  sh scripts/install_backup_cron.sh
test -d "$CRON_BACKUP_DIR"
test "$(stat -c '%a' "$CRON_BACKUP_DIR")" = 700
grep -q '^5 1 \* \* \* unrelated-command$' "$CRONTAB_OUTPUT"
grep -q '/opt/systemforge/scripts/run_backups.sh' "$CRONTAB_OUTPUT"
grep -q "SYSTEMFORGE_OFFSITE_CONFIG=$CRON_BACKUP_DIR/.offsite/offsite-backup.env" "$CRONTAB_OUTPUT"
grep -q "SYSTEMFORGE_RESTIC_BIN=$CRON_BACKUP_DIR/.offsite/restic" "$CRONTAB_OUTPUT"
grep -q ">> $CRON_BACKUP_DIR/backup.log 2>&1" "$CRONTAB_OUTPUT"
test "$(grep -c '# systemforge-postgres-backup' "$CRONTAB_OUTPUT")" -eq 1

set +e
PATH="$TEST_BIN_DIR:$PATH" \
  FAKE_CRONTAB_OUTPUT="$CRONTAB_OUTPUT" \
  SYSTEMFORGE_APP_DIR=/opt/systemforge \
  SYSTEMFORGE_BACKUP_DIR="$TEST_ROOT/unsafe cron path" \
  sh scripts/install_backup_cron.sh >/dev/null 2>&1
UNSAFE_CRON_STATUS=$?
set -e
test "$UNSAFE_CRON_STATUS" -eq 64

WRAPPER_APP="$TEST_ROOT/wrapper-app"
WRAPPER_LOG="$TEST_ROOT/wrapper.log"
WRAPPER_CONFIG="$TEST_ROOT/wrapper-offsite.env"
mkdir -p "$WRAPPER_APP/scripts"
cat > "$WRAPPER_APP/scripts/backup_postgres.sh" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' local >> "$FAKE_WRAPPER_LOG"
EOF
cat > "$WRAPPER_APP/scripts/backup_offsite.sh" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' offsite >> "$FAKE_WRAPPER_LOG"
EOF
chmod 700 \
  "$WRAPPER_APP/scripts/backup_postgres.sh" \
  "$WRAPPER_APP/scripts/backup_offsite.sh"
: > "$WRAPPER_LOG"
FAKE_WRAPPER_LOG="$WRAPPER_LOG" \
  SYSTEMFORGE_APP_DIR="$WRAPPER_APP" \
  SYSTEMFORGE_OFFSITE_CONFIG="$WRAPPER_CONFIG" \
  sh scripts/run_backups.sh
test "$(cat "$WRAPPER_LOG")" = local
: > "$WRAPPER_CONFIG"
chmod 600 "$WRAPPER_CONFIG"
FAKE_WRAPPER_LOG="$WRAPPER_LOG" \
  SYSTEMFORGE_APP_DIR="$WRAPPER_APP" \
  SYSTEMFORGE_OFFSITE_CONFIG="$WRAPPER_CONFIG" \
  sh scripts/run_backups.sh
test "$(tail -2 "$WRAPPER_LOG" | tr '\n' ' ')" = "local offsite "

echo "Off-site backup safety and restore tests passed."
