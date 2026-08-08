#!/bin/sh
set -eu

TEST_ROOT=$(mktemp -d)
TEST_APP_DIR="$TEST_ROOT/app"
TEST_CADDY_DIR="$TEST_ROOT/caddy"
TEST_BIN_DIR="$TEST_ROOT/bin"
TEST_LOG="$TEST_ROOT/docker.log"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$TEST_APP_DIR/deploy" "$TEST_CADDY_DIR" "$TEST_BIN_DIR"
printf '%s\n' 'existing.example {' '  respond 204' '}' > "$TEST_CADDY_DIR/Caddyfile"
: > "$TEST_CADDY_DIR/docker-compose.yml"
printf '%s\n' \
  'systemforge.elfeel.me {' \
  '  respond 404' \
  '}' > "$TEST_APP_DIR/deploy/Caddyfile.systemforge"
printf '%s\n' \
  'systemforge.elfeel.me {' \
  '  reverse_proxy systemforge-web:8080' \
  '}' > "$TEST_APP_DIR/deploy/Caddyfile.systemforge.open"

cat > "$TEST_BIN_DIR/docker" <<'EOF'
#!/bin/sh
set -eu

printf '%s\n' "$*" >> "$FAKE_LOG"
case " $* " in
  *" caddy validate --config /dev/stdin --adapter caddyfile "*)
    INPUT=$(mktemp)
    cat > "$INPUT"
    grep -q 'existing.example' "$INPUT"
    grep -q 'systemforge.elfeel.me' "$INPUT"
    rm -f "$INPUT"
    ;;
  *" caddy reload --config /dev/stdin --adapter caddyfile "*)
    INPUT=$(mktemp)
    cat > "$INPUT"
    grep -q 'existing.example' "$INPUT"
    if test "${FAKE_RELOAD_FAIL_ONCE:-false}" = "true" && test ! -f "$FAKE_RELOAD_MARKER"; then
      : > "$FAKE_RELOAD_MARKER"
      rm -f "$INPUT"
      exit 1
    fi
    if test -n "${FAKE_EXPECT_CONTENT:-}"; then
      grep -q "$FAKE_EXPECT_CONTENT" "$INPUT"
    fi
    rm -f "$INPUT"
    ;;
  *)
    echo "Unexpected docker command: $*" >&2
    exit 2
    ;;
esac
EOF
chmod 700 "$TEST_BIN_DIR/docker"

run_installer() {
  PATH="$TEST_BIN_DIR:$PATH" \
    FAKE_LOG="$TEST_LOG" \
    FAKE_RELOAD_FAIL_ONCE="${FAKE_RELOAD_FAIL_ONCE:-false}" \
    FAKE_RELOAD_MARKER="$TEST_ROOT/reload-failed" \
    FAKE_EXPECT_CONTENT="${FAKE_EXPECT_CONTENT:-}" \
    SYSTEMFORGE_APP_DIR="$TEST_APP_DIR" \
    CADDY_DIR="$TEST_CADDY_DIR" \
    SYSTEMFORGE_RELEASE_APPROVED="${SYSTEMFORGE_RELEASE_APPROVED:-}" \
    sh scripts/install_caddy_route.sh "$@"
}

FAKE_EXPECT_CONTENT='respond 404'
export FAKE_EXPECT_CONTENT
run_installer closed
grep -q 'respond 404' "$TEST_CADDY_DIR/Caddyfile"
test "$(grep -c 'caddy validate --config /dev/stdin --adapter caddyfile' "$TEST_LOG")" -eq 1
test "$(grep -c 'caddy reload --config /dev/stdin --adapter caddyfile' "$TEST_LOG")" -eq 1
test "$(find "$TEST_CADDY_DIR/.deploy-backups" -maxdepth 1 -type f | wc -l)" -eq 1

SYSTEMFORGE_RELEASE_APPROVED=I_AM_READY_FOR_PRODUCTION
FAKE_EXPECT_CONTENT='reverse_proxy systemforge-web:8080'
export SYSTEMFORGE_RELEASE_APPROVED FAKE_EXPECT_CONTENT
run_installer open
grep -q 'reverse_proxy systemforge-web:8080' "$TEST_CADDY_DIR/Caddyfile"
test "$(find "$TEST_CADDY_DIR/.deploy-backups" -maxdepth 1 -type f | wc -l)" -eq 2

printf '%s\n' 'existing.example {' '  respond 204' '}' > "$TEST_CADDY_DIR/Caddyfile"
rm -f "$TEST_ROOT/reload-failed"
FAKE_RELOAD_FAIL_ONCE=true
FAKE_EXPECT_CONTENT='respond 204'
export FAKE_RELOAD_FAIL_ONCE FAKE_EXPECT_CONTENT
set +e
run_installer closed >/dev/null 2>&1
STATUS=$?
set -e
test "$STATUS" -ne 0
grep -q 'respond 204' "$TEST_CADDY_DIR/Caddyfile"
test "$(grep -c 'caddy reload --config /dev/stdin --adapter caddyfile' "$TEST_LOG")" -eq 4

echo "Caddy route installer tests passed."
