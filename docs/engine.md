# Simulation and architecture solver

SystemForge has two related engine surfaces. The simulation engine evaluates one
validated scenario and architecture. The architecture solver evaluates a
bounded set of explicit design mutations against the same simulation contract,
then ranks the eligible alternatives without hiding their trade-offs.

Neither surface deploys infrastructure or executes application code. Results
are modeled evidence for design work, not production benchmark guarantees.

## Simulation engine 0.3.0

`packages/sim-core/src/simulate.ts` advances the model in deterministic
one-second frames. The same package runs inside the browser Web Worker and the
canonical Node worker thread. A scenario seed, schema version, architecture,
workload, incident schedule, and requirement set fully determine the result for
an engine version.

The current contract models:

- 14 component kinds and directed synchronous or asynchronous edges;
- regional demand, request mixes, concurrent users, arrival patterns, payloads,
  client timeouts, retry limits, backoff, and jitter;
- compute, connections, memory pressure, network capacity, packet loss, cache
  behavior, storage and IOPS, replication, partitions, queues, delivery
  semantics, autoscaling, placement, failure domains, and operational cost;
- 35 incident kinds with target, region, zone, or failure-domain scope;
- 16 requirement metrics with public, hidden, and candidate-derived ownership;
- per-node resource snapshots, aggregate time series, causal events,
  requirement results, bottleneck analysis, strengths, risks, and trade-offs.

Every non-recovery incident has a behavioral regression test proving that it
changes modeled output rather than only adding an event label. Cache and
database recovery incidents have separate post-recovery assertions.

## Architecture solver 0.1.0

`packages/sim-core/src/solve.ts` adds a deterministic, bounded design search. It
does not label a single heuristic answer as universally optimal. It keeps the
baseline in the comparison, applies explicit mutations, evaluates each
candidate with the shared engine, computes a Pareto frontier, and may return no
recommendation when the baseline or hard constraints dominate the alternatives.

Supported mutation strategies are:

- horizontal scaling with modeled recurring cost;
- elastic scaling with startup, target-utilization, and cooldown behavior;
- circuit breaking, load shedding, bulkheads, retry bounds, backoff, and jitter;
- quorum replication and multi-zone state placement;
- storage repartitioning with explicit complexity consequences;
- cache efficiency and capacity changes;
- queue partition and consumer-parallelism changes.

Callers can lock components, allow only selected strategies, limit changes per
candidate, set monthly-cost and operational-complexity ceilings, and weight
requirement fit, resilience, latency, cost, and complexity. Candidate generation
is capped at 64 and additionally constrained by a work-unit budget before a
simulation worker is allocated.

Hidden interviewer requirements are excluded by default. The direct canonical
API always forces their exclusion, even if a client submits an inclusion flag.
The in-browser solver can include them only while the interviewer already holds
the private local scenario. This prevents a candidate-facing server call from
silently optimizing against a private rubric.

```ts
import { solveArchitecture } from "@systemforge/sim-core";

const comparison = solveArchitecture(scenario, architecture, {
  maxCandidates: 24,
  maxChangesPerCandidate: 2,
  lockedNodeIds: ["payment-provider"],
  maximumMonthlyCostEur: 140_000,
  weights: {
    requirements: 0.55,
    resilience: 0.25,
    cost: 0.2,
  },
});
```

Each candidate includes the changed architecture, explicit change descriptions,
requirement results, normalized decision metrics, baseline deltas, constraint
violations, modeled improvements, modeled regressions, a preference score, and
Pareto status. The preference score orders the supplied trade-off policy; it is
not a probability or a production-confidence value.

## Current limits

The model uses one-second aggregate frames rather than packet-, process-, or
protocol-level discrete events. Redis, PostgreSQL, Kafka, Raft, Paxos, and cloud
provider behavior are represented through configurable primitives rather than
vendor-accurate implementations. Cost is driven by authored component inputs
and egress settings, not a live provider catalogue.

The solver changes parameters and operating policies inside the authored
topology and does not prove a global optimum. A separate assistive layer can
propose three explicit, inspectable topology changes when their preconditions
are present: a bounded read cache, a durable queue-and-worker lane, or stronger
database replication. Applying a proposal creates a normal architecture
version that can be undone or restored; the assistant does not invent service
boundaries or silently mutate the graph.

The workbench also runs bounded deterministic robustness analysis across 2 to
64 derived seeds, subject to a separate work-unit budget. It reports complete
run and requirement pass rates plus minimum, median, p95, maximum, and mean
latency, availability, error, cost, and recovery metrics. This is sensitivity
analysis over modeled seeds, not a Monte Carlo confidence interval or evidence
about every production workload.

CSV and OpenTelemetry-like JSON traffic profiles can be imported with strict
sample, duration, and rate limits. The importer distills the observations into
the scenario's base rate, peak rate, duration, and an explicit peak incident;
it does not reproduce an exact trace or calibrate component behavior. Versioned
EUR provider-catalog snapshots can update a compatible component's modeled
monthly price, compute shape, egress price, and region. Catalogues are bounded,
validated user inputs rather than live vendor pricing or purchasing advice.
`examples/provider-catalog.example.json` documents the accepted snapshot shape.

These boundaries stay visible beside the output. SystemForge does not emulate
vendor implementations, infer arbitrary service boundaries, generate
statistical confidence intervals, or claim production capacity from modeled
evidence.

## Verification

The focused checks are:

```sh
pnpm exec vitest run packages/sim-core/tests/simulate.test.ts
pnpm exec vitest run packages/sim-core/tests/solve.test.ts
pnpm test:performance
pnpm --filter @systemforge/sim-core typecheck
```

The repository-wide `pnpm quality` command adds formatting, linting, all
behavioral tests, all workspace builds, and the static-site packaging contract.

## Execution surfaces

The browser-local solver is implemented in
`apps/web/src/workers/solver.worker.ts`, admitted by
`apps/web/src/lib/localSolver.ts`, and remains usable without the API. The
canonical transport is `POST /api/solve`; Fastify admits only a small bounded
request, then `apps/api/src/runSolverInThread.ts` executes the search in a
disposable Node worker with an independent concurrency lane, timeout, work
budget, candidate cap, and serialized-result ceiling. The browser gateway in
`apps/web/src/lib/solverGateway.ts` falls back to that local worker when the
canonical service is closed, busy, or unavailable.

The Lab mounts the complete decision workbench behind **Compare** and the
command palette. It includes policy controls, candidate and Pareto comparison,
reversible application, named architecture versions, mission loading, traffic
and provider imports, topology proposals, robustness analysis, session tools,
and privacy-scoped evidence export. Candidate rows expose exact deltas,
constraint violations, improvements, regressions, and the policy responsible
for the ordering; the UI never converts that ordering into a confidence claim.
