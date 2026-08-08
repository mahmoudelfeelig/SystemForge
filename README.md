# SystemForge

SystemForge is a deterministic distributed-systems laboratory. Architectures can run entirely in the browser, while the production control plane accepts bounded canonical runs for durable sharing and comparison.

## Product modes

- **Guided** scenarios disclose their requirements and teach a specific systems problem.
- **Custom** scenarios let authors define workloads, incidents, requirements, and shareable challenges.
- **Interview** scenarios separate the interviewer brief and hidden evaluation criteria from the candidate's editable derived requirements, with enforced never, after-first-run, and interviewer-controlled reveal policies for canonical sessions.

The local simulator is intentionally independent from the API. If the service is overloaded or unavailable, the installed application keeps editing and running locally while canonical submission and server-backed sharing are disabled.
The canonical control plane separately bounds request concurrency, queued runs,
durable records, stored short links, input size, serialized result size, and
modeled work. Canonical architecture solving adds a separately bounded worker
thread and falls back to the browser-local solver when server capacity is not
available, so server pressure cannot remove the local workflow.
The static shell is isolated from API capacity, cached by the service worker for
returning browsers, and carries a separate Cloudflare stale-on-error policy so
canonical overload does not turn into a blank product surface.

## Production status

The owner authorized the public release on 2026-08-08. Availability is still
controlled by the exact-SHA release pipeline: a successful same-repository
`main` CI run must build, scan, integrate, and stage the immutable images before
the protected production job can start them and replace the hardened 404 route.
The release sentinel cannot bypass quality, backup, restore, in-network, or
Cloudflare smoke gates. The current public state should be checked through
`https://systemforge.elfeel.me/api/health/ready`, not inferred from a local
checkout. The approval and deployment procedure is documented in
`docs/operations/production.md`; current evidence and remaining gates are
tracked in `docs/release-readiness.md`.

## Workspace

- `apps/web` — React/Vite workspace and offline-capable local simulator.
- `apps/api` — Fastify control plane and overload-safe submission API.
- `apps/worker` — bounded canonical simulation worker.
- `packages/contracts` — versioned architecture, scenario, run, and error contracts.
- `packages/sim-core` — deterministic simulation, requirement evaluation, and
  bounded architecture alternative solving.
- `deploy` — isolated Hetzner Docker Compose deployment.

The engine and solver contract, supported trade-offs, verification paths, and
honest model limits are documented in [`docs/engine.md`](docs/engine.md).

Commands are run from the repository root with pnpm. See `docs/operations/production.md` before changing production.
