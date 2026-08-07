#!/bin/sh
set -eu

APP_DIR=${SYSTEMFORGE_APP_DIR:-/opt/systemforge}
COMPOSE_FILE="$APP_DIR/deploy/docker-compose.prod.yml"
ENV_FILE="$APP_DIR/deploy/.env"
STATE_FILE="$APP_DIR/.last-successful-sha"
PREVIOUS_FILE="$APP_DIR/.previous-successful-sha"

cd "$APP_DIR"
test -f "$COMPOSE_FILE"
test -f "$ENV_FILE"
docker network inspect web >/dev/null 2>&1

DEPLOY_SHA=${1:-$(git rev-parse HEAD)}
test "$(git rev-parse HEAD)" = "$DEPLOY_SHA"
case "$DEPLOY_SHA" in
  *[!0-9a-f]*) echo "Deployment SHA is invalid." >&2; exit 1 ;;
esac

PREVIOUS_SHA=""
if test -f "$STATE_FILE"; then
  PREVIOUS_SHA=$(sed -n '1p' "$STATE_FILE")
fi

compose() {
  SYSTEMFORGE_IMAGE_TAG="$SYSTEMFORGE_IMAGE_TAG" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

rollback() {
  if test -n "$PREVIOUS_SHA" && docker image inspect "systemforge-api:$PREVIOUS_SHA" >/dev/null 2>&1; then
    echo "Deployment failed; restoring application images from $PREVIOUS_SHA." >&2
    SYSTEMFORGE_IMAGE_TAG="$PREVIOUS_SHA"
    export SYSTEMFORGE_IMAGE_TAG
    compose up -d --no-build --wait --wait-timeout 120 systemforge-web systemforge-api systemforge-worker
  fi
}

trap rollback HUP INT TERM EXIT
SYSTEMFORGE_IMAGE_TAG=$DEPLOY_SHA
export SYSTEMFORGE_IMAGE_TAG

compose build --pull systemforge-web systemforge-api systemforge-worker systemforge-migrate
compose up -d --wait --wait-timeout 180
compose exec -T \
  -e SMOKE_API_ORIGIN=http://127.0.0.1:8080 \
  -e SMOKE_WEB_ORIGIN=http://systemforge-web:8080 \
  systemforge-api node /app/scripts/production_smoke.mjs

if test -n "${SYSTEMFORGE_EXTERNAL_SMOKE_URL:-}"; then
  curl --fail --silent --show-error --max-time 15 "$SYSTEMFORGE_EXTERNAL_SMOKE_URL/api/health/ready" >/dev/null
fi

if test -n "$PREVIOUS_SHA" && test "$PREVIOUS_SHA" != "$DEPLOY_SHA"; then
  printf '%s\n' "$PREVIOUS_SHA" > "$PREVIOUS_FILE"
fi
printf '%s\n' "$DEPLOY_SHA" > "$STATE_FILE"
trap - HUP INT TERM EXIT
echo "SystemForge deployment $DEPLOY_SHA passed production smoke checks."
