#!/bin/sh
set -eu

WORKFLOW=.github/workflows/deploy-hetzner.yml
CI_WORKFLOW=.github/workflows/ci.yml
MONITOR=.github/workflows/production-monitor.yml
EXPECTED_GATEWAY='uses: mahmoudelfeelig/HetznerReleaseGateway/.github/workflows/release.yml@1d0be0bb3b6ac26ce749e382081d320855d5bcba'
TEST_ROOT=$(mktemp -d)
SANITIZED_WORKFLOW="$TEST_ROOT/deploy-workflow-public-boundary.yml"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

# The public repository may request a release only after the exact same-repo
# main-branch push has completed the named CI workflow successfully.
grep -Fq 'workflow_run:' "$WORKFLOW"
grep -Fq 'workflows: ["SystemForge CI"]' "$WORKFLOW"
grep -Fq 'types: [completed]' "$WORKFLOW"
grep -Fq 'branches: [main]' "$WORKFLOW"
grep -Fq "github.event.workflow_run.conclusion == 'success'" "$WORKFLOW"
grep -Fq "github.event.workflow_run.event == 'push'" "$WORKFLOW"
grep -Fq "github.event.workflow_run.head_branch == 'main'" "$WORKFLOW"
grep -Fq 'github.event.workflow_run.head_repository.full_name == github.repository' "$WORKFLOW"
if grep -Eq '^[[:space:]]+(workflow_dispatch|push|pull_request|schedule):' "$WORKFLOW"; then
  echo "The production caller must trigger only from the completed CI workflow." >&2
  exit 1
fi

# The caller has the least privilege needed to inspect the CI run and obtain a
# short-lived release identity. No other permission is accepted.
grep -Fq 'actions: read' "$WORKFLOW"
grep -Fq 'contents: read' "$WORKFLOW"
grep -Fq 'id-token: write' "$WORKFLOW"
awk '
  /^permissions:$/ { selected = 1; next }
  selected && /^  [a-z-]+:/ {
    count++
    if (!(($1 == "actions:" && $2 == "read") ||
          ($1 == "contents:" && $2 == "read") ||
          ($1 == "id-token:" && $2 == "write"))) {
      invalid = 1
    }
    next
  }
  selected { selected = 0 }
  END { exit !(!invalid && count == 3) }
' "$WORKFLOW"

# Exactly one immutable reusable workflow receives exactly the three public
# release claims. Infrastructure mutation cannot be implemented in this file.
test "$(grep -Fc "$EXPECTED_GATEWAY" "$WORKFLOW")" -eq 1
test "$(grep -Ec '^[[:space:]]*uses:' "$WORKFLOW")" -eq 1
grep -Fq 'app: systemforge' "$WORKFLOW"
grep -Fq 'source_sha: ${{ github.event.workflow_run.head_sha }}' "$WORKFLOW"
grep -Fq 'ci_run_id: ${{ github.event.workflow_run.id }}' "$WORKFLOW"
awk '
  /^    with:$/ { selected = 1; next }
  selected && /^      [a-z_][a-z0-9_]*:/ {
    count++
    if (!($1 == "app:" || $1 == "source_sha:" || $1 == "ci_run_id:")) {
      invalid = 1
    }
    next
  }
  selected && !/^      / { selected = 0 }
  END { exit !(!invalid && count == 3) }
' "$WORKFLOW"
if grep -Eq '^[[:space:]]+(run|steps):|^[[:space:]]*secrets:' "$WORKFLOW"; then
  echo "The public caller must contain no executable or credential forwarding surface." >&2
  exit 1
fi

# The expected public gateway identifier contains the provider name by design;
# remove that one reviewed line before scanning for infrastructure disclosures.
grep -Fv "$EXPECTED_GATEWAY" "$WORKFLOW" > "$SANITIZED_WORKFLOW"
if grep -Eiq '(^|[^[:alnum:]_])(ssh|scp|rsync)([^[:alnum:]_]|$)|HETZNER|PRIVATE_KEY|KNOWN_HOSTS|HetznerPlatform|secrets\.|/opt/|([0-9]{1,3}\.){3}[0-9]{1,3}' "$SANITIZED_WORKFLOW"; then
  echo "The public caller discloses or invokes restricted deployment infrastructure." >&2
  exit 1
fi

# CI must continue to package the exact scanned SHA-tagged image set, verify its
# checksum, and load that same artifact for integration without rebuilding it.
grep -Fq 'SYSTEMFORGE_IMAGE_TAG: ${{ github.sha }}' "$CI_WORKFLOW"
grep -Fq 'VITE_CANONICAL_RELEASE_ENABLED: "true"' "$CI_WORKFLOW"
grep -Fq 'image: systemforge-api:${{ github.sha }}' "$CI_WORKFLOW"
grep -Fq 'image: systemforge-web:${{ github.sha }}' "$CI_WORKFLOW"
grep -Fq 'image: systemforge-worker:${{ github.sha }}' "$CI_WORKFLOW"
grep -Fq 'docker save --output "$RUNNER_TEMP/systemforge-release/systemforge-images.tar"' "$CI_WORKFLOW"
grep -Fq 'uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7' "$CI_WORKFLOW"
grep -Fq 'uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8' "$CI_WORKFLOW"
grep -Fq 'name: systemforge-images-${{ github.sha }}-${{ github.run_attempt }}' "$CI_WORKFLOW"
grep -Fq 'sha256sum --check systemforge-images.tar.gz.sha256' "$CI_WORKFLOW"
grep -Fq 'docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml up -d --no-build' "$CI_WORKFLOW"

# Public monitoring must not depend on retired repository deployment material.
if grep -Eiq 'secrets\.|vars\.(HETZNER|SYSTEMFORGE_RELEASE_APPROVED)|PRIVATE_KEY|KNOWN_HOSTS|HetznerPlatform|/opt/|([0-9]{1,3}\.){3}[0-9]{1,3}' "$MONITOR"; then
  echo "Production monitoring depends on restricted deployment configuration." >&2
  exit 1
fi

if grep -E '^[[:space:]]*- uses: [^#]+@(v[0-9]|main|master)([[:space:]#]|$)' .github/workflows/*.yml; then
  echo "GitHub Actions must be pinned to immutable commit SHAs." >&2
  exit 1
fi

for retired in \
  deploy/Caddyfile.systemforge \
  deploy/Caddyfile.systemforge.open \
  scripts/deploy_hetzner.sh \
  scripts/stage_hetzner.sh \
  scripts/install_caddy_route.sh \
  scripts/verify_cloudflare_ranges.sh \
  reports/release-hardening-ledger.json
do
  test ! -e "$retired"
done

if grep -Eiq '/opt/|Caddy|dedicated SSH|host checkout|target Hetzner host' \
  README.md docs/operations/production.md docs/release-readiness.md docs/architecture.md; then
  echo "Public release documentation contains retired private infrastructure details." >&2
  exit 1
fi

echo "Central deployment caller contract passed."
