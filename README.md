# SystemForge

SystemForge is a deterministic distributed-systems laboratory. Architectures can run entirely in the browser, while the production control plane accepts bounded canonical runs for durable sharing and comparison.

## Product modes

- **Guided** scenarios disclose their requirements and teach a specific systems problem.
- **Custom** scenarios let authors define workloads, incidents, requirements, and shareable challenges.
- **Interview** scenarios separate the interviewer brief and hidden evaluation criteria from the candidate's editable derived requirements, with enforced never, after-first-run, and interviewer-controlled reveal policies for canonical sessions.

The local simulator is intentionally independent from the API. If the service is overloaded or unavailable, the installed application keeps editing and running locally while canonical submission and server-backed sharing are disabled.
The canonical control plane separately bounds request concurrency, queued runs,
durable records, stored short links, input size, serialized result size, and
modeled work so server pressure cannot remove the browser-local workflow.
The static shell is isolated from API capacity, cached by the service worker for
returning browsers, and carries a separate Cloudflare stale-on-error policy so
canonical overload does not turn into a blank product surface.

## Production status

The public release is intentionally locked. The checked-in Caddy route returns
404, deployment automation requires an explicit release sentinel, canonical UI
services stay disabled in ordinary builds, and production monitoring remains
off. Do not open `systemforge.elfeel.me` until the owner explicitly says the
product is done and ready for production. The approval and deployment procedure
is documented in `docs/operations/production.md`; verified and still-pending
release gates are tracked in `docs/release-readiness.md`.

## Workspace

- `apps/web` — React/Vite workspace and offline-capable local simulator.
- `apps/api` — Fastify control plane and overload-safe submission API.
- `apps/worker` — bounded canonical simulation worker.
- `packages/contracts` — versioned architecture, scenario, run, and error contracts.
- `packages/sim-core` — deterministic simulation and requirement evaluation.
- `deploy` — isolated Hetzner Docker Compose deployment.

Commands are run from the repository root with pnpm. See `docs/operations/production.md` before changing production.
