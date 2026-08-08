# Release-readiness evidence

SystemForge is engineering-ready for continued private review, but public
release remains **NO-GO** until the owner explicitly says the product is done
and ready for production. This document separates current checkout evidence
from the later public-release actions.

## Current checkout evidence

The 2026-08-08 checkout passed the following checks:

- Complete quality gate: formatting, lint, TypeScript, 66 behavioral tests,
  all workspace builds, and the four-check Sites packaging contract.
- `pnpm test:coverage`: 93.68% statements, 82.06% branches, 96.31% functions,
  and 94.5% lines across the selected simulation, API, worker, and
  browser control paths.
- `pnpm test:performance`: 250 representative deterministic simulations within
  the two-second budget. Performance is measured separately from V8 coverage
  instrumentation.
- `pnpm audit --prod --audit-level=high`: no known production dependency
  vulnerabilities.
- `sh scripts/deploy_hetzner.test.sh`: successful external shell/readiness
  acceptance, complete previous-image rollback, and first-deploy or incomplete
  rollback failure paths that leave only PostgreSQL running.
- `sh scripts/stage_hetzner.test.sh`: exact-image admission, approval-aware
  staging, and the closed-release path that reinstalls the hardened Caddy route
  before stopping every application service.
- `sh scripts/install_caddy_route.test.sh`: closed/open route selection,
  stdin-based validation and reload, unique backups, and a failed-reload
  rollback that restores and reloads the previous proxy configuration.
- `sh scripts/edge_contract.test.sh`: browser revalidation and Cloudflare-only
  stale-shell headers are present, with no `s-maxage` directive that would
  disable the intended stale fallback.
- `node scripts/service_worker_contract.test.mjs`: an origin `5xx` navigation
  serves the cached local lab, ordinary `4xx` responses remain visible, and API
  requests bypass the shell cache.
- `node scripts/overload_smoke_contract.test.mjs`: the production-image burst
  oracle distinguishes admitted, rate-limited, and concurrency-limited
  requests; enforces retry and local-mode guidance; preserves an independent
  visitor; and keeps the web shell available throughout the burst.
- `sh scripts/verify_cloudflare_ranges.sh`: the future open Caddy allowlist
  exactly matches Cloudflare's current published IPv4 and IPv6 origin ranges.
- Closed release-gate checks: both deployment and open-route installation exit
  78 without `I_AM_READY_FOR_PRODUCTION`.
- Deployment workflow contract: only a successful same-repository `main` push
  can deploy, first-bootstrap public smoke is opt-in, and Hetzner loads the
  checksum-verified SHA-tagged images already scanned and exercised by CI
  instead of rebuilding mutable tags.
- Actionlint 1.7.12, downloaded from its upstream release and verified against
  SHA-256
  `8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8`,
  accepts all three GitHub Actions workflows. CI repeats the same pinned-binary
  check before repository contracts can pass.
- Browser trust-boundary regressions: malformed local architectures are
  rejected, interviewer sessions restore their role only with a valid host
  credential, and participant drafts and links remove hidden rubric material.
- Browser-local admission rejects pathological duration/topology combinations
  before allocating a simulation worker.
- Microsoft Edge 151 at 1564 by 1070 and 390 by 844: no document overflow,
  console errors, or failed network requests across landing, lab, custom, and
  interview flows. A separate 1440 by 1000 pass cleared service-worker state,
  loaded the current production build, forced the browser fully offline,
  reloaded `/lab`, and completed a local simulation while canonical submission
  remained disabled. See `design-qa.md` for visual comparison evidence.

An earlier pre-release rehearsal used checksum-addressed source artifact
`a328b6a3a7a3008f561ef12b7b5e90a5f7349dbfc4ac60b643733a1da1571532`
(1.4 MB, 155 entries) was uploaded and verified on the target Hetzner host.
From that exact checkout, the canonical-enabled API, web, and worker images
were saved as image bundle
`38bb30672ee9ea817014c8a5ca1bbe40bad14f860d170164a0b68c075e0ed93c`
(115 MB). The source image tags were deleted, the bundle was loaded again, and
an isolated temporary Compose project was started with `--no-build`. This
exercised the current CI-to-Hetzner immutable-image handoff without allowing the
destination to rebuild different images. The loaded images then passed:

- production image builds and health checks for web, API, worker, migration,
  and PostgreSQL services;
- the complete migration set, with the migration container exiting zero;
- candidate/interviewer privacy separation, synchronized reveal policy, and
  digest-only host credentials;
- canonical engine 0.3.0 execution and deterministic result digesting;
- exhausted-lease failure recovery;
- bounded canonical workloads returning 422 with `localModeAvailable: true`;
- a two-record durable-run ceiling evicting the oldest terminal result before
  accepting replacement work while never exceeding the configured cap;
- a 100,000-byte test result ceiling failing an oversized canonical result with
  `result_too_large` before persistence while a normal replacement run remained
  completed;
- read-only web/API/worker root filesystems, dropped capabilities,
  `no-new-privileges`, and non-root Node API/worker processes;
- zero host port bindings, with only web and API on the external `web` network
  and PostgreSQL and the worker restricted to the internal network;
- the canonical-enabled release web image building and serving its application
  shell inside the private Compose network, including service-worker cache v3,
  origin-5xx local fallback, API bypass, and its browser cache headers.

The immediately preceding full-infrastructure rehearsal, source artifact
`c0612eb409f7e6ff6a52e4d191ddc74bd34606ca3ab2b3f0447f7cfccd049d4b`,
also validated both closed and future open Caddy configurations under Caddy
2.9, including Cloudflare-only origin access, visitor-IP forwarding, and the
intended browser and Cloudflare cache headers.

The earlier migration-compatibility rehearsal, artifact
`fcc5ef425a2d628c47d23ed3d9050afbbec95d831884b8a5fe9ff401b0544c0f`,
also proved a previous API image could create and retrieve a host session
against the new schema before the current migrator hashed and cleared its
legacy raw token. That rehearsal included a PostgreSQL custom-format backup and
disposable restore. No persistence or migration code changed between that pass
and the immutable-image handoff rehearsal.

Follow-up source artifact
`2cc266f2cdcf875d4cc105ade76814ab5b59afe747ca40e4bd44d212e39978d6`
(1.4 MB) was uploaded and verified for the production-image overload boundary.
An isolated canonical-enabled stack on the target Hetzner host used an
eight-request concurrent admission budget and a 120-request per-client rate
budget. Two fresh synthetic visitors each sent 256 concurrent API requests
while 48 web-shell requests ran alongside them:

- the first burst admitted 120, returned 19 structured `429` responses, and
  returned 117 structured `503` responses;
- the second burst admitted 12 and returned 244 structured `503` responses;
- every limited response included `Retry-After`, a positive retry interval, and
  `localModeAvailable: true`;
- after each burst, liveness, readiness, the independent visitor, and the
  local-capable web shell remained available;
- API, web, and worker containers remained healthy with zero restarts and no
  OOM kill. The settled API used 58.12 MiB of its 768 MiB limit and the web
  container used 11.46 MiB of its 256 MiB limit.

The temporary services, private network, database volume, verification images,
credentials, source archive, and disposable backup were removed after the
checks. The production SHA and database-only service state remained unchanged.

## Release boundary confirmed closed

- The proxied Cloudflare DNS record for `systemforge.elfeel.me` resolves, and
  the live Caddy origin has a valid certificate for the hostname.
- The running managed SystemForge Caddy block is the checked-in 404-only route;
  the public hostname returns that hardened `404` without serving the product.
- Web, API, worker, and migration services are stopped on the production
  project. Only its private PostgreSQL container remains healthy.
- Ordinary web builds compile canonical services off.
- Every trusted green `main` CI run automatically stages its checksum-verified
  images and exact source revision on Hetzner. With approval absent, staging
  reinstalls the closed Caddy route and stops every application service.
- The dependent public-deploy job requires both protected GitHub release
  variables. The scheduled public monitor additionally requires the approved
  external smoke URL, so a staged revision or first private bootstrap cannot
  accidentally be treated as public.

A production release must use the exact committed SHA whose quality,
repository, container-scan, and integration jobs succeed. Local checkout
evidence must not be described as an exact-image CI pass, and an earlier green
SHA must not be used as evidence for later working-tree changes.

## Gates after explicit owner approval

Public release requires all of the following in order:

- commit and push the reviewed checkout, then require green quality,
  repository, container-scan, and integration jobs for that exact SHA;
- create or verify the protected `production` GitHub environment, variables,
  and dedicated SSH secret;
- establish an independently recoverable off-host backup or Hetzner backup
  policy for canonical data;
- enable the two production approval variables;
- deploy the exact tested SHA and pass the in-network smoke while rollback is
  armed;
- install the open Caddy route and pass the external readiness smoke through
  the existing proxied Cloudflare record;
- confirm the scheduled monitor runs successfully and record the first public
  restore and incident-response evidence.

Until those gates are deliberately opened, the correct production state is the
closed one described above.
