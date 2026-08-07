#!/bin/sh
set -eu

APP_DIR=${SYSTEMFORGE_APP_DIR:-/opt/systemforge}
BACKUP_DIR=${SYSTEMFORGE_BACKUP_DIR:-/opt/systemforge-backups}
COMPOSE_FILE="$APP_DIR/deploy/docker-compose.prod.yml"
ENV_FILE="$APP_DIR/deploy/.env"
RETENTION_DAYS=${SYSTEMFORGE_BACKUP_RETENTION_DAYS:-14}
LOCK_FILE="$BACKUP_DIR/.backup.lock"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TEMP="$BACKUP_DIR/systemforge.$STAMP.dump.partial"
FINAL="$BACKUP_DIR/systemforge.$STAMP.dump"
trap 'rm -f "$TEMP"' EXIT HUP INT TERM

SYSTEMFORGE_IMAGE_TAG=$(sed -n 's/^SYSTEMFORGE_IMAGE_TAG=//p' "$ENV_FILE" | tail -1)
SYSTEMFORGE_IMAGE_TAG=${SYSTEMFORGE_IMAGE_TAG:-local}
export SYSTEMFORGE_IMAGE_TAG
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T systemforge-db \
  pg_dump --format=custom --no-owner --no-acl --username=systemforge systemforge > "$TEMP"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T systemforge-db \
  pg_restore --list < "$TEMP" >/dev/null
chmod 600 "$TEMP"
mv "$TEMP" "$FINAL"
trap - EXIT HUP INT TERM
find "$BACKUP_DIR" -type f -name 'systemforge.*.dump' -mtime "+$RETENTION_DAYS" -delete
echo "Verified PostgreSQL backup: $FINAL"
