#!/bin/sh
set -eu

APP_DIR=${SYSTEMFORGE_APP_DIR:-/opt/systemforge}
CADDY_DIR=${CADDY_DIR:-/opt/caddy}
CADDYFILE="$CADDY_DIR/Caddyfile"
SOURCE="$APP_DIR/deploy/Caddyfile.systemforge"
BACKUP_DIR="$CADDY_DIR/.deploy-backups"
BEGIN_MARKER="# BEGIN SYSTEMFORGE MANAGED ROUTE"
END_MARKER="# END SYSTEMFORGE MANAGED ROUTE"

test -f "$CADDYFILE"
test -f "$SOURCE"
mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="$BACKUP_DIR/Caddyfile.$STAMP"
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
mv "$TEMP" "$CADDYFILE"
trap - EXIT HUP INT TERM

if ! docker compose -f "$CADDY_DIR/docker-compose.yml" exec -T caddy caddy validate --config /etc/caddy/Caddyfile; then
  cp "$BACKUP" "$CADDYFILE"
  echo "Caddy validation failed; the previous configuration was restored." >&2
  exit 1
fi
docker compose -f "$CADDY_DIR/docker-compose.yml" exec -T caddy caddy reload --config /etc/caddy/Caddyfile
echo "SystemForge Caddy route installed. Backup: $BACKUP"
