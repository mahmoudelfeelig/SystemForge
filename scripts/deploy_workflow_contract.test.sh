#!/bin/sh
set -eu

WORKFLOW=.github/workflows/deploy-hetzner.yml
CI_WORKFLOW=.github/workflows/ci.yml
TEST_ROOT=$(mktemp -d)
STAGE_BLOCK="$TEST_ROOT/stage"
DEPLOY_BLOCK="$TEST_ROOT/deploy"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

awk '
  /^  stage:/ { selected = 1 }
  /^  deploy:/ { selected = 0 }
  selected { print }
' "$WORKFLOW" > "$STAGE_BLOCK"
awk '
  /^  deploy:/ { selected = 1 }
  selected { print }
' "$WORKFLOW" > "$DEPLOY_BLOCK"

# Every trusted green main CI run stages the immutable image bundle on Hetzner.
# Public deployment remains a separate job guarded by both approval variables.
grep -Fq 'github.event.workflow_run.conclusion == '\''success'\''' "$STAGE_BLOCK"
grep -Fq 'github.event.workflow_run.event == '\''push'\''' "$STAGE_BLOCK"
grep -Fq 'github.event.workflow_run.head_branch == '\''main'\''' "$STAGE_BLOCK"
grep -Fq 'github.event.workflow_run.head_repository.full_name == github.repository' "$STAGE_BLOCK"
grep -Fq 'SYSTEMFORGE_PUBLIC_RELEASE_ENABLED=$PUBLIC_RELEASE_ENABLED' "$STAGE_BLOCK"
grep -Fq 'sh scripts/stage_hetzner.sh \"$DEPLOY_SHA\"' "$STAGE_BLOCK"
grep -Fq 'test -z \"\$(git status --porcelain)\"' "$STAGE_BLOCK"
grep -Fq 'staged: ${{ steps.stage.outputs.staged }}' "$STAGE_BLOCK"
grep -Fq 'public_release_enabled: ${{ steps.stage.outputs.public_release_enabled }}' "$STAGE_BLOCK"
grep -Fq 'id: stage' "$STAGE_BLOCK"
grep -Fq 'exit 75' "$STAGE_BLOCK"
grep -Fq 'echo "staged=false" >> "$GITHUB_OUTPUT"' "$STAGE_BLOCK"
grep -Fq 'echo "public_release_enabled=$PUBLIC_RELEASE_ENABLED" >> "$GITHUB_OUTPUT"' "$STAGE_BLOCK"
if grep -Fq "vars.HETZNER_DEPLOY_ENABLED == 'true'" "$STAGE_BLOCK"; then
  echo "Hetzner staging must not be disabled by the public deployment gate." >&2
  exit 1
fi

grep -Fq 'needs: stage' "$DEPLOY_BLOCK"
grep -Fq "needs.stage.outputs.staged == 'true'" "$DEPLOY_BLOCK"
grep -Fq "needs.stage.outputs.public_release_enabled == 'true'" "$DEPLOY_BLOCK"
if grep -Eq 'vars\.(HETZNER_DEPLOY_ENABLED|SYSTEMFORGE_RELEASE_APPROVED)' "$DEPLOY_BLOCK"; then
  echo "The deploy job gate must use the stage output because environment variables are unavailable before job start." >&2
  exit 1
fi
grep -Fq "github.event.workflow_run.conclusion == 'success'" "$DEPLOY_BLOCK"
grep -Fq "github.event.workflow_run.event == 'push'" "$DEPLOY_BLOCK"
grep -Fq "github.event.workflow_run.head_branch == 'main'" "$DEPLOY_BLOCK"
grep -Fq "github.event.workflow_run.head_repository.full_name == github.repository" "$DEPLOY_BLOCK"
grep -Fq 'DEPLOY_SHA: ${{ github.event.workflow_run.head_sha }}' "$WORKFLOW"

# The release script opens the approved route only after in-network smoke and
# backup/restore gates. The external origin remains an explicit protected value
# rather than a hard-coded alternate destination.
grep -Fq 'EXTERNAL_SMOKE_URL: ${{ vars.SYSTEMFORGE_EXTERNAL_SMOKE_URL }}' "$WORKFLOW"
grep -Fq 'SYSTEMFORGE_EXTERNAL_SMOKE_URL=$EXTERNAL_SMOKE_URL' "$WORKFLOW"
if grep -Fq 'SYSTEMFORGE_EXTERNAL_SMOKE_URL=https://' "$WORKFLOW"; then
  echo "The deployment workflow hard-codes a public smoke before bootstrap." >&2
  exit 1
fi

grep -Fq \
  "vars.SYSTEMFORGE_EXTERNAL_SMOKE_URL == 'https://systemforge.elfeel.me'" \
  .github/workflows/production-monitor.yml

# CI must hand the exact scanned and integrated release images to the deployment
# workflow instead of asking the server to rebuild mutable base-image tags.
grep -Fq 'SYSTEMFORGE_IMAGE_TAG: ${{ github.sha }}' "$CI_WORKFLOW"
grep -Fq 'VITE_CANONICAL_RELEASE_ENABLED: "true"' "$CI_WORKFLOW"
grep -Fq 'image: systemforge-api:${{ github.sha }}' "$CI_WORKFLOW"
grep -Fq 'image: systemforge-web:${{ github.sha }}' "$CI_WORKFLOW"
grep -Fq 'image: systemforge-worker:${{ github.sha }}' "$CI_WORKFLOW"
grep -Fq 'docker save --output "$RUNNER_TEMP/systemforge-release/systemforge-images.tar"' "$CI_WORKFLOW"
grep -Fq 'uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7' "$CI_WORKFLOW"
grep -Fq 'uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8' "$CI_WORKFLOW"
grep -Fq 'docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml up -d --no-build' "$CI_WORKFLOW"
grep -Fq 'node scripts/overload_smoke_contract.test.mjs' "$CI_WORKFLOW"
grep -Fq 'sh scripts/stage_hetzner.test.sh' "$CI_WORKFLOW"
grep -Fq 'systemforge-api node /app/apps/api/overload_smoke.mjs' "$CI_WORKFLOW"
grep -Fq 'systemforge-api node /app/apps/api/overload_smoke.mjs' scripts/deploy_hetzner.sh
grep -Fq 'sh "$APP_DIR/scripts/verify_release_backups.sh"' scripts/deploy_hetzner.sh
grep -Fq 'sh "$APP_DIR/scripts/install_caddy_route.sh" open' scripts/deploy_hetzner.sh
grep -Fq 'sh "$APP_DIR/scripts/install_caddy_route.sh" closed' scripts/deploy_hetzner.sh
grep -Fq 'uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8' "$WORKFLOW"
grep -Fq 'actions: read' "$WORKFLOW"
grep -Fq 'run-id: ${{ github.event.workflow_run.id }}' "$WORKFLOW"
grep -Fq 'docker load --input /tmp/systemforge-images-$DEPLOY_SHA.tar.gz' "$WORKFLOW"
FETCH_LINE=$(grep -nF 'git fetch origin main' "$STAGE_BLOCK" | head -1 | cut -d: -f1)
LOAD_LINE=$(grep -nF 'docker load --input /tmp/systemforge-images-$DEPLOY_SHA.tar.gz' "$STAGE_BLOCK" | cut -d: -f1)
test "$FETCH_LINE" -lt "$LOAD_LINE"
grep -Fq 'SYSTEMFORGE_SKIP_BUILD=true' "$WORKFLOW"
grep -Fq 'ACTIONLINT_VERSION: 1.7.12' "$CI_WORKFLOW"
grep -Fq 'ACTIONLINT_SHA256: 8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8' "$CI_WORKFLOW"
grep -Fq '"$RUNNER_TEMP/actionlint/actionlint" .github/workflows/*.yml' "$CI_WORKFLOW"

if grep -E '^[[:space:]]*- uses: [^#]+@v[0-9]' .github/workflows/*.yml; then
  echo "GitHub Actions must be pinned to immutable commit SHAs." >&2
  exit 1
fi

echo "Hetzner deployment workflow contract passed."
