# Release-readiness evidence

## Current status — 2026-08-09

The current production revision is
`d55fb3eb99184aa29ea42836dd07465dacbbe17e`. It passed protected push CI run
`31327099117` and was manually promoted by exact-SHA deployment run
`31327390155`. The immutable web, API, and worker images, high-severity image
scans, PostgreSQL migrations, container integration, overload behavior,
encrypted backup, and restore gates all passed before the public route opened.
The final external Edge pass then completed 17 route audits and nine interaction
groups with zero unexpected console, network, or acceptance defects.

Current local evidence:

- Two consecutive isolated `pnpm quality` gates passed formatting, ESLint,
  TypeScript project references, 52 files and 412 functional tests, both
  performance budgets, all workspace builds, and 7 Sites packaging tests on
  the same final working tree. The web build transformed 4,886 modules and
  prepared 25 offline assets.
- A fresh `pnpm test:coverage` run passed all 412 tests and reported 92.72%
  statements, 84.54% branches, 93.54% functions, and 93.73% lines across the
  selected critical simulation, contract, API, worker, sharing, and solver
  surfaces. The checked thresholds remain 92%, 84%, 93%, and 93% respectively.
  These percentages describe the configured critical-file denominator, not
  every source file in the product.
- Targeted mutation testing killed all four critical-boundary mutants with
  existing assertions. Fixed-seed stability passed the complete 52-file,
  412-test non-performance suite once serially and once in parallel without
  retry.
- Microsoft Edge 151 passed 17 route audits at 1440 by 900 and 390 by 844,
  including local authoring and sharing, run/pause/intervention/snapshot/fork,
  completion, sampled-trace path playback, replay export/import/comparison,
  automatic candidate-safe Run library persistence, interviewer-versus-candidate
  privacy, mobile fit and touch targets, reduced motion, and four warmed offline
  routes. The current installability follow-up adds dedicated safe-zone
  maskable icons and a tenth interaction group that verifies the manifest and
  Chromium installability result. Unexpected console errors, network errors,
  acceptance defects,
  unnamed focusables, duplicate IDs, and document-level horizontal overflow
  were zero.
- `pnpm audit --prod --audit-level=high` reported no known production
  dependency vulnerabilities. Shell, workflow, service-worker, overload,
  edge, Cloudflare-range, backup, provisioning, and release-backup contracts
  passed. Protected CI supplied the Docker Compose, PostgreSQL,
  immutable-image, scan, backup, restore, and full container-integration
  evidence for the exact promoted SHA.
- Independent engine, privacy, async-state, static-delivery, AI-boundary,
  workflow, and UI acceptance reviews found no surviving source-confirmed or
  browser-confirmed P0, P1, or P2 issue in the current checkout.
- The deterministic engine is version 0.7.0. Directed request classes execute
  through topology edges; seeded incidents, state-capability rules, bounded
  paused interventions, replay evidence, behavioral profiles, robustness, and
  output/work admission are covered by the current regression suite.
- Shared-scenario creation is limited to 10 requests per client IP per day by
  default. New records expire after 30 days, and expired records are removed
  inside the capacity-locked PostgreSQL transaction before active capacity is
  counted.
- Unknown routes, crawl files, manifest MIME, service-worker API bypass,
  shared-link `X-Robots-Tag`, immutable-cache behavior, and the branded outage
  fallback are covered by repository delivery contracts.

The optional AI layer was verified with credential-free fake-provider tests
and remains disabled by default. Its production profile pins Cloudflare
Workers AI `@cf/openai/gpt-oss-20b`, allows at most 10 provider reservations per
UTC day, reserves 5 cents per request, and fails closed at 400 reserved cents
per UTC month. The documented Cloudflare AI Gateway must additionally have a
blocking $4.50 monthly spend limit with no fallback provider. No real provider
credential, billing path, Gateway spend limit, or provider-retention
configuration was exercised. The browser pass also does not
constitute a screen-reader certification, target-device Core Web Vitals run,
or physical-device install test. The offline evidence used an already warmed
service worker rather than a first-install cold PWA. Dedicated 192px and 512px
maskable icons now keep the unchanged approved elephant mark inside the
mask-safe center, and Edge reports zero installability errors, but a physical
launcher preview remains external. These are recorded external-validation
limitations, not evidence supplied by the automated release.

The first post-promotion live matrix confirmed the current application shell,
engine 0.7.0 assets, Replay route, crawl files, manifest MIME, service worker,
shared-link noindex, API readiness, strict CSP, and `no-transform` responses.
Known SPA routes returned 200, unknown routes returned a real 404, and the old
Cloudflare script injections were absent from application HTML. The audit also
found that nginx returned its generic 404 body instead of the application route
state and that Cloudflare still served the removed 1.21 MB blueprint PNG from
an old immutable cache key even though a cache-busted origin request returned 404. The promoted route-state and content-versioned asset follow-ups now keep
the real 404 status while serving the accessible application route state,
avoid the stale keys, and have passed exact-SHA CI, deployment, and the complete
public browser matrix.

The first external Edge pass against that follow-up completed every desktop and
mobile route, authoring, simulation, replay, and privacy workflow, then exposed
two older Cloudflare negative-cache entries: the current WebP blueprint and
192px PWA icon existed at origin but their unversioned public keys returned
cached 404s, preventing service-worker installation. The current repair uses
content-versioned URLs for both files, versions the service-worker registration,
bumps its cache generation, and rejects the broken unversioned blueprint key in
the generated precache manifest. The exact versioned URLs were verified against
the public origin before the change, and the complete local Edge offline gate
passed afterward. The old keys still require account-authorized purge as edge
housekeeping; the application and service worker no longer depend on them.
Cloudflare account credentials were not present in this checkout, so that purge
and a real Workers AI transaction remain external operator actions.

## Historical release authorization and rehearsals

The owner authorized a SystemForge public release on 2026-08-08. That approval
is historical evidence for the revision evaluated at the time; it is not a
persistent authorization for this working tree or any later SHA. A future
promotion requires a new manual, exact-revision dispatch after the committed SHA
passes every CI, image, integration, backup, restore, in-network, and Cloudflare
smoke gate described here.

## Historical 2026-08-08 checkout evidence

The 2026-08-08 checkout passed the following checks:

- Complete quality gate: formatting, lint, TypeScript, 105 behavioral tests,
  all workspace builds, and the four-check Sites packaging contract.
- `pnpm test:coverage`: 92.14% statements, 82.28% branches, 92.79% functions,
  and 93.02% lines across the selected simulation, solver, API, worker, browser
  worker, and canonical-fallback control paths.
- `pnpm test:performance`: 250 representative deterministic simulations and
  five bounded 12-candidate architecture searches, each within its separate
  two-second budget. Performance is measured separately from V8 coverage
  instrumentation.
- `pnpm audit --prod --audit-level=high`: no known production dependency
  vulnerabilities.
- `sh scripts/deploy_hetzner.test.sh`: successful external shell/readiness
  acceptance, complete previous-image rollback, and first-deploy or incomplete
  rollback failure paths that leave only PostgreSQL running.
- `sh scripts/stage_hetzner.test.sh`: exact-image admission and a one-time
  confirmation gate that exits before any host mutation when authorization is
  absent.
- `sh scripts/install_caddy_route.test.sh`: closed/open route selection,
  stdin-based validation and reload, unique backups, and a failed-reload
  rollback that restores and reloads the previous proxy configuration.
- `sh scripts/edge_contract.test.sh`: browser revalidation and Cloudflare-only
  stale-shell headers are present, with no `s-maxage` directive that would
  disable the intended stale fallback.
- `sh scripts/offsite_backup.test.sh`: insecure credential files, missing or
  uninitialized repositories, integrity-check failures, and empty restores fail
  closed; successful runs apply tagged retention, write mode-`0600` evidence,
  preserve the local-first cron order, create a mode-`0700` cron output
  directory, reject unsafe cron paths, and validate the restored dump through
  a separate verifier.
- `sh scripts/release_backup_gate.test.sh`: approved deployment requires a
  fresh encrypted copy and current restore evidence, reuses valid restore
  evidence, repeats the drill after migration changes, and fails closed on
  insecure credentials or a failed restore.
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
- Deployment workflow contract: `main` pushes cannot stage or deploy. A manual
  dispatch must bind an exact current-main SHA to its successful
  same-repository `SystemForge CI` run ID and exact typed confirmation before
  protected-environment secrets or the checksum-verified image artifact become
  available. Hetzner loads that tested artifact instead of rebuilding mutable
  tags.
- Actionlint 1.7.12, downloaded from its upstream release and verified against
  SHA-256
  `8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8`,
  accepts all three GitHub Actions workflows. CI repeats the same pinned-binary
  check before repository contracts can pass.
- Browser trust-boundary regressions: malformed local architectures are
  rejected, interviewer sessions restore their role only with a valid host
  credential, and participant drafts and links remove hidden rubric material.
- Browser-local admission rejects pathological duration/topology/candidate
  combinations before allocating simulation or solver workers. Both workers
  terminate at their wall-clock limit, and the production build emits them as
  separate assets rather than running either engine on the UI thread.
- Canonical admission rejects stale browser-engine versions before queueing,
  the worker independently rejects incompatible queued jobs, and the browser
  keeps local simulation available with explicit refresh guidance.
- The architecture-solver core deterministically ranks bounded parameter and
  operating-policy alternatives, enforces cost, complexity, component-lock, and
  work-unit limits, excludes hidden interview requirements by default, and may
  return no recommendation when the baseline dominates. Browser-local solving,
  canonical transport, disposable Node-worker isolation, independent solver
  concurrency, timeout/result caps, overload fallback, Lab result state, and
  stale-result suppression are implemented. The Lab decision workbench now
  exposes bounded policy controls, Pareto comparison, exact deltas and
  violations, reversible candidate application, named versions, topology
  proposals, multi-seed robustness, traffic and provider imports, mission
  loading, and privacy-scoped evidence export.
- Interview collaboration stores a shared candidate journal, candidate phase,
  and session clock while keeping interviewer notes inaccessible to participant
  links. The migration, memory store, PostgreSQL store, API role checks, browser
  hydration, and same-SPA interviewer-role preservation have regression
  coverage.
- Microsoft Edge 151 at 1672 by 941 and 390 by 844: no document overflow,
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

## Release authorization and promotion boundary

- The proxied Cloudflare DNS record for `systemforge.elfeel.me` resolves, and
  the live Caddy origin has a valid certificate for the hostname.
- Before promotion, the managed SystemForge Caddy block remains the checked-in
  404-only route and application services remain stopped. After promotion, the
  exact image SHA, public readiness response, and monitor run are the evidence
  of availability; owner approval alone is not.
- Ordinary web builds compile canonical services off.
- Green `main` CI runs publish a checksum-verified image artifact but never
  stage or deploy it automatically.
- A manual deployment dispatch validates the exact successful CI run ID, exact
  current-main SHA, same repository, workflow identity, and the typed
  `AUTHORIZE_SYSTEMFORGE_PRODUCTION_RELEASE` confirmation before entering the
  protected production environment. Unapproved staging exits without changing
  Caddy or a running release.
- The scheduled public monitor additionally requires the approved external
  smoke URL, so a candidate artifact cannot accidentally be treated as public.

A production release must use the exact committed SHA whose quality,
repository, container-scan, and integration jobs succeed. Local checkout
evidence must not be described as an exact-image CI pass, and an earlier green
SHA must not be used as evidence for later working-tree changes.

## Approved production gates

Public release requires all of the following in order:

- commit and push the reviewed checkout, then require green quality,
  repository, container-scan, and integration jobs for that exact SHA;
- create or verify the protected `production` GitHub environment, variables,
  and dedicated SSH secret;
- establish an independently recoverable off-host backup or Hetzner backup
  policy for canonical data and initialize its credentials; the approved
  deployment itself now enforces the first real encrypted copy and independent
  restore drill before it can succeed;
- manually dispatch the exact SHA and successful CI run ID with the required
  typed confirmation, then approve the protected production environment;
- deploy the exact tested SHA and pass the in-network smoke while rollback is
  armed;
- install the open Caddy route and pass the external readiness smoke through
  the existing proxied Cloudflare record;
- confirm the scheduled monitor runs successfully and record the first public
  restore and incident-response evidence.

The release is complete only after those gates pass for the same committed SHA
and the public shell and readiness endpoint respond through Cloudflare. Any
failed gate must leave the hardened closed route or restore the last complete
release rather than expose a partial stack.
