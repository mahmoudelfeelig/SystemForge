#!/bin/sh
set -eu

WORKFLOW=.github/workflows/deploy-hetzner.yml
CI_WORKFLOW=.github/workflows/ci.yml

grep -Fq "vars.HETZNER_DEPLOY_ENABLED == 'true'" "$WORKFLOW"
grep -Fq "vars.SYSTEMFORGE_RELEASE_APPROVED == 'I_AM_READY_FOR_PRODUCTION'" "$WORKFLOW"
grep -Fq "github.event.workflow_run.conclusion == 'success'" "$WORKFLOW"
grep -Fq "github.event.workflow_run.event == 'push'" "$WORKFLOW"
grep -Fq "github.event.workflow_run.head_branch == 'main'" "$WORKFLOW"
grep -Fq "github.event.workflow_run.head_repository.full_name == github.repository" "$WORKFLOW"
grep -Fq 'DEPLOY_SHA: ${{ github.event.workflow_run.head_sha }}' "$WORKFLOW"

# A first approved bootstrap has no public route to smoke yet. The public URL
# must therefore be opt-in instead of hard-coded into every deployment.
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
grep -Fq 'systemforge-api node /app/apps/api/overload_smoke.mjs' "$CI_WORKFLOW"
grep -Fq 'systemforge-api node /app/apps/api/overload_smoke.mjs' scripts/deploy_hetzner.sh
grep -Fq 'uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8' "$WORKFLOW"
grep -Fq 'actions: read' "$WORKFLOW"
grep -Fq 'run-id: ${{ github.event.workflow_run.id }}' "$WORKFLOW"
grep -Fq 'docker load --input /tmp/systemforge-images-$DEPLOY_SHA.tar.gz' "$WORKFLOW"
grep -Fq 'SYSTEMFORGE_SKIP_BUILD=true' "$WORKFLOW"
grep -Fq 'ACTIONLINT_VERSION: 1.7.12' "$CI_WORKFLOW"
grep -Fq 'ACTIONLINT_SHA256: 8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8' "$CI_WORKFLOW"
grep -Fq '"$RUNNER_TEMP/actionlint/actionlint" .github/workflows/*.yml' "$CI_WORKFLOW"

if grep -E '^[[:space:]]*- uses: [^#]+@v[0-9]' .github/workflows/*.yml; then
  echo "GitHub Actions must be pinned to immutable commit SHAs." >&2
  exit 1
fi

echo "Hetzner deployment workflow contract passed."
