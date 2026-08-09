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

SystemForge also has an optional, server-side AI assistance layer. When an
operator explicitly enables and configures it, the Scenario Editor can turn a
written brief into a validated preview, the Report tab can explain a completed
canonical run using exact server-supplied evidence, and the Interview room can
draft candidate-visible discovery questions. AI output never runs the simulator,
never supplies modeled measurements, and never changes a draft until the user
applies a proposal that passes the ordinary contracts. The feature is disabled
by default; the local editor, simulator, solver, and replay workflow do not
depend on it. Submitted text leaves SystemForge for the configured provider, and
retention depends on that provider account's data controls.
The production provider is Cloudflare Workers AI through a dedicated AI
Gateway. Admission is globally limited to ten calls per UTC day, every admitted
call consumes a conservative five-cent reservation, and the application stops
at four dollars of reservations per UTC month. The separate Gateway blocking
limit is configured at $4.50 per month, leaving a buffer beneath the absolute
five-dollar release ceiling.

## Local development and deterministic demo

Use Node.js 24 or newer and pnpm 11.16.0. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The Vite URL printed by `pnpm dev` is the complete local-first product. Open
`/lab` and choose **Run locally**; an API, account, database, or network
connection is not required for the modeled run. `pnpm dev:api` and
`pnpm dev:worker` are separate canonical-service development commands and are
not prerequisites for the browser-local workflow.

For a repeatable presenter reset, open **Compare**, select **Scenarios**, and
load **Black Friday Checkout**. That restores the versioned example scenario
and architecture through the same validated store actions used by ordinary
editing. Then:

- start the local run and pause after the first delivered frames;
- select a component, schedule one future intervention or outage, and resume;
- inspect the linked events, sampled request spans, resource histories, and
  objective results in **Investigate**;
- open **Runs** to star a reference, compare exact modeled deltas, inspect the
  compatible trend, and verify or export a retained replay; use **Compare** for
  architecture alternatives and **Report** for the current run evidence.

The same validated inputs, engine version, seed, and action schedule reproduce
the same modeled result. This is deterministic model evidence, not a production
benchmark or captured service telemetry.

Run the repository gate with:

```sh
pnpm quality
```

If a saved browser draft is rejected after a schema change, SystemForge fails
closed to the example workspace. To reset manually without clearing unrelated
site data, remove only `systemforge:draft` from local storage and
`systemforge:interviewer-draft` plus `systemforge:session` from session storage,
then reload `/lab`. A previously warmed production build can reload the local
Lab while offline; server runs, collaboration, reveal synchronization, and
short-link creation remain unavailable until the online service recovers.

For a hard presenter reset, run this app-scoped command in the browser console:

```js
localStorage.removeItem("systemforge:draft");
localStorage.removeItem("systemforge:architecture-snapshots");
localStorage.removeItem("systemforge:density");
indexedDB.deleteDatabase("systemforge-run-history");
sessionStorage.removeItem("systemforge:interviewer-draft");
sessionStorage.removeItem("systemforge:session");
location.replace("/lab");
```

## Production status

A prior owner authorization from 2026-08-08 is historical evidence only; it does
not authorize this working tree or a future revision. Pushing `main` does not
stage or deploy SystemForge. Production mutation requires a manual deployment
dispatch that identifies the exact successful `main` CI run and SHA, carries an
exact typed confirmation, and passes protected-environment approval before any
host secret is available. The release gate cannot bypass quality, backup,
restore, in-network, or Cloudflare smoke checks. The current public state should
be checked through `https://systemforge.elfeel.me/api/health/ready`, not inferred
from a local checkout. The procedure is documented in
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
