#!/bin/sh
set -eu

if test "${SYSTEMFORGE_RELEASE_CONFIRMATION:-}" != "AUTHORIZE_SYSTEMFORGE_PRODUCTION_RELEASE"; then
  echo "Release gate is closed. Exact production confirmation is required." >&2
  exit 78
fi

APP_DIR=${SYSTEMFORGE_APP_DIR:-/opt/systemforge}
COMPOSE_FILE="$APP_DIR/deploy/docker-compose.prod.yml"
ENV_FILE="$APP_DIR/deploy/.env"
DEPLOY_SHA=${1:-}

test -n "$DEPLOY_SHA"
test "${#DEPLOY_SHA}" -eq 40
case "$DEPLOY_SHA" in
  *[!0-9a-f]*) echo "Staged SHA is invalid." >&2; exit 64 ;;
esac

cd "$APP_DIR"
test -f "$COMPOSE_FILE"
test -f "$ENV_FILE"
test "$(git rev-parse HEAD)" = "$DEPLOY_SHA"
docker image inspect "systemforge-api:$DEPLOY_SHA" >/dev/null
docker image inspect "systemforge-web:$DEPLOY_SHA" >/dev/null
docker image inspect "systemforge-worker:$DEPLOY_SHA" >/dev/null
sh "$APP_DIR/scripts/install_backup_cron.sh"

echo "SystemForge release $DEPLOY_SHA is staged for the explicitly authorized deployment."
