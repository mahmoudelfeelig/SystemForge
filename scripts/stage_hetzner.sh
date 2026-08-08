#!/bin/sh
set -eu

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

case "${SYSTEMFORGE_PUBLIC_RELEASE_ENABLED:-false}" in
  true)
    echo "SystemForge release $DEPLOY_SHA is staged for the approved deployment phase."
    ;;
  false|"")
    sh "$APP_DIR/scripts/install_caddy_route.sh" closed
    SYSTEMFORGE_IMAGE_TAG="$DEPLOY_SHA" docker compose \
      --env-file "$ENV_FILE" \
      -f "$COMPOSE_FILE" \
      stop systemforge-web systemforge-api systemforge-worker systemforge-migrate
    echo "SystemForge release $DEPLOY_SHA is staged while the public release remains closed."
    ;;
  *)
    echo "SYSTEMFORGE_PUBLIC_RELEASE_ENABLED must be true or false." >&2
    exit 64
    ;;
esac
