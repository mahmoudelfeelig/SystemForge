#!/bin/sh
set -eu

APP_DIR=${SYSTEMFORGE_APP_DIR:-/opt/systemforge}
CADDY_DIR=${CADDY_DIR:-/opt/caddy}
CADDYFILE="$CADDY_DIR/Caddyfile"
RELEASE_MODE=${1:-closed}
case "$RELEASE_MODE" in
  closed)
    SOURCE="$APP_DIR/deploy/Caddyfile.systemforge"
    ;;
  open)
    if test "${SYSTEMFORGE_RELEASE_APPROVED:-}" != "I_AM_READY_FOR_PRODUCTION"; then
      echo "Release gate is closed. Explicit production approval is required." >&2
      exit 78
    fi
    SOURCE="$APP_DIR/deploy/Caddyfile.systemforge.open"
    ;;
  *)
    echo "Usage: $0 [closed|open]" >&2
    exit 64
    ;;
esac
BACKUP_DIR="$CADDY_DIR/.deploy-backups"
BEGIN_MARKER="# BEGIN SYSTEMFORGE MANAGED ROUTE"
END_MARKER="# END SYSTEMFORGE MANAGED ROUTE"

test -f "$CADDYFILE"
test -f "$SOURCE"
mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP=$(mktemp "$BACKUP_DIR/Caddyfile.$STAMP.XXXXXX")
cp "$CADDYFILE" "$BACKUP"
TEMP=$(mktemp "$CADDY_DIR/Caddyfile.systemforge.XXXXXX")
trap 'rm -f "$TEMP"' EXIT HUP INT TERM

awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" '
  $0 == begin { managed = 1; next }
  $0 == end { managed = 0; next }
  !managed { print }
' "$CADDYFILE" > "$TEMP"
printf '\n%s\n' "$BEGIN_MARKER" >> "$TEMP"
sed -n '1,$p' "$SOURCE" >> "$TEMP"
printf '%s\n' "$END_MARKER" >> "$TEMP"

if ! docker compose -f "$CADDY_DIR/docker-compose.yml" exec -T caddy \
  caddy validate --config /dev/stdin --adapter caddyfile < "$TEMP"; then
  echo "Caddy validation failed; the current configuration was not changed." >&2
  exit 1
fi

# The Caddyfile is bind-mounted as a single file. Replacing it with mv changes
# its inode and leaves a running container attached to stale content. Copy the
# candidate over the existing path, and pass the exact saved file to Caddy over
# stdin so validation and reload cannot observe different configurations.
cp "$TEMP" "$CADDYFILE"
if ! docker compose -f "$CADDY_DIR/docker-compose.yml" exec -T caddy \
  caddy reload --config /dev/stdin --adapter caddyfile < "$CADDYFILE"; then
  cp "$BACKUP" "$CADDYFILE"
  if ! docker compose -f "$CADDY_DIR/docker-compose.yml" exec -T caddy \
    caddy reload --config /dev/stdin --adapter caddyfile < "$CADDYFILE"; then
    echo "Caddy reload and rollback reload both failed; inspect the running proxy immediately." >&2
    exit 1
  fi
  echo "Caddy reload failed; the previous configuration was restored and reloaded." >&2
  exit 1
fi

rm -f "$TEMP"
trap - EXIT HUP INT TERM
echo "SystemForge Caddy route installed in $RELEASE_MODE mode. Backup: $BACKUP"
