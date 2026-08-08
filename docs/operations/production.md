# Production operations

The production target is `systemforge.elfeel.me` on the existing Hetzner host. The host contract is `/opt/systemforge` for the application, the external Docker network `web`, and `/opt/caddy` as the only owner of public ports 80 and 443. PostgreSQL never joins `web` and no SystemForge Compose service publishes a host port.

## Required GitHub production configuration

Production is intentionally release-locked. The proxied DNS record is already
provisioned, but the live managed route must remain the hardened 404-only route.
Do not start the application containers or install the open Caddy route until
the owner explicitly says the product is done and ready for production.

Create a protected `production` environment and configure these host variables
before enabling automatic staging:

- `HETZNER_HOST=65.21.109.224`
- `HETZNER_SSH_PORT=22`
- `HETZNER_USER=feel`
- `HETZNER_SSH_KNOWN_HOSTS=65.21.109.224 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBbsWzd5va1/wwTeM1P1K6AqPaGzG9GlgIpO7pBPBhX6`

Add `HETZNER_SSH_PRIVATE_KEY` as an environment secret. Use a dedicated key
whose public half is present in `feel`'s `authorized_keys`. Leave the following
public-release variables unset until the explicit owner approval:

- `HETZNER_DEPLOY_ENABLED=true`
- `SYSTEMFORGE_RELEASE_APPROVED=I_AM_READY_FOR_PRODUCTION`

Leave `SYSTEMFORGE_EXTERNAL_SMOKE_URL` unset during the first approved
bootstrap. After the open Caddy route and proxied DNS record are serving
correctly through Cloudflare, set the repository variable to
`https://systemforge.elfeel.me`. Future deployments will then require the
public shell and readiness smoke to pass before accepting a revision, and the
scheduled production monitor will become active.

The deployment workflow only accepts a successful same-repository
`SystemForge CI` push on `main`. CI builds canonical-enabled images tagged with
that SHA, scans them, packages them as a checksum-addressed two-day artifact,
and loads the same images for the PostgreSQL integration and restore drill. The
always-on staging job downloads that artifact, verifies it again, transfers it
over strict-host-key SSH, loads the exact images, verifies `origin/main`, and
performs a fast-forward-only pull. While either public-release variable is
absent, staging also reinstalls the checked-in closed Caddy route and stops web,
API, worker, and migration services while preserving PostgreSQL. When both
approval variables are present, a dependent deployment job tells the host to
use the already-staged images and reject any missing image instead of rebuilding
a different one.
The checked-in host-key value was recovered from the currently trusted local
entry; verify its fingerprint through the Hetzner console before enabling the
workflow. CI uses strict host-key checking and will fail closed if the host
identity changes.

The private environment also exposes explicit overload budgets:

- `MAX_QUEUED_RUNS=250`
- `MAX_STORED_RUNS=250`
- `MAX_SHARED_SCENARIOS=2000`
- `MAX_CANONICAL_WORK_UNITS=30000`
- `MAX_CANONICAL_RESULT_BYTES=8500000`
- `MAX_CONCURRENT_REQUESTS=96`

Change them only after measuring the VPS under the representative integration
smoke. Raising a canonical limit never changes the browser-local limits or
availability path. The stored-run ceiling evicts the oldest completed or failed
result before accepting new work and fails closed if active work occupies the
entire durable budget. The worker also rejects a serialized canonical result
above the result-byte ceiling before PostgreSQL persistence, preventing a
maximum-shape request from multiplying into unbounded durable storage.

## First host bootstrap

Clone the repository to `/opt/systemforge`. Copy `deploy/.env.example` to `deploy/.env`, set a URL-safe random `POSTGRES_PASSWORD`, leave the environment file mode at `0600`, and do not commit it. Then run:

```sh
cd /opt/systemforge
SYSTEMFORGE_RELEASE_APPROVED=I_AM_READY_FOR_PRODUCTION sh scripts/deploy_hetzner.sh "$(git rev-parse HEAD)"
SYSTEMFORGE_RELEASE_APPROVED=I_AM_READY_FOR_PRODUCTION sh scripts/install_caddy_route.sh open
sh scripts/install_backup_cron.sh
```

Without the explicit approval value, deployment and open-route installation exit
without changing production. Running `sh scripts/install_caddy_route.sh closed`
installs the checked-in 404-only route. The Caddy installer writes a unique
timestamped backup, replaces only the marked SystemForge block, and streams the
exact candidate into Caddy for validation and reload. Streaming avoids stale
single-file Docker bind mounts after a host-side file replacement. A failed
reload restores and reloads the previous configuration without restarting the
shared proxy.

## Cloudflare edge

The proxied `A` record named `systemforge` points at `65.21.109.224` with
automatic TTL. Keep proxy status enabled. Until release approval, the hostname
must return the closed Caddy `404`, never the application or an origin error.
The future open SystemForge Caddy block contains Cloudflare's published IPv4
and IPv6 origin ranges and rejects requests for this hostname that do not arrive
through Cloudflare. Refresh the list from `https://www.cloudflare.com/ips-v4`
and `https://www.cloudflare.com/ips-v6` when Cloudflare announces a range
change, validate Caddy, and reload it.

`scripts/verify_cloudflare_ranges.sh` compares the future open Caddy route with
those live official lists. CI runs it before any green build can trigger a
deployment, and the gated production monitor repeats it after release. A fetch
failure or any added, removed, or reordered range fails closed instead of
silently deploying an origin allowlist that Cloudflare has superseded.

The API proxy overwrites `X-Forwarded-For` with Cloudflare's single-value
`CF-Connecting-IP` header after that source-range check. This prevents a client
from spoofing the address used by Fastify's per-client rate limiter and avoids
collapsing all visitors into a shared Cloudflare edge address.

The zone was verified as Cloudflare Free with the Cloudflare Managed Free Ruleset and L7 DDoS managed ruleset present. The Free plan supports one zone rate-limit rule, but changing the shared zone rule could affect the other `elfeel.me` services. SystemForge therefore enforces its API write limits in Fastify and uses transactionally bounded queue capacity; introduce a zone rate-limit rule only after reviewing the existing shared-zone security configuration and Security Events.

The web container sends browsers `Cache-Control: public, max-age=0,
must-revalidate` while separately sending Cloudflare
`Cloudflare-CDN-Cache-Control: public, max-age=300,
stale-while-revalidate=60, stale-if-error=86400`. This keeps browser sessions
fresh, gives the edge a five-minute shell, and permits a previously cached shell
to survive origin errors. Do not replace the edge policy with `s-maxage`:
Cloudflare treats `s-maxage` as proxy revalidation, which disables the intended
stale fallback. The in-network production smoke checks both headers on the
actual web image.

Cloudflare recommends proxying HTTP records so traffic is protected at the edge and restricting origin traffic to Cloudflare address ranges. Current documentation: [Cloudflare IP addresses](https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/), [proxied DNS records](https://developers.cloudflare.com/dns/manage-dns-records/reference/proxied-dns-records/), and [rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/).

## Deployment, rollback, and smoke checks

For a manual bootstrap, `scripts/deploy_hetzner.sh` builds images tagged with the tested Git SHA. In automatic deployments, GitHub transfers the exact scanned and integration-tested SHA-tagged image bundle and sets `SYSTEMFORGE_SKIP_BUILD=true`; the script verifies all three images exist and never rebuilds them. It then starts the full Compose project with health waits and runs an in-network production smoke. The functional smoke checks the static shell, database readiness, candidate/interviewer privacy separation, controlled reveal and reconceal, digest-only credential storage, queue submission, worker completion, exhausted-lease recovery, engine version, and canonical digest. A second smoke sends 256 concurrent canonical reads from an isolated synthetic visitor while fetching the web shell 48 times. It requires structured capacity or rate-limit responses with retry and local-mode guidance, an unaffected independent visitor, and healthy API and web services after the burst. Only then is `.last-successful-sha` updated.

The interviewer-token migration keeps a nullable legacy column and a hashing
trigger as a one-release rollback bridge. Current images never write raw tokens;
the migrator hashes and clears any value written while the previous image is
temporarily restored. Remove that bridge only in a later, separately validated
contract migration after the previous image is no longer a rollback target.

During the first explicitly approved bootstrap, the automatic deployment runs
the complete in-network smoke while the public route can remain closed. This
avoids a bootstrap deadlock where a release would need a working public route
before the first healthy containers existed. After the open Caddy route and
proxied DNS are verified, setting `SYSTEMFORGE_EXTERNAL_SMOKE_URL` makes future
automatic deployments verify the public browser shell and readiness endpoint
through Cloudflare before accepting the new revision.
An external-smoke failure keeps the deployment trap active and restores the
last successful application images when they are still present locally.

If deployment fails and a complete previous API, web, and worker image set
exists, the trap restarts those images without rebuilding them. An incomplete
or missing previous release stops all application services while leaving the
database intact, so a failed first deployment cannot remain partially live.
Database migrations must remain backward-compatible because schema rollback is
intentionally not automatic.

Useful checks:

```sh
cd /opt/systemforge
docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml ps
docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml logs --tail=200 systemforge-api systemforge-worker
curl -fsS https://systemforge.elfeel.me/api/health/ready
```

## Backups and restore gate

The installed cron runs at 02:17 UTC. It creates a PostgreSQL custom-format dump in `/opt/systemforge-backups`, validates it with `pg_restore --list`, applies mode `0600`, and removes verified dumps older than 14 days. Run `scripts/backup_postgres.sh` manually before migrations that modify stored data.

A same-host dump does not protect against VPS or disk loss. Before collecting irreplaceable server-backed data, enable Hetzner server backups or copy the encrypted dumps to independently credentialed object storage. Perform a quarterly restore drill into a disposable PostgreSQL database and record the recovery duration. Until the first off-host copy and restore drill pass, the browser-local workflow is production-usable but canonical data disaster recovery remains a release gate.

Run `sh scripts/verify_backup_restore.sh` after a manual backup and at least
quarterly. It restores the newest verified custom-format dump into a uniquely
named disposable database, checks all migrations and canonical tables, and
drops only that drill database. CI performs the same backup-and-restore path
against its disposable Compose stack.

## Monitoring and incident response

The scheduled production monitor checks both the browser shell and canonical readiness every 15 minutes when deployment is enabled. GitHub Actions failure notifications are the initial alert channel. Docker JSON logs rotate at three 10 MB files per container; Caddy, Fastify, and worker logs are structured.

If readiness fails, do not disable the browser application. Inspect API, worker, and database health; leave local mode available; and restore canonical submission only after queue depth and worker processing are stable. During abusive traffic, confirm Cloudflare proxying and Security Events first, then use Cloudflare's managed challenge controls. Do not raise worker concurrency beyond the host's measured memory/CPU budget during an incident.
