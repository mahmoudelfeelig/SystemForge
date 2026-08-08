#!/bin/sh
set -eu

APP_DIR=${SYSTEMFORGE_APP_DIR:-/opt/systemforge}
BACKUP_DIR=${SYSTEMFORGE_BACKUP_DIR:-/opt/systemforge-backups}
COMPOSE_FILE="$APP_DIR/deploy/docker-compose.prod.yml"
ENV_FILE=${SYSTEMFORGE_ENV_FILE:-"$APP_DIR/deploy/.env"}
BACKUP_FILE=${1:-}

if test -z "$BACKUP_FILE"; then
  BACKUP_FILE=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'systemforge.*.dump' -print | sort | tail -1)
fi
test -n "$BACKUP_FILE"
test -f "$BACKUP_FILE"
test -f "$COMPOSE_FILE"
test -f "$ENV_FILE"

if test -z "${SYSTEMFORGE_IMAGE_TAG:-}"; then
  SYSTEMFORGE_IMAGE_TAG=$(sed -n 's/^SYSTEMFORGE_IMAGE_TAG=//p' "$ENV_FILE" | tail -1)
fi
SYSTEMFORGE_IMAGE_TAG=${SYSTEMFORGE_IMAGE_TAG:-local}
export SYSTEMFORGE_IMAGE_TAG

DRILL_DB="systemforge_restore_$(date -u +%Y%m%d%H%M%S)_$$"
compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}
cleanup() {
  compose exec -T systemforge-db dropdb --if-exists --force --username=systemforge "$DRILL_DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

compose exec -T systemforge-db createdb --template=template0 --username=systemforge "$DRILL_DB"
compose exec -T systemforge-db pg_restore \
  --exit-on-error \
  --no-owner \
  --no-acl \
  --username=systemforge \
  --dbname="$DRILL_DB" < "$BACKUP_FILE"

MIGRATIONS=$(compose exec -T systemforge-db psql \
  --no-psqlrc \
  --tuples-only \
  --no-align \
  --username=systemforge \
  --dbname="$DRILL_DB" \
  --command="SELECT count(*) FROM schema_migrations")
TABLES=$(compose exec -T systemforge-db psql \
  --no-psqlrc \
  --tuples-only \
  --no-align \
  --username=systemforge \
  --dbname="$DRILL_DB" \
  --command="SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename IN ('shared_scenarios', 'simulation_runs', 'worker_heartbeats')")
test "$MIGRATIONS" -ge 5
test "$TABLES" -eq 3

cleanup
trap - EXIT HUP INT TERM
echo "Verified PostgreSQL restore drill from: $BACKUP_FILE"
