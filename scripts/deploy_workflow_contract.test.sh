#!/bin/sh
set -eu

WORKFLOW=.github/workflows/deploy-hetzner.yml
CI_WORKFLOW=.github/workflows/ci.yml
TEST_ROOT=$(mktemp -d)
VALIDATE_BLOCK="$TEST_ROOT/validate"
STAGE_BLOCK="$TEST_ROOT/stage"
DEPLOY_BLOCK="$TEST_ROOT/deploy"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

awk '
  /^  validate:/ { selected = 1 }
  /^  stage:/ { selected = 0 }
  selected { print }
' "$WORKFLOW" > "$VALIDATE_BLOCK"
awk '
  /^  stage:/ { selected = 1 }
  /^  deploy:/ { selected = 0 }
  selected { print }
' "$WORKFLOW" > "$STAGE_BLOCK"
awk '
  /^  deploy:/ { selected = 1 }
  selected { print }
' "$WORKFLOW" > "$DEPLOY_BLOCK"

# Production mutation is possible only through an explicit dispatch whose
# requested SHA and run ID are independently validated against trusted main CI.
grep -Fq 'workflow_dispatch:' "$WORKFLOW"
grep -Fq 'release_sha:' "$WORKFLOW"
grep -Fq 'ci_run_id:' "$WORKFLOW"
grep -Fq 'confirmation:' "$WORKFLOW"
grep -Fq 'Type AUTHORIZE_SYSTEMFORGE_PRODUCTION_RELEASE exactly' "$WORKFLOW"
if grep -Fq 'workflow_run:' "$WORKFLOW"; then
  echo "Production deployment must not trigger automatically after CI." >&2
  exit 1
fi

grep -Fq 'CI_RUN_ID: ${{ inputs.ci_run_id }}' "$VALIDATE_BLOCK"
grep -Fq 'DISPATCH_REF: ${{ github.ref }}' "$VALIDATE_BLOCK"
grep -Fq 'DISPATCH_SHA: ${{ github.sha }}' "$VALIDATE_BLOCK"
grep -Fq 'RELEASE_CONFIRMATION: ${{ inputs.confirmation }}' "$VALIDATE_BLOCK"
grep -Fq 'RELEASE_SHA: ${{ inputs.release_sha }}' "$VALIDATE_BLOCK"
grep -Fq 'test "$RELEASE_CONFIRMATION" != AUTHORIZE_SYSTEMFORGE_PRODUCTION_RELEASE' "$VALIDATE_BLOCK"
grep -Fq 'test "${#RELEASE_SHA}" -ne 40' "$VALIDATE_BLOCK"
grep -Fq '*[!0-9a-f]*)' "$VALIDATE_BLOCK"
grep -Fq '""|*[!0-9]*)' "$VALIDATE_BLOCK"
grep -Fq 'test "$DISPATCH_REF" != refs/heads/main' "$VALIDATE_BLOCK"
grep -Fq 'test "$DISPATCH_SHA" != "$RELEASE_SHA"' "$VALIDATE_BLOCK"
grep -Fq '"$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/actions/runs/$CI_RUN_ID"' "$VALIDATE_BLOCK"
grep -Fq '(.id | tostring) == $run_id' "$VALIDATE_BLOCK"
grep -Fq '.status == "completed"' "$VALIDATE_BLOCK"
grep -Fq '.conclusion == "success"' "$VALIDATE_BLOCK"
grep -Fq '.event == "push"' "$VALIDATE_BLOCK"
grep -Fq '.head_branch == "main"' "$VALIDATE_BLOCK"
grep -Fq '.head_sha == $sha' "$VALIDATE_BLOCK"
grep -Fq '.repository.full_name == $repo' "$VALIDATE_BLOCK"
grep -Fq '.head_repository.full_name == $repo' "$VALIDATE_BLOCK"
grep -Fq '.name == "SystemForge CI"' "$VALIDATE_BLOCK"
grep -Fq '.path == ".github/workflows/ci.yml"' "$VALIDATE_BLOCK"
grep -Fq '"$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/git/ref/heads/main"' "$VALIDATE_BLOCK"
grep -Fq 'exit 75' "$VALIDATE_BLOCK"

grep -Fq 'needs: validate' "$STAGE_BLOCK"
grep -Fq 'environment: production' "$STAGE_BLOCK"
grep -Fq 'name: systemforge-images-${{ needs.validate.outputs.release_sha }}' "$STAGE_BLOCK"
grep -Fq 'run-id: ${{ needs.validate.outputs.ci_run_id }}' "$STAGE_BLOCK"
grep -Fq 'DEPLOY_SHA: ${{ needs.validate.outputs.release_sha }}' "$STAGE_BLOCK"
grep -Fq 'RELEASE_CONFIRMATION: ${{ inputs.confirmation }}' "$STAGE_BLOCK"
grep -Fq 'SYSTEMFORGE_RELEASE_CONFIRMATION=$RELEASE_CONFIRMATION' "$STAGE_BLOCK"
grep -Fq 'sh scripts/stage_hetzner.sh \"$DEPLOY_SHA\"' "$STAGE_BLOCK"
grep -Fq 'test -z \"\$(git status --porcelain)\"' "$STAGE_BLOCK"
grep -Fq 'exit 75' "$STAGE_BLOCK"

grep -Fq 'needs: [validate, stage]' "$DEPLOY_BLOCK"
grep -Fq 'environment: production' "$DEPLOY_BLOCK"
grep -Fq 'DEPLOY_SHA: ${{ needs.validate.outputs.release_sha }}' "$DEPLOY_BLOCK"
grep -Fq 'Revalidate the release before production mutation' "$DEPLOY_BLOCK"
grep -Fq 'systemforge-main-ref-before-deploy.json' "$DEPLOY_BLOCK"
grep -Fq 'superseded before production mutation' "$DEPLOY_BLOCK"
grep -Fq 'exit 75' "$DEPLOY_BLOCK"
if grep -Eq 'vars\.(HETZNER_DEPLOY_ENABLED|SYSTEMFORGE_RELEASE_APPROVED)' "$WORKFLOW"; then
  echo "Production approval must come from the one-time dispatch, not persistent variables." >&2
  exit 1
fi
if grep -Eq 'github\.event\.workflow_run|SYSTEMFORGE_PUBLIC_RELEASE_ENABLED|staged=false|0\|75' "$WORKFLOW"; then
  echo "Superseded or unapproved releases must fail instead of being treated as successful no-ops." >&2
  exit 1
fi

VALIDATION_LINE=$(grep -nF 'jq --exit-status' "$WORKFLOW" | head -1 | cut -d: -f1)
DISPATCH_GATE_LINE=$(grep -nF 'test "$DISPATCH_REF" != refs/heads/main' "$WORKFLOW" | cut -d: -f1)
RUN_API_LINE=$(grep -nF 'actions/runs/$CI_RUN_ID' "$WORKFLOW" | cut -d: -f1)
ARTIFACT_LINE=$(grep -nF 'uses: actions/download-artifact@' "$WORKFLOW" | head -1 | cut -d: -f1)
SECRET_LINE=$(grep -nF 'secrets.HETZNER_SSH_PRIVATE_KEY' "$WORKFLOW" | head -1 | cut -d: -f1)
test "$DISPATCH_GATE_LINE" -lt "$RUN_API_LINE"
test "$DISPATCH_GATE_LINE" -lt "$ARTIFACT_LINE"
test "$DISPATCH_GATE_LINE" -lt "$SECRET_LINE"
test "$VALIDATION_LINE" -lt "$ARTIFACT_LINE"
test "$VALIDATION_LINE" -lt "$SECRET_LINE"

GATE_LINE=$(grep -nF 'SYSTEMFORGE_RELEASE_CONFIRMATION:-' scripts/stage_hetzner.sh | cut -d: -f1)
MUTATION_LINE=$(grep -nF 'install_backup_cron.sh' scripts/stage_hetzner.sh | cut -d: -f1)
test "$GATE_LINE" -lt "$MUTATION_LINE"
grep -Fq 'exit 78' scripts/stage_hetzner.sh
if grep -Eq 'install_caddy_route\.sh|docker compose|SYSTEMFORGE_PUBLIC_RELEASE_ENABLED' scripts/stage_hetzner.sh; then
  echo "Staging must not close routes or stop live services." >&2
  exit 1
fi

grep -Fq 'R2_ACCESS_KEY_ID: ${{ secrets.SYSTEMFORGE_R2_ACCESS_KEY_ID }}' "$DEPLOY_BLOCK"
grep -Fq 'R2_ACCOUNT_ID: ${{ vars.SYSTEMFORGE_R2_ACCOUNT_ID }}' "$DEPLOY_BLOCK"
grep -Fq 'R2_BUCKET: ${{ vars.SYSTEMFORGE_R2_BUCKET }}' "$DEPLOY_BLOCK"
grep -Fq 'R2_SECRET_ACCESS_KEY: ${{ secrets.SYSTEMFORGE_R2_SECRET_ACCESS_KEY }}' "$DEPLOY_BLOCK"
grep -Fq 'RESTIC_PASSWORD: ${{ secrets.SYSTEMFORGE_RESTIC_PASSWORD }}' "$DEPLOY_BLOCK"
grep -Fq 'RESTIC_RELEASE_VERSION: 0.19.1' "$DEPLOY_BLOCK"
grep -Fq 'RESTIC_RELEASE_SHA256: f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c' "$DEPLOY_BLOCK"
grep -Fq 'RESTIC_BINARY_SHA256: 20d4142678d0d95ec11a4759def1b73fd9190abc9ca19e4b62d067c0b387e639' "$DEPLOY_BLOCK"
grep -Fq 'RESTIC_PASSWORD_FILE=/opt/systemforge-backups/.offsite/restic-password' "$DEPLOY_BLOCK"
grep -Fq 'SYSTEMFORGE_OFFSITE_CONFIG=/opt/systemforge-backups/.offsite/offsite-backup.env' "$DEPLOY_BLOCK"
grep -Fq 'SYSTEMFORGE_RESTIC_BIN=/opt/systemforge-backups/.offsite/restic' "$DEPLOY_BLOCK"
grep -Fq 'SYSTEMFORGE_RESTIC_SHA256=$RESTIC_BINARY_SHA256' "$DEPLOY_BLOCK"
grep -Fq 'restic_${RESTIC_RELEASE_VERSION}_linux_amd64.bz2' "$DEPLOY_BLOCK"
grep -Fq 'bzip2 --decompress --stdout "$RESTIC_ARCHIVE" > "$RESTIC_SOURCE"' "$DEPLOY_BLOCK"
grep -Fq 'sh scripts/provision_offsite_backup.sh' "$DEPLOY_BLOCK"
grep -Fq 'sh scripts/provision_offsite_backup.test.sh' "$CI_WORKFLOW"
PROVISION_LINE=$(grep -nF 'sh scripts/provision_offsite_backup.sh' "$DEPLOY_BLOCK" | cut -d: -f1)
DEPLOY_LINE=$(grep -nF 'sh scripts/deploy_hetzner.sh' "$DEPLOY_BLOCK" | cut -d: -f1)
REVALIDATE_LINE=$(grep -nF 'Revalidate the release before production mutation' "$DEPLOY_BLOCK" | cut -d: -f1)
BACKUP_SCP_LINE=$(grep -nF '"$SSH_USER@$SSH_HOST:/tmp/"' "$DEPLOY_BLOCK" | head -1 | cut -d: -f1)
PROVISION_FETCH_LINE=$(grep -nF 'git fetch origin main' "$DEPLOY_BLOCK" | head -1 | cut -d: -f1)
test "$(grep -cF 'git fetch origin main' "$DEPLOY_BLOCK")" -ge 2
test "$REVALIDATE_LINE" -lt "$BACKUP_SCP_LINE"
test "$PROVISION_FETCH_LINE" -lt "$PROVISION_LINE"
test "$PROVISION_LINE" -lt "$DEPLOY_LINE"

# The release script opens the approved route only after in-network smoke and
# backup/restore gates. The external origin remains an explicit protected value
# rather than a hard-coded alternate destination.
grep -Fq 'EXTERNAL_SMOKE_URL: ${{ vars.SYSTEMFORGE_EXTERNAL_SMOKE_URL }}' "$WORKFLOW"
grep -Fq 'SYSTEMFORGE_EXTERNAL_SMOKE_URL=$EXTERNAL_SMOKE_URL' "$WORKFLOW"
if grep -Fq 'SYSTEMFORGE_EXTERNAL_SMOKE_URL=https://' "$WORKFLOW"; then
  echo "The deployment workflow hard-codes a public smoke before bootstrap." >&2
  exit 1
fi

MONITOR_WORKFLOW=.github/workflows/production-monitor.yml
grep -Fq 'environment: production' "$MONITOR_WORKFLOW"
grep -Fq 'DEPLOY_ENABLED: ${{ vars.HETZNER_DEPLOY_ENABLED }}' "$MONITOR_WORKFLOW"
grep -Fq 'EXTERNAL_SMOKE_URL: ${{ vars.SYSTEMFORGE_EXTERNAL_SMOKE_URL }}' "$MONITOR_WORKFLOW"
grep -Fq 'RELEASE_APPROVAL: ${{ vars.SYSTEMFORGE_RELEASE_APPROVED }}' "$MONITOR_WORKFLOW"
grep -Fq 'test "$DEPLOY_ENABLED" = true' "$MONITOR_WORKFLOW"
grep -Fq 'test "$RELEASE_APPROVAL" = I_AM_READY_FOR_PRODUCTION' "$MONITOR_WORKFLOW"
grep -Fq 'test "$EXTERNAL_SMOKE_URL" = https://systemforge.elfeel.me' "$MONITOR_WORKFLOW"
if grep -Fq '    if:' "$MONITOR_WORKFLOW"; then
  echo "Production monitoring must not gate on environment variables before the job starts." >&2
  exit 1
fi

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
grep -Fq 'sh "$RESTORE_VERIFIER" "$RESTORED_DUMP"' scripts/verify_offsite_restore.sh
grep -Fq 'sh "$APP_DIR/scripts/install_caddy_route.sh" open' scripts/deploy_hetzner.sh
grep -Fq 'sh "$APP_DIR/scripts/install_caddy_route.sh" closed' scripts/deploy_hetzner.sh
if grep -Fq 'PUBLIC_ROUTE_INSTALLED' scripts/deploy_hetzner.sh; then
  echo "First-release rollback must always restore the closed route." >&2
  exit 1
fi
grep -Fq 'uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8' "$WORKFLOW"
grep -Fq 'actions: read' "$WORKFLOW"
grep -Fq 'run-id: ${{ needs.validate.outputs.ci_run_id }}' "$WORKFLOW"
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
