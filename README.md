# SystemForge

SystemForge is a deterministic distributed-systems laboratory. Architectures can run entirely in the browser, while the production control plane accepts bounded canonical runs for durable sharing and comparison.

## Product modes

- **Guided** scenarios disclose their requirements and teach a specific systems problem.
- **Custom** scenarios let authors define workloads, incidents, requirements, and shareable challenges.
- **Interview** scenarios separate the interviewer brief and hidden evaluation criteria from the candidate's derived requirements.

The local simulator is intentionally independent from the API. If the service is overloaded or unavailable, the installed application keeps editing and running locally while canonical submission and server-backed sharing are disabled.

## Workspace

- `apps/web` — React/Vite workspace and offline-capable local simulator.
- `apps/api` — Fastify control plane and overload-safe submission API.
- `apps/worker` — bounded canonical simulation worker.
- `packages/contracts` — versioned architecture, scenario, run, and error contracts.
- `packages/sim-core` — deterministic simulation and requirement evaluation.
- `deploy` — isolated Hetzner Docker Compose deployment.

Commands are run from the repository root with pnpm. See `docs/operations/production.md` before changing production.
