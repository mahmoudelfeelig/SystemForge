# Simulation and architecture solver

SystemForge has two related engine surfaces. The simulation engine evaluates one
validated scenario and architecture. The architecture solver evaluates a
bounded set of explicit design mutations against the same simulation contract,
then ranks the eligible alternatives without hiding their trade-offs.

Neither surface deploys infrastructure or executes application code. Results
are modeled evidence for design work, not production benchmark guarantees.

## Simulation engine 0.7.0

`packages/sim-core/src/simulate.ts` advances the model in deterministic
one-second frames. The same package runs inside the browser Web Worker and the
canonical Node worker thread. A scenario seed, schema version, architecture,
workload, incident schedule, bounded operator-action schedule, and requirement
set fully determine the result for an engine version.

The current contract models:

- 14 component kinds and directed synchronous or asynchronous edges;
- regional demand, request mixes, concurrent users, arrival patterns, payloads,
  client timeouts, retry limits, backoff, and jitter;
- independently executed request classes with optional entry nodes, ordered edge
  routes, and terminal constraints; unconstrained legacy mixes remain valid;
- compute, connections, memory pressure, network capacity, packet loss, cache
  behavior, storage and IOPS, replication, partitions, queues, delivery
  semantics, autoscaling, placement, failure domains, and operational cost;
- 35 incident kinds with target, region, zone, or failure-domain scope;
- an optional seeded incident model with at most 16 rules, 32 occurrences per
  rule, and 64 generated incidents per run; each rule bounds its per-second
  hazard, cooldown, magnitude, duration, compatible placement scope, and an
  optional previous-frame trigger;
- 16 requirement metrics with public, hidden, and candidate-derived ownership;
- per-node resource snapshots, per-edge attempted throughput, delivered
  throughput, retry work, packet loss, configured-path latency, and async state;
- aggregate time series, linked events, requirement results, bottleneck
  analysis, strengths, risks, and trade-offs;
- up to 16 deterministic representative traces for request classes with a
  reachable entry path, capped at 64 spans each, with executed edges, bounded retry chains,
  cache decisions, async message lineage, query class, modeled connection-pool
  wait, failure classification, terminal state, and parent-span evidence.

The browser session can pause playback and schedule up to 64 future actions:
node scaling, circuit-breaker or load-shedding policy changes, and injected
incidents. An accepted action is required to target a second after the delivered
cursor. The worker recomputes deterministically from second 0 with the complete
action log and rejects the action unless every already-delivered frame and event
remains byte-identical. Snapshot and fork controls capture validated inputs, the
full action schedule, cursor, and replay fingerprints; they restore by replaying
from second 0 rather than serializing opaque process, queue, autoscaling, or
retry internals. Completed-run manifest version 3 retains the full intervention
payloads, resolved per-node behavioral-profile evidence, and labels this
restoration boundary explicitly.

Every non-recovery incident has a behavioral regression test proving that it
changes modeled output rather than only adding an event label. Cache and
database recovery incidents have separate post-recovery assertions.

Seeded incidents use per-rule deterministic random streams derived from the
scenario seed and a fixed incident namespace. Workload random draws therefore
cannot reorder an incident rule. Non-correlated placement rules choose one
eligible reachable node deterministically; correlated region or failure-domain
rules apply the existing incident physics to every eligible matching node.
State triggers read only the prior completed frame and are limited to p95
latency, error rate, availability, queue depth, retry amplification, and
throughput. Every generated incident is retained with its complete replay
payload, rule occurrence, affected node identifiers, and observed trigger in
`SimulationResult.generatedIncidents`, and its event carries the same rule
provenance. Scripted and operator-injected incidents keep their established
semantics.

## Behavioral-profile registry

`packages/sim-core/src/behavioralProfiles.ts` is a bounded, versioned registry
of modeling defaults. A node may carry the optional
`config.behavioralProfile = { id, version }` reference. Architectures and shared
scenarios created before this field existed remain valid and run as unprofiled
nodes.

The initial registry contains ten version-1 entries:

| Technology | Baseline model                    | Provider variant                        |
| ---------- | --------------------------------- | --------------------------------------- |
| PostgreSQL | `postgresql.community-balanced`   | `aws.rds-postgresql.db-r7g-large`       |
| Redis      | `redis.community-balanced`        | `aws.elasticache-redis.cache-r7g-large` |
| Kafka      | `kafka.community-balanced`        | `aws.msk-provisioned.kafka-m5-large`    |
| RabbitMQ   | `rabbitmq.community-quorum`       | `aws.amazon-mq-rabbitmq.mq-m5-large`    |
| DynamoDB   | `dynamodb.logical-table-balanced` | `aws.dynamodb.standard-on-demand`       |

These are executable compositions of the existing compute, network, cache,
storage, messaging, resilience, scaling, consistency, instance, connection,
replica, and operations primitives. They are not labels layered over unchanged
nodes. `applyBehavioralProfile` merges the selected profile's controlled
primitive fields into a compatible node, preserves unrelated authored
placement fields, validates the resulting node contract, and writes the exact
ID and version reference.

State semantics are capability-gated without narrowing the architecture
schema. Database nodes expose the modeled read-consistency invariant. Cache,
database, object-store, queue, and stream nodes expose retained-state
replication; queue and stream nodes additionally expose messaging delivery and
durable-log capacity. Stateless nodes use instances and autoscaling for service
redundancy, so the Inspector and generated analysis do not describe them with
stale-read, consistency, or retained-state replication claims. Older
architectures that happen to carry those generic config fields still parse and
run unchanged.

`instances` are capacity-bearing running units. For state-owning components,
`replicas` are the minimum retained-state copies beyond the primary; modeled
billable units are therefore the greater of active instances and
`replicas + 1`.

Before a frame is evaluated, the engine resolves every reference. Unknown IDs,
unsupported versions, and incompatible node kinds fail the run. Manual changes
to fields controlled by the selected profile remain allowed, but the engine
compares those leaf fields against the registry version and records their paths
as local overrides. Unrelated fields that the profile does not own, such as an
authored region, are not mislabeled as overrides.

`SimulationResult.behavioralProfiles` contains one discriminated evidence entry
for every architecture node. Unprofiled nodes are explicit. Resolved entries
retain node kind, profile ID and version, label, assumptions, dated provenance,
the local-override flag, and overridden field paths. Completed-run manifest
version 3 copies and validates this full evidence array against the architecture
before export, so a stale or forged result cannot silently claim a different
profile. Replay digests therefore bind profile references, applied primitive
configuration, and profile evidence.

Provider names and shapes are grounded in primary vendor documentation. All
throughput, latency, storage, recovery, and aggregate scaling values not stated
by those sources remain visibly labeled SystemForge assumptions. The registry
contains no live pricing, provider quota, benchmark, SLA, or purchasing advice.

- [RDS supported DB engines and instance classes](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.DBInstanceClass.Support.html)
- [ElastiCache supported node types](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/CacheNodes.SupportedTypes.html)
- [Amazon MSK broker types](https://docs.aws.amazon.com/msk/latest/developerguide/broker-instance-types.html)
- [Amazon MQ RabbitMQ broker instance types](https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rmq-broker-instance-types.html)
- [DynamoDB on-demand capacity mode](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode.html)
- [DynamoDB table classes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.TableClasses.html)

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
protocol-level discrete events. Per-edge metrics are modeled path aggregates.
Optional sampled traces are deterministic explanations of those aggregates,
not captured production telemetry, distributed tracing, or individual request
replays. Their connection-pool wait is inferred from modeled connection pressure,
message identifiers represent deterministic queue lineage rather than broker
records, and each failed span exposes one prioritized modeled failure cause.
Batch solver and robustness evaluations disable this optional evidence pass;
interactive and canonical runs retain it for completed-run inspection and replay.
Redis, PostgreSQL, Kafka, RabbitMQ, DynamoDB, Raft, Paxos, and cloud provider
behavior are represented through configurable primitives and the versioned
registry rather than vendor-accurate implementations. Cost is driven by
authored component inputs and egress settings, not a live provider catalogue.

Queue depth and consumer capacity model bounded backlog growth, but backpressure
does not yet propagate upstream through every request class or model scheduler
fairness between classes. Region, zone, and failure-domain incidents use
authored placement labels and coarse capacity/failover multipliers. A correlated
seeded rule applies those same coarse effects to matching modeled nodes; it does
not simulate host-level dependency graphs, quorum protocols, provider-specific
correlation, or control-plane recovery.

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
pnpm exec vitest run packages/sim-core/tests/stochastic-incidents.test.ts
pnpm exec vitest run packages/sim-core/tests/behavioral-profiles.test.ts
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

Optional AI assistance is outside the engine boundary. It may propose a
scenario or requirement intent for normal schema validation, select exact facts
from a completed canonical run for a cited debrief, or draft a
candidate-visible interview question. It cannot invoke `simulate`, return a
`SimulationResult`, change an architecture, rank a candidate, or manufacture a
measurement. Applying a proposal creates ordinary validated deterministic input;
the engine version, seed, topology, action schedule, and profile evidence remain
the only sources of modeled output.
