#!/bin/sh
set -eu

TEST_ROOT=$(mktemp -d)
TEST_APP_DIR="$TEST_ROOT/app"
TEST_BIN_DIR="$TEST_ROOT/bin"
TEST_LOG="$TEST_ROOT/commands.log"
DEPLOY_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$TEST_APP_DIR/deploy" "$TEST_APP_DIR/scripts" "$TEST_BIN_DIR"
: > "$TEST_APP_DIR/deploy/docker-compose.prod.yml"
: > "$TEST_APP_DIR/deploy/.env"
: > "$TEST_LOG"

cat > "$TEST_BIN_DIR/git" <<'EOF'
#!/bin/sh
set -eu
test "$1" = "rev-parse"
test "$2" = "HEAD"
printf '%s\n' "$FAKE_HEAD"
EOF

cat > "$TEST_BIN_DIR/docker" <<'EOF'
#!/bin/sh
set -eu
printf 'docker %s\n' "$*" >> "$FAKE_LOG"
if test "$1" = "image" && test "$2" = "inspect"; then
  test "${FAKE_MISSING_IMAGE:-}" != "$3"
fi
EOF

cat > "$TEST_APP_DIR/scripts/install_backup_cron.sh" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' 'backup-cron install' >> "$FAKE_LOG"
EOF

chmod 700 \
  "$TEST_BIN_DIR/git" \
  "$TEST_BIN_DIR/docker" \
  "$TEST_APP_DIR/scripts/install_backup_cron.sh"

run_stage() {
  PATH="$TEST_BIN_DIR:$PATH" \
    FAKE_HEAD="$DEPLOY_SHA" \
    FAKE_LOG="$TEST_LOG" \
    FAKE_MISSING_IMAGE="${FAKE_MISSING_IMAGE:-}" \
    SYSTEMFORGE_APP_DIR="$TEST_APP_DIR" \
    SYSTEMFORGE_RELEASE_CONFIRMATION="${FAKE_RELEASE_CONFIRMATION:-}" \
    sh scripts/stage_hetzner.sh "$DEPLOY_SHA"
}

set +e
run_stage >/dev/null 2>&1
UNAPPROVED_STATUS=$?
set -e
test "$UNAPPROVED_STATUS" -eq 78
test ! -s "$TEST_LOG"

FAKE_RELEASE_CONFIRMATION=AUTHORIZE_SYSTEMFORGE_PRODUCTION_RELEASE_WRONG
export FAKE_RELEASE_CONFIRMATION
set +e
run_stage >/dev/null 2>&1
WRONG_CONFIRMATION_STATUS=$?
set -e
test "$WRONG_CONFIRMATION_STATUS" -eq 78
test ! -s "$TEST_LOG"

FAKE_RELEASE_CONFIRMATION=AUTHORIZE_SYSTEMFORGE_PRODUCTION_RELEASE
export FAKE_RELEASE_CONFIRMATION
run_stage
grep -q '^backup-cron install$' "$TEST_LOG"
test "$(grep -c '^caddy ' "$TEST_LOG" || true)" -eq 0
test "$(grep -c 'docker compose ' "$TEST_LOG" || true)" -eq 0
test "$(grep -c '^docker image inspect ' "$TEST_LOG")" -eq 3

: > "$TEST_LOG"
FAKE_MISSING_IMAGE="systemforge-worker:$DEPLOY_SHA"
export FAKE_MISSING_IMAGE
set +e
run_stage >/dev/null 2>&1
MISSING_IMAGE_STATUS=$?
set -e
test "$MISSING_IMAGE_STATUS" -ne 0
test "$(grep -c '^backup-cron ' "$TEST_LOG" || true)" -eq 0
test "$(grep -c '^caddy ' "$TEST_LOG" || true)" -eq 0
test "$(grep -c 'docker compose ' "$TEST_LOG" || true)" -eq 0

echo "Hetzner staging tests passed."
