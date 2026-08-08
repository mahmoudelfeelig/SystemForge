#!/bin/sh
set -eu

if test "${SYSTEMFORGE_RELEASE_APPROVED:-}" != "I_AM_READY_FOR_PRODUCTION"; then
  echo "Release gate is closed. Explicit production approval is required." >&2
  exit 78
fi
VITE_CANONICAL_RELEASE_ENABLED=true
export VITE_CANONICAL_RELEASE_ENABLED

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
test "${#DEPLOY_SHA}" -eq 40
case "$DEPLOY_SHA" in
  *[!0-9a-f]*) echo "Deployment SHA is invalid." >&2; exit 1 ;;
esac

PREVIOUS_SHA=""
PUBLIC_ROUTE_INSTALLED=false
if test -f "$STATE_FILE"; then
  PREVIOUS_SHA=$(sed -n '1p' "$STATE_FILE")
fi
if test -n "$PREVIOUS_SHA"; then
  case "$PREVIOUS_SHA" in
    *[!0-9a-f]*) PREVIOUS_SHA="" ;;
  esac
  if test "${#PREVIOUS_SHA}" -ne 40; then
    PREVIOUS_SHA=""
  fi
fi

compose() {
  SYSTEMFORGE_IMAGE_TAG="$SYSTEMFORGE_IMAGE_TAG" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

complete_previous_release_exists() {
  test -n "$PREVIOUS_SHA" \
    && docker image inspect "systemforge-api:$PREVIOUS_SHA" >/dev/null 2>&1 \
    && docker image inspect "systemforge-web:$PREVIOUS_SHA" >/dev/null 2>&1 \
    && docker image inspect "systemforge-worker:$PREVIOUS_SHA" >/dev/null 2>&1
}

stop_application_fail_closed() {
  echo "No complete previous release is available; stopping application services." >&2
  compose stop systemforge-web systemforge-api systemforge-worker >/dev/null 2>&1 || true
}

rollback() {
  DEPLOYMENT_STATUS=$?
  trap - EXIT HUP INT TERM
  if test "$DEPLOYMENT_STATUS" -eq 0; then
    exit 0
  fi
  if complete_previous_release_exists; then
    echo "Deployment failed; restoring application images from $PREVIOUS_SHA." >&2
    SYSTEMFORGE_IMAGE_TAG="$PREVIOUS_SHA"
    export SYSTEMFORGE_IMAGE_TAG
    if ! compose up -d --no-build --wait --wait-timeout 120 systemforge-web systemforge-api systemforge-worker; then
      echo "Previous release restoration failed." >&2
      stop_application_fail_closed
    fi
  else
    if test "$PUBLIC_ROUTE_INSTALLED" = true; then
      if ! sh "$APP_DIR/scripts/install_caddy_route.sh" closed; then
        echo "Failed to restore the closed Caddy route after a first-release failure." >&2
      fi
    fi
    stop_application_fail_closed
  fi
  exit "$DEPLOYMENT_STATUS"
}

trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
SYSTEMFORGE_IMAGE_TAG=$DEPLOY_SHA
export SYSTEMFORGE_IMAGE_TAG

case "${SYSTEMFORGE_SKIP_BUILD:-false}" in
  true)
    docker image inspect "systemforge-api:$DEPLOY_SHA" >/dev/null
    docker image inspect "systemforge-web:$DEPLOY_SHA" >/dev/null
    docker image inspect "systemforge-worker:$DEPLOY_SHA" >/dev/null
    ;;
  false|"")
    compose build --pull systemforge-web systemforge-api systemforge-worker systemforge-migrate
    ;;
  *)
    echo "SYSTEMFORGE_SKIP_BUILD must be true or false." >&2
    exit 64
    ;;
esac
compose up -d --wait --wait-timeout 180
compose exec -T \
  -e SMOKE_API_ORIGIN=http://127.0.0.1:8080 \
  -e SMOKE_WEB_ORIGIN=http://systemforge-web:8080 \
  systemforge-api node /app/apps/api/production_smoke.mjs
compose exec -T \
  -e OVERLOAD_API_ORIGIN=http://127.0.0.1:8080 \
  -e OVERLOAD_WEB_ORIGIN=http://systemforge-web:8080 \
  systemforge-api node /app/apps/api/overload_smoke.mjs
sh "$APP_DIR/scripts/verify_release_backups.sh"
sh "$APP_DIR/scripts/install_caddy_route.sh" open
PUBLIC_ROUTE_INSTALLED=true

if test -n "${SYSTEMFORGE_EXTERNAL_SMOKE_URL:-}"; then
  EXTERNAL_ORIGIN=${SYSTEMFORGE_EXTERNAL_SMOKE_URL%/}
  curl --fail --silent --show-error --retry 2 --retry-all-errors --max-time 15 "$EXTERNAL_ORIGIN/" | grep -q SystemForge
  curl --fail --silent --show-error --retry 2 --retry-all-errors --max-time 15 "$EXTERNAL_ORIGIN/api/health/ready" | grep -q '"status":"ready"'
fi

if test -n "$PREVIOUS_SHA" && test "$PREVIOUS_SHA" != "$DEPLOY_SHA"; then
  printf '%s\n' "$PREVIOUS_SHA" > "$PREVIOUS_FILE"
fi
printf '%s\n' "$DEPLOY_SHA" > "$STATE_FILE"
trap - HUP INT TERM EXIT
echo "SystemForge deployment $DEPLOY_SHA passed production smoke checks."
