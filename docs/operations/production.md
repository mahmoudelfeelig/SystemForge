# Production operations

The production target is `systemforge.elfeel.me` on the existing Hetzner host. The host contract is `/opt/systemforge` for the application, the external Docker network `web`, and `/opt/caddy` as the only owner of public ports 80 and 443. PostgreSQL never joins `web` and no SystemForge Compose service publishes a host port.

## Required GitHub production configuration

Create a protected `production` environment and configure these repository variables:

- `HETZNER_DEPLOY_ENABLED=true`
- `HETZNER_HOST=65.21.109.224`
- `HETZNER_SSH_PORT=22`
- `HETZNER_USER=feel`

Add `HETZNER_SSH_PRIVATE_KEY` as an environment secret. Use a dedicated key whose public half is present in `feel`'s `authorized_keys`. The deployment workflow only runs for a successful `SystemForge CI` `workflow_run` on `main`, verifies that `origin/main` exactly equals the tested SHA, and then performs a fast-forward-only pull.

## First host bootstrap

Clone the repository to `/opt/systemforge`. Copy `deploy/.env.example` to `deploy/.env`, set a URL-safe random `POSTGRES_PASSWORD`, leave the environment file mode at `0600`, and do not commit it. Then run:

```sh
cd /opt/systemforge
sh scripts/deploy_hetzner.sh "$(git rev-parse HEAD)"
sh scripts/install_caddy_route.sh
sh scripts/install_backup_cron.sh
```

The Caddy installer writes a timestamped backup, replaces only the marked SystemForge block, validates the complete live Caddyfile inside the running Caddy container, restores the backup on failure, and reloads without restarting the proxy.

## Cloudflare edge

Create a proxied `A` record named `systemforge` pointing at `65.21.109.224` with automatic TTL. Keep proxy status enabled. The SystemForge Caddy block contains Cloudflare's published IPv4 and IPv6 origin ranges and rejects requests for this hostname that do not arrive through Cloudflare. Refresh the list from `https://www.cloudflare.com/ips-v4` and `https://www.cloudflare.com/ips-v6` when Cloudflare announces a range change, validate Caddy, and reload it.

The zone was verified as Cloudflare Free with the Cloudflare Managed Free Ruleset and L7 DDoS managed ruleset present. The Free plan supports one zone rate-limit rule, but changing the shared zone rule could affect the other `elfeel.me` services. SystemForge therefore enforces its API write limits in Fastify and uses transactionally bounded queue capacity; introduce a zone rate-limit rule only after reviewing the existing shared-zone security configuration and Security Events.

Cloudflare recommends proxying HTTP records so traffic is protected at the edge and restricting origin traffic to Cloudflare address ranges. Current documentation: [Cloudflare IP addresses](https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/), [proxied DNS records](https://developers.cloudflare.com/dns/manage-dns-records/reference/proxied-dns-records/), and [rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/).

## Deployment, rollback, and smoke checks

`scripts/deploy_hetzner.sh` builds immutable images tagged with the tested Git SHA, starts the full Compose project with health waits, and runs an in-network production smoke. The smoke checks the static shell, database readiness, candidate/interviewer privacy separation, queue submission, worker completion, engine version, and canonical digest. Only then is `.last-successful-sha` updated.

If deployment fails and the previous tagged images still exist, the trap restarts the previous web, API, and worker images without rebuilding them. Database migrations must remain backward-compatible because schema rollback is intentionally not automatic.

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

## Monitoring and incident response

The scheduled production monitor checks both the browser shell and canonical readiness every 15 minutes when deployment is enabled. GitHub Actions failure notifications are the initial alert channel. Docker JSON logs rotate at three 10 MB files per container; Caddy, Fastify, and worker logs are structured.

If readiness fails, do not disable the browser application. Inspect API, worker, and database health; leave local mode available; and restore canonical submission only after queue depth and worker processing are stable. During abusive traffic, confirm Cloudflare proxying and Security Events first, then use Cloudflare's managed challenge controls. Do not raise worker concurrency beyond the host's measured memory/CPU budget during an incident.
