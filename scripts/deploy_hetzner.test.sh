#!/bin/sh
set -eu

TEST_ROOT=$(mktemp -d)
TEST_APP_DIR="$TEST_ROOT/app"
TEST_BIN_DIR="$TEST_ROOT/bin"
TEST_LOG="$TEST_ROOT/commands.log"
NEW_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PREVIOUS_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

grep -Fq 'MAX_STORED_RUNS: ${MAX_STORED_RUNS:-250}' deploy/docker-compose.prod.yml
grep -Fq 'MAX_SHARED_SCENARIOS: ${MAX_SHARED_SCENARIOS:-2000}' deploy/docker-compose.prod.yml
grep -Fq 'MAX_CANONICAL_RESULT_BYTES: ${MAX_CANONICAL_RESULT_BYTES:-8500000}' deploy/docker-compose.prod.yml

mkdir -p "$TEST_APP_DIR/deploy" "$TEST_APP_DIR/scripts" "$TEST_BIN_DIR"
: > "$TEST_APP_DIR/deploy/docker-compose.prod.yml"
: > "$TEST_APP_DIR/deploy/.env"

cat > "$TEST_BIN_DIR/git" <<'EOF'
#!/bin/sh
set -eu
if test "$1" = "rev-parse" && test "$2" = "HEAD"; then
  printf '%s\n' "$FAKE_HEAD"
  exit 0
fi
exit 2
EOF

cat > "$TEST_BIN_DIR/docker" <<'EOF'
#!/bin/sh
set -eu
printf 'tag=%s docker %s\n' "${SYSTEMFORGE_IMAGE_TAG:-}" "$*" >> "$FAKE_LOG"
if test "$1" = "network" && test "$2" = "inspect"; then
  exit 0
fi
if test "$1" = "image" && test "$2" = "inspect"; then
  case "${FAKE_PREVIOUS_IMAGES:-none}:$3" in
    all:*) exit 0 ;;
    api-only:systemforge-api:*) exit 0 ;;
    *) exit 1 ;;
  esac
fi
case " $* " in
  *" build "*)
    test "${FAKE_BUILD_FAILURE:-false}" != "true"
    ;;
esac
exit 0
EOF

cat > "$TEST_BIN_DIR/curl" <<'EOF'
#!/bin/sh
set -eu
printf 'curl %s\n' "$*" >> "$FAKE_LOG"
if test "${FAKE_EXTERNAL_FAILURE:-false}" = "true"; then
  exit 22
fi
case "$*" in
  *"/api/health/ready"*) printf '%s\n' '{"status":"ready"}' ;;
  *) printf '%s\n' 'SystemForge' ;;
esac
EOF

cat > "$TEST_APP_DIR/scripts/verify_release_backups.sh" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' 'release backup' >> "$FAKE_LOG"
printf '%s\n' 'release offsite restore' >> "$FAKE_LOG"
test "${FAKE_OFFSITE_FAILURE:-false}" != true
EOF

cat > "$TEST_APP_DIR/scripts/install_caddy_route.sh" <<'EOF'
#!/bin/sh
set -eu
printf 'caddy %s\n' "$1" >> "$FAKE_LOG"
if test "$1" = open && test "${FAKE_CADDY_FAILURE:-false}" = true; then
  exit 1
fi
EOF

chmod 700 \
  "$TEST_BIN_DIR/git" \
  "$TEST_BIN_DIR/docker" \
  "$TEST_BIN_DIR/curl" \
  "$TEST_APP_DIR/scripts/install_caddy_route.sh" \
  "$TEST_APP_DIR/scripts/verify_release_backups.sh"

run_deploy() {
  : > "$TEST_LOG"
  PATH="$TEST_BIN_DIR:$PATH" \
    FAKE_LOG="$TEST_LOG" \
    FAKE_HEAD="$NEW_SHA" \
    FAKE_PREVIOUS_IMAGES="${FAKE_PREVIOUS_IMAGES:-none}" \
    FAKE_EXTERNAL_FAILURE="${FAKE_EXTERNAL_FAILURE:-false}" \
    FAKE_CADDY_FAILURE="${FAKE_CADDY_FAILURE:-false}" \
    SYSTEMFORGE_APP_DIR="$TEST_APP_DIR" \
    SYSTEMFORGE_RELEASE_APPROVED=I_AM_READY_FOR_PRODUCTION \
    SYSTEMFORGE_EXTERNAL_SMOKE_URL="${FAKE_EXTERNAL_SMOKE_URL:-}" \
    SYSTEMFORGE_SKIP_BUILD="${FAKE_SKIP_BUILD:-false}" \
    sh scripts/deploy_hetzner.sh "$NEW_SHA"
}

FAKE_EXTERNAL_SMOKE_URL=https://systemforge.example.test
export FAKE_EXTERNAL_SMOKE_URL
run_deploy
test "$(cat "$TEST_APP_DIR/.last-successful-sha")" = "$NEW_SHA"
test "$(grep -c '^curl ' "$TEST_LOG")" -eq 2
grep -q 'https://systemforge.example.test/$' "$TEST_LOG"
grep -q 'https://systemforge.example.test/api/health/ready' "$TEST_LOG"
grep -q '/app/apps/api/overload_smoke.mjs' "$TEST_LOG"
grep -q '^release backup$' "$TEST_LOG"
grep -q '^release offsite restore$' "$TEST_LOG"
grep -q '^caddy open$' "$TEST_LOG"
test "$(grep -n '^caddy open$' "$TEST_LOG" | cut -d: -f1)" -lt \
  "$(grep -n 'https://systemforge.example.test/$' "$TEST_LOG" | cut -d: -f1)"

rm -f "$TEST_APP_DIR/.last-successful-sha" "$TEST_APP_DIR/.previous-successful-sha"
FAKE_EXTERNAL_SMOKE_URL=""
FAKE_EXTERNAL_FAILURE=true
export FAKE_EXTERNAL_SMOKE_URL FAKE_EXTERNAL_FAILURE
run_deploy
test "$(cat "$TEST_APP_DIR/.last-successful-sha")" = "$NEW_SHA"
test "$(grep -c '^curl ' "$TEST_LOG" || true)" -eq 0

rm -f "$TEST_APP_DIR/.last-successful-sha" "$TEST_APP_DIR/.previous-successful-sha"
FAKE_OFFSITE_FAILURE=true
FAKE_PREVIOUS_IMAGES=none
export FAKE_OFFSITE_FAILURE FAKE_PREVIOUS_IMAGES
set +e
run_deploy >/dev/null 2>&1
OFFSITE_FAILURE_STATUS=$?
set -e
test "$OFFSITE_FAILURE_STATUS" -ne 0
test ! -f "$TEST_APP_DIR/.last-successful-sha"
grep -q '^release backup$' "$TEST_LOG"
grep -q '^release offsite restore$' "$TEST_LOG"
grep -q ' stop systemforge-web systemforge-api systemforge-worker' "$TEST_LOG"
FAKE_OFFSITE_FAILURE=false
export FAKE_OFFSITE_FAILURE

rm -f "$TEST_APP_DIR/.last-successful-sha" "$TEST_APP_DIR/.previous-successful-sha"
FAKE_SKIP_BUILD=true
FAKE_PREVIOUS_IMAGES=all
FAKE_EXTERNAL_FAILURE=false
export FAKE_SKIP_BUILD FAKE_PREVIOUS_IMAGES FAKE_EXTERNAL_FAILURE
run_deploy
test "$(cat "$TEST_APP_DIR/.last-successful-sha")" = "$NEW_SHA"
test "$(grep -c ' docker .* build ' "$TEST_LOG" || true)" -eq 0
grep -q "docker image inspect systemforge-api:$NEW_SHA" "$TEST_LOG"
grep -q "docker image inspect systemforge-web:$NEW_SHA" "$TEST_LOG"
grep -q "docker image inspect systemforge-worker:$NEW_SHA" "$TEST_LOG"

rm -f "$TEST_APP_DIR/.last-successful-sha" "$TEST_APP_DIR/.previous-successful-sha"
FAKE_SKIP_BUILD=false
FAKE_PREVIOUS_IMAGES=none
FAKE_EXTERNAL_FAILURE=true
FAKE_EXTERNAL_SMOKE_URL=https://systemforge.example.test
export FAKE_SKIP_BUILD FAKE_PREVIOUS_IMAGES FAKE_EXTERNAL_FAILURE
set +e
run_deploy >/dev/null 2>&1
FIRST_FAILURE_STATUS=$?
set -e
test "$FIRST_FAILURE_STATUS" -ne 0
grep -q '^caddy open$' "$TEST_LOG"
grep -q '^caddy closed$' "$TEST_LOG"
grep -q ' stop systemforge-web systemforge-api systemforge-worker' "$TEST_LOG"

printf '%s\n' "$PREVIOUS_SHA" > "$TEST_APP_DIR/.last-successful-sha"
FAKE_PREVIOUS_IMAGES=all
export FAKE_PREVIOUS_IMAGES
set +e
run_deploy >/dev/null 2>&1
ROLLBACK_STATUS=$?
set -e
test "$ROLLBACK_STATUS" -ne 0
grep -q '^caddy open$' "$TEST_LOG"
test "$(grep -c '^caddy closed$' "$TEST_LOG" || true)" -eq 0
grep -q "tag=$PREVIOUS_SHA docker .* up .*systemforge-web systemforge-api systemforge-worker" "$TEST_LOG"

FAKE_PREVIOUS_IMAGES=api-only
export FAKE_PREVIOUS_IMAGES
set +e
run_deploy >/dev/null 2>&1
INCOMPLETE_ROLLBACK_STATUS=$?
set -e
test "$INCOMPLETE_ROLLBACK_STATUS" -ne 0
grep -q '^caddy closed$' "$TEST_LOG"
grep -q ' stop systemforge-web systemforge-api systemforge-worker' "$TEST_LOG"

rm -f "$TEST_APP_DIR/.last-successful-sha" "$TEST_APP_DIR/.previous-successful-sha"
FAKE_PREVIOUS_IMAGES=none
FAKE_EXTERNAL_FAILURE=false
FAKE_CADDY_FAILURE=true
export FAKE_PREVIOUS_IMAGES FAKE_EXTERNAL_FAILURE FAKE_CADDY_FAILURE
set +e
run_deploy >/dev/null 2>&1
CADDY_FAILURE_STATUS=$?
set -e
test "$CADDY_FAILURE_STATUS" -ne 0
test ! -f "$TEST_APP_DIR/.last-successful-sha"
grep -q '^caddy open$' "$TEST_LOG"
test "$(grep -c '^caddy closed$' "$TEST_LOG" || true)" -eq 0
grep -q ' stop systemforge-web systemforge-api systemforge-worker' "$TEST_LOG"

echo "Hetzner deployment rollback tests passed."
