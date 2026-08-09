import { INCIDENT_KINDS, type Incident } from "@systemforge/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_ARCHITECTURE, DEFAULT_SCENARIO, simulate } from "../src/index";

const maximum = (values: number[]): number => Math.max(...values);

type NonRecoveryIncident = Exclude<
  Incident["kind"],
  "cache-recovery" | "database-recovery"
>;

const incidentTargets: Record<
  NonRecoveryIncident,
  { targetId?: string; magnitude: number; region?: string; zone?: string }
> = {
  "traffic-spike": { magnitude: 4 },
  "bot-attack": { magnitude: 4 },
  ddos: { magnitude: 4 },
  "thundering-herd": { magnitude: 4 },
  "large-payload": { magnitude: 8 },
  "cache-failure": { targetId: "cache", magnitude: 1 },
  "cache-eviction-storm": { targetId: "cache", magnitude: 8 },
  "cache-stampede": { targetId: "cache", magnitude: 1 },
  "hot-key": { targetId: "cache", magnitude: 8 },
  "database-degradation": { targetId: "db", magnitude: 5 },
  "database-lock-contention": { targetId: "db", magnitude: 8 },
  "disk-saturation": { targetId: "db", magnitude: 6 },
  "hot-shard": { targetId: "db", magnitude: 6 },
  "replication-lag": { targetId: "db", magnitude: 8 },
  "leader-election": { targetId: "db", magnitude: 1 },
  "queue-consumer-slowdown": { targetId: "worker", magnitude: 6 },
  "poison-message": { targetId: "queue", magnitude: 4 },
  "partition-imbalance": { targetId: "queue", magnitude: 20 },
  "node-failure": { targetId: "api", magnitude: 1 },
  "zone-outage": { targetId: "api", magnitude: 1, zone: "multi-az" },
  "region-outage": { targetId: "api", magnitude: 1, region: "EU" },
  "network-partition": { targetId: "api", magnitude: 1 },
  "packet-loss": { targetId: "api", magnitude: 40 },
  "slow-network": { targetId: "api", magnitude: 8 },
  "dns-failure": { targetId: "dns", magnitude: 1 },
  "certificate-expiry": { targetId: "cdn", magnitude: 1 },
  "gc-pause": { targetId: "api", magnitude: 8 },
  "memory-leak": { targetId: "api", magnitude: 100 },
  "deployment-regression": { targetId: "api", magnitude: 6 },
  "bad-autoscaling": { targetId: "api", magnitude: 1 },
  "retry-storm": { magnitude: 4 },
  "third-party-slowdown": { targetId: "third-party", magnitude: 8 },
  "third-party-outage": { targetId: "third-party", magnitude: 1 },
};

const incidentAuditArchitecture = () => {
  const architecture = structuredClone(DEFAULT_ARCHITECTURE);
  const api = architecture.nodes.find((node) => node.id === "api")!;
  architecture.nodes.push(
    {
      ...structuredClone(api),
      id: "dns",
      kind: "dns",
      name: "Authoritative DNS",
      position: { x: 100, y: 80 },
      config: {
        ...structuredClone(api.config),
        instances: 2,
        maxInstances: 2,
        autoscale: false,
        capacityRps: 50_000,
        behavior: {
          ...structuredClone(api.config.behavior),
          scaling: undefined,
        },
      },
    },
    {
      ...structuredClone(api),
      id: "third-party",
      kind: "third-party",
      name: "Payment provider",
      position: { x: 780, y: 180 },
      config: {
        ...structuredClone(api.config),
        instances: 2,
        maxInstances: 2,
        autoscale: false,
        capacityRps: 12_000,
        behavior: {
          ...structuredClone(api.config.behavior),
          scaling: undefined,
        },
      },
    },
  );
  architecture.edges = [
    ...architecture.edges.filter((edge) => edge.id !== "e-users-cdn"),
    { id: "e-users-dns", source: "users", target: "dns" },
    { id: "e-dns-cdn", source: "dns", target: "cdn" },
    { id: "e-api-third-party", source: "api", target: "third-party" },
  ];
  return architecture;
};

const behavioralSignature = (result: ReturnType<typeof simulate>) =>
  result.frames.map((frame) => ({
    rps: frame.rps,
    errorRate: frame.errorRate,
    p95LatencyMs: frame.p95LatencyMs,
    retryAmplification: frame.retryAmplification,
    queueDepth: frame.queueDepth,
    replicaLagMs: frame.replicaLagMs,
    recoveryTimeSeconds: frame.recoveryTimeSeconds,
    nodes: Object.fromEntries(
      Object.entries(frame.nodeMetrics).map(([id, metric]) => [
        id,
        [
          metric.state,
          metric.latencyMs,
          metric.errorRate,
          metric.utilization,
          metric.memoryUtilization,
          metric.activeInstances,
        ],
      ]),
    ),
  }));

describe("deterministic behavioral simulation", () => {
  it("ships the checkout scenario with bounded topology traces", () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const withoutTraces = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
      includeTraces: false,
    });

    expect(result.traces).toBeDefined();
    expect(result.inputFingerprint).toMatch(/^sf-input-v2:[0-9a-f]{16}$/);
    expect(result.traces).not.toHaveLength(0);
    expect(result.traces!.length).toBeLessThanOrEqual(16);
    expect(
      result.traces!.some((trace) =>
        trace.spans.some(
          (span) =>
            span.kind === "edge" &&
            span.sourceNodeId === "users" &&
            span.targetNodeId === "cdn",
        ),
      ),
    ).toBe(true);
    expect(withoutTraces.traces).toBeUndefined();
    const resultWithoutTraceEvidence = structuredClone(result);
    delete resultWithoutTraceEvidence.traces;
    expect(resultWithoutTraceEvidence).toEqual(withoutTraces);
  });

  it("gives every supported incident a measurable behavioral consequence", () => {
    expect(
      [
        ...Object.keys(incidentTargets),
        "cache-recovery",
        "database-recovery",
      ].sort(),
    ).toEqual([...INCIDENT_KINDS].sort());

    const architecture = incidentAuditArchitecture();
    const baselineScenario = structuredClone(DEFAULT_SCENARIO);
    baselineScenario.workload.baseRps = 30_000;
    baselineScenario.workload.peakRps = 30_000;
    baselineScenario.workload.arrivalPattern = "steady";
    baselineScenario.workload.durationSeconds = 50;
    baselineScenario.incidents = [];
    const baseline = behavioralSignature(
      simulate(baselineScenario, architecture),
    );

    for (const [kind, target] of Object.entries(incidentTargets) as Array<
      [NonRecoveryIncident, (typeof incidentTargets)[NonRecoveryIncident]]
    >) {
      const scenario = structuredClone(baselineScenario);
      scenario.incidents = [
        {
          id: `audit-${kind}`,
          atSecond: 8,
          kind,
          magnitude: target.magnitude,
          durationSeconds: 30,
          label: `Audit ${kind}`,
          ...(target.targetId ? { targetId: target.targetId } : {}),
          ...(target.region ? { region: target.region } : {}),
          ...(target.zone ? { zone: target.zone } : {}),
        },
      ];
      expect(
        behavioralSignature(simulate(scenario, architecture)),
        `${kind} only emitted a label and did not change modeled behavior`,
      ).not.toEqual(baseline);
    }

    for (const [failure, recovery, targetId] of [
      ["cache-failure", "cache-recovery", "cache"],
      ["database-degradation", "database-recovery", "db"],
    ] as const) {
      const failed = structuredClone(baselineScenario);
      failed.incidents = [
        {
          id: failure,
          atSecond: 5,
          kind: failure,
          magnitude: failure === "cache-failure" ? 1 : 5,
          durationSeconds: 40,
          targetId,
          label: failure,
        },
      ];
      const recovered = structuredClone(failed);
      recovered.incidents.push({
        id: recovery,
        atSecond: 20,
        kind: recovery,
        magnitude: 1,
        targetId,
        label: recovery,
      });
      expect(
        behavioralSignature(simulate(recovered, architecture)).slice(20),
        `${recovery} did not change the post-recovery behavior`,
      ).not.toEqual(
        behavioralSignature(simulate(failed, architecture)).slice(20),
      );
    }
  });
  it("produces identical results for the same seed and inputs", () => {
    expect(simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE)).toEqual(
      simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE),
    );
  });

  it("expires finite cache and database toggle incidents without a recovery event", () => {
    const cacheScenario = structuredClone(DEFAULT_SCENARIO);
    cacheScenario.workload.durationSeconds = 15;
    cacheScenario.workload.baseRps = 1_000;
    cacheScenario.workload.peakRps = 1_000;
    cacheScenario.workload.arrivalPattern = "steady";
    cacheScenario.incidents = [
      {
        id: "finite-cache-failure",
        atSecond: 1,
        kind: "cache-failure",
        magnitude: 1,
        durationSeconds: 2,
        targetId: "cache",
        label: "Finite cache failure",
      },
    ];
    const cacheResult = simulate(cacheScenario, DEFAULT_ARCHITECTURE);
    expect(cacheResult.frames[1]!.nodeMetrics.cache!.state).toBe("offline");
    expect(cacheResult.frames[2]!.nodeMetrics.cache!.state).toBe("offline");
    expect(cacheResult.frames[3]!.nodeMetrics.cache!.state).not.toBe("offline");

    const databaseScenario = structuredClone(cacheScenario);
    databaseScenario.incidents = [
      {
        id: "finite-database-degradation",
        atSecond: 1,
        kind: "database-degradation",
        magnitude: 5,
        durationSeconds: 2,
        targetId: "db",
        label: "Finite database degradation",
      },
    ];
    const databaseResult = simulate(databaseScenario, DEFAULT_ARCHITECTURE);
    expect(
      databaseResult.frames[2]!.nodeMetrics.db!.cpuUtilization,
    ).toBeGreaterThan(databaseResult.frames[3]!.nodeMetrics.db!.cpuUtilization);
  });

  it("uses finite failover timing for leader election and effective replica lag", () => {
    const electionScenario = structuredClone(DEFAULT_SCENARIO);
    electionScenario.workload.durationSeconds = 15;
    electionScenario.workload.baseRps = 1_000;
    electionScenario.workload.peakRps = 1_000;
    electionScenario.workload.arrivalPattern = "steady";
    electionScenario.incidents = [
      {
        id: "queue-election",
        atSecond: 1,
        durationSeconds: 5,
        kind: "leader-election",
        magnitude: 1,
        targetId: "queue",
        label: "Queue leader election",
      },
    ];
    const fast = structuredClone(DEFAULT_ARCHITECTURE);
    const fastQueue = fast.nodes.find((node) => node.id === "queue")!;
    fastQueue.config.behavior!.storage = {
      ...fastQueue.config.behavior?.storage,
      failoverSeconds: 1,
    };
    const slow = structuredClone(fast);
    const slowQueue = slow.nodes.find((node) => node.id === "queue")!;
    slowQueue.config.behavior!.storage = {
      ...slowQueue.config.behavior?.storage,
      failoverSeconds: 100,
    };

    const fastElection = simulate(electionScenario, fast);
    const slowElection = simulate(electionScenario, slow);
    expect(fastElection.frames[2]!.nodeMetrics.queue!.state).not.toBe(
      "offline",
    );
    expect(slowElection.frames[2]!.nodeMetrics.queue!.state).toBe("offline");
    expect(fastElection.frames[1]!.recoveryTimeSeconds).toBe(1);
    expect(slowElection.frames[1]!.recoveryTimeSeconds).toBe(5);

    const lagScenario = structuredClone(electionScenario);
    lagScenario.domain = {
      ...lagScenario.domain,
      staleReadToleranceSeconds: 0.002,
    };
    lagScenario.incidents = [
      {
        id: "lag-spike",
        atSecond: 1,
        durationSeconds: 3,
        kind: "replication-lag",
        magnitude: 100,
        targetId: "db",
        label: "Replica lag spike",
      },
    ];
    const lagged = structuredClone(DEFAULT_ARCHITECTURE);
    const laggedDb = lagged.nodes.find((node) => node.id === "db")!;
    laggedDb.config.consistency = "eventual";
    laggedDb.config.replicas = 1;
    laggedDb.config.behavior!.storage = {
      ...laggedDb.config.behavior?.storage,
      replicationMode: "async",
      replicationLagMs: 1,
    };
    const laggedResult = simulate(lagScenario, lagged);
    expect(laggedResult.frames[1]!.nodeMetrics.db!.replicaLagMs).toBe(100);
    expect(laggedResult.frames[1]!.consistencyViolations).toBeGreaterThan(0);

    laggedDb.config.replicas = 0;
    laggedDb.config.behavior!.storage = {
      ...laggedDb.config.behavior?.storage,
      replicationMode: "none",
    };
    const unreplicated = simulate(lagScenario, lagged);
    expect(unreplicated.frames[1]!.nodeMetrics.db!.replicaLagMs).toBe(0);
  });

  it("limits state semantics in analysis to components that own state", () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const analysis = [
      ...result.analysis.strengths,
      ...result.analysis.risks,
      ...result.analysis.tradeoffs,
    ].join("\n");

    for (const statelessName of [
      "Users",
      "CDN",
      "Load Balancer",
      "API Gateway",
      "Worker Pool",
    ]) {
      expect(analysis).not.toContain(`${statelessName} favors consistency`);
      expect(analysis).not.toContain(`${statelessName} lowers coordination`);
      expect(analysis).not.toContain(`${statelessName} buys failure tolerance`);
      expect(analysis).not.toContain(
        `${statelessName} remains a single failure domain`,
      );
    }

    expect(analysis).toContain(
      "PostgreSQL Primary avoids modeled stale-read violations",
    );
    expect(analysis).not.toContain("Redis Cluster avoids modeled stale-read");
    expect(analysis).toContain("Kafka Orders adds modeled failure tolerance");
    expect(analysis).not.toContain("Kafka Orders may violate the stale-read");
  });

  it("keeps replica lag local to applicable state-owning components", () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const frame = result.frames[0]!;

    expect(frame.nodeMetrics.db!.replicaLagMs).toBeGreaterThan(0);
    expect(frame.nodeMetrics.queue!.replicaLagMs).toBe(0);
    expect(frame.nodeMetrics.worker!.replicaLagMs).toBe(0);
    expect(frame.replicaLagMs).toBe(frame.nodeMetrics.db!.replicaLagMs);
  });

  it("treats legacy replicas on stateless services as inert", () => {
    const scenario = structuredClone(DEFAULT_SCENARIO);
    scenario.workload.durationSeconds = 15;
    scenario.incidents = [
      {
        id: "api-node-failure",
        atSecond: 1,
        durationSeconds: 10,
        kind: "node-failure",
        magnitude: 1,
        targetId: "api",
        label: "API node failure",
      },
    ];
    const withoutReplicas = structuredClone(DEFAULT_ARCHITECTURE);
    withoutReplicas.nodes.find((node) => node.id === "api")!.config.replicas =
      0;
    const withLegacyReplicas = structuredClone(withoutReplicas);
    withLegacyReplicas.nodes.find(
      (node) => node.id === "api",
    )!.config.replicas = 5;

    const legacyResult = simulate(scenario, withLegacyReplicas);
    const baselineResult = simulate(scenario, withoutReplicas);
    expect({ ...legacyResult, inputFingerprint: undefined }).toEqual({
      ...baselineResult,
      inputFingerprint: undefined,
    });
  });

  it("derives a causal cache, database and retry chain instead of scripting the outcome", () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const cacheFailure = result.events.find(
      (event) => event.kind === "cache-miss-collapse",
    );
    const databaseOverload = result.events.find(
      (event) => event.kind === "cache-cascade" && event.entityId === "db",
    );
    const retryStorm = result.events.find(
      (event) => event.kind === "retry-storm",
    );

    expect(cacheFailure).toBeDefined();
    expect(databaseOverload?.parentIds).toContain(cacheFailure?.id);
    expect(retryStorm).toBeDefined();
    expect(result.frames.some((frame) => frame.retryAmplification > 1)).toBe(
      true,
    );
    expect(result.analysis.bottleneckNodeId).toBeTruthy();
    expect(result.analysis.tradeoffs.length).toBeGreaterThan(0);
  });

  it("tracks independent resource dimensions and delayed autoscaling", () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const apiFrames = result.frames.map((frame) => frame.nodeMetrics.api);

    expect(apiFrames.every(Boolean)).toBe(true);
    expect(
      maximum(apiFrames.map((metric) => metric?.activeInstances ?? 0)),
    ).toBeGreaterThan(24);
    expect(
      maximum(apiFrames.map((metric) => metric?.cpuUtilization ?? 0)),
    ).toBeGreaterThan(0);
    expect(
      maximum(apiFrames.map((metric) => metric?.networkUtilization ?? 0)),
    ).toBeGreaterThan(0);
    expect(
      result.events.some((event) => event.kind === "autoscale-requested"),
    ).toBe(true);
  });

  it("lets resilience controls reduce retry amplification during a DDoS", () => {
    const scenario = structuredClone(DEFAULT_SCENARIO);
    scenario.incidents = [
      {
        id: "ddos",
        atSecond: 12,
        kind: "ddos",
        magnitude: 4,
        durationSeconds: 35,
        label: "Edge flood",
      },
    ];
    const protectedResult = simulate(scenario, DEFAULT_ARCHITECTURE);
    const unprotected = structuredClone(DEFAULT_ARCHITECTURE);
    for (const node of unprotected.nodes) {
      if (
        node.kind === "cdn" ||
        node.kind === "load-balancer" ||
        node.kind === "api"
      ) {
        node.config.behavior = {
          ...node.config.behavior,
          resilience: {
            ...node.config.behavior?.resilience,
            circuitBreaker: false,
            loadSheddingThreshold: undefined,
          },
        };
      }
    }
    const unprotectedResult = simulate(scenario, unprotected);

    expect(
      maximum(protectedResult.frames.map((frame) => frame.retryAmplification)),
    ).toBeLessThan(
      maximum(
        unprotectedResult.frames.map((frame) => frame.retryAmplification),
      ),
    );
    expect(protectedResult.events.some((event) => event.kind === "ddos")).toBe(
      true,
    );
  });

  it("makes replication strategy change acknowledged-write durability", () => {
    const scenario = structuredClone(DEFAULT_SCENARIO);
    scenario.incidents = [
      {
        id: "db-node-loss",
        atSecond: 20,
        kind: "node-failure",
        targetId: "db",
        magnitude: 1,
        durationSeconds: 18,
        label: "Primary unavailable",
      },
    ];
    const durableResult = simulate(scenario, DEFAULT_ARCHITECTURE);
    const fragile = structuredClone(DEFAULT_ARCHITECTURE);
    const database = fragile.nodes.find((node) => node.id === "db")!;
    database.config.replicas = 0;
    database.config.behavior = {
      ...database.config.behavior,
      storage: {
        ...database.config.behavior?.storage,
        replicationMode: "none",
      },
    };
    const fragileResult = simulate(scenario, fragile);

    expect(
      fragileResult.frames.reduce((total, frame) => total + frame.dataLoss, 0),
    ).toBeGreaterThan(0);
    expect(
      Math.min(...durableResult.frames.map((frame) => frame.durabilityPercent)),
    ).toBeGreaterThan(
      Math.min(...fragileResult.frames.map((frame) => frame.durabilityPercent)),
    );
  });

  it("evaluates data-residency and asynchronous-backlog consequences", () => {
    const architecture = structuredClone(DEFAULT_ARCHITECTURE);
    const database = architecture.nodes.find((node) => node.id === "db")!;
    database.config.behavior = {
      ...database.config.behavior,
      topology: {
        ...database.config.behavior?.topology,
        dataResidency: "US",
      },
    };
    const result = simulate(DEFAULT_SCENARIO, architecture);

    expect(result.frames.some((frame) => frame.residencyViolations > 0)).toBe(
      true,
    );
    expect(
      maximum(result.frames.map((frame) => frame.maxQueueAgeMs)),
    ).toBeGreaterThan(0);
    expect(result.events.some((event) => event.kind === "queue-backlog")).toBe(
      true,
    );
  });

  it("does not mutate caller-owned inputs", () => {
    const architectureBefore = structuredClone(DEFAULT_ARCHITECTURE);
    const scenarioBefore = structuredClone(DEFAULT_SCENARIO);
    simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    expect(DEFAULT_ARCHITECTURE).toEqual(architectureBefore);
    expect(DEFAULT_SCENARIO).toEqual(scenarioBefore);
  });

  it("models peak traffic, concurrent sessions and client timeout policy", () => {
    const steady = structuredClone(DEFAULT_SCENARIO);
    steady.incidents = [];
    steady.workload.baseRps = 1_000;
    steady.workload.peakRps = 20_000;
    steady.workload.durationSeconds = 60;
    steady.workload.arrivalPattern = "steady";
    steady.workload.concurrentUsers = 10;
    steady.workload.clientTimeoutMs = 120_000;
    const bursty = structuredClone(steady);
    bursty.workload.arrivalPattern = "bursty";
    bursty.workload.concurrentUsers = 1_000_000;
    bursty.workload.clientTimeoutMs = 50;

    const steadyResult = simulate(steady, DEFAULT_ARCHITECTURE);
    const burstyResult = simulate(bursty, DEFAULT_ARCHITECTURE);

    expect(
      maximum(burstyResult.frames.map((frame) => frame.rps)),
    ).toBeGreaterThan(
      maximum(steadyResult.frames.map((frame) => frame.rps)) * 8,
    );
    expect(
      maximum(
        burstyResult.frames.map(
          (frame) => frame.nodeMetrics.api?.connectionUtilization ?? 0,
        ),
      ),
    ).toBeGreaterThan(
      maximum(
        steadyResult.frames.map(
          (frame) => frame.nodeMetrics.api?.connectionUtilization ?? 0,
        ),
      ),
    );
    expect(
      maximum(burstyResult.frames.map((frame) => frame.errorRate)),
    ).toBeGreaterThan(
      maximum(steadyResult.frames.map((frame) => frame.errorRate)),
    );
  });

  it("makes cache and storage policy change durable-store pressure", () => {
    const scenario = structuredClone(DEFAULT_SCENARIO);
    scenario.incidents = [];
    scenario.workload.baseRps = 25_000;
    scenario.workload.peakRps = 25_000;
    scenario.workload.arrivalPattern = "steady";
    scenario.workload.durationSeconds = 45;
    const protectedArchitecture = structuredClone(DEFAULT_ARCHITECTURE);
    const protectedCache = protectedArchitecture.nodes.find(
      (node) => node.id === "cache",
    )!;
    protectedCache.config.behavior!.cache = {
      capacityGb: 1_000,
      ttlSeconds: 300,
      evictionPolicy: "lfu",
      hotKeyFraction: 0,
    };
    const protectedDatabase = protectedArchitecture.nodes.find(
      (node) => node.id === "db",
    )!;
    protectedDatabase.config.behavior!.storage = {
      ...protectedDatabase.config.behavior!.storage,
      bufferHitRate: 0.99,
      diskThroughputMbps: 1_000_000,
    };
    const constrainedArchitecture = structuredClone(protectedArchitecture);
    const constrainedCache = constrainedArchitecture.nodes.find(
      (node) => node.id === "cache",
    )!;
    constrainedCache.config.behavior!.cache = {
      capacityGb: 0.1,
      ttlSeconds: 300,
      evictionPolicy: "random",
      hotKeyFraction: 0.75,
    };
    const constrainedDatabase = constrainedArchitecture.nodes.find(
      (node) => node.id === "db",
    )!;
    constrainedDatabase.config.behavior!.storage = {
      ...constrainedDatabase.config.behavior!.storage,
      bufferHitRate: 0,
      diskThroughputMbps: 10,
    };

    const protectedResult = simulate(scenario, protectedArchitecture);
    const constrainedResult = simulate(scenario, constrainedArchitecture);
    const maxDatabaseIops = (result: ReturnType<typeof simulate>) =>
      maximum(
        result.frames.map(
          (frame) => frame.nodeMetrics.db?.iopsUtilization ?? 0,
        ),
      );

    expect(maxDatabaseIops(constrainedResult)).toBeGreaterThan(
      maxDatabaseIops(protectedResult),
    );
    expect(
      maximum(constrainedResult.frames.map((frame) => frame.p95LatencyMs)),
    ).toBeGreaterThan(
      maximum(protectedResult.frames.map((frame) => frame.p95LatencyMs)),
    );
  });

  it("models messaging parallelism, batching, retention and delivery semantics", () => {
    const scenario = structuredClone(DEFAULT_SCENARIO);
    scenario.incidents = [];
    scenario.workload.baseRps = 20_000;
    scenario.workload.peakRps = 20_000;
    scenario.workload.arrivalPattern = "steady";
    scenario.workload.durationSeconds = 45;
    const constrained = structuredClone(DEFAULT_ARCHITECTURE);
    const constrainedWorker = constrained.nodes.find(
      (node) => node.id === "worker",
    )!;
    constrainedWorker.config.instances = 16;
    constrainedWorker.config.maxInstances = 16;
    constrainedWorker.config.autoscale = false;
    constrainedWorker.config.capacityRps = 500;
    const constrainedQueue = constrained.nodes.find(
      (node) => node.id === "queue",
    )!;
    constrainedQueue.config.behavior!.messaging = {
      partitions: 1,
      delivery: "at-least-once",
      retentionHours: 0,
      poisonMessageRate: 0.01,
      batchSize: 1,
    };
    const tuned = structuredClone(constrained);
    const tunedQueue = tuned.nodes.find((node) => node.id === "queue")!;
    tunedQueue.config.behavior!.messaging = {
      partitions: 32,
      delivery: "exactly-once",
      retentionHours: 24,
      poisonMessageRate: 0,
      batchSize: 200,
    };

    const constrainedResult = simulate(scenario, constrained);
    const tunedResult = simulate(scenario, tuned);

    expect(
      maximum(constrainedResult.frames.map((frame) => frame.queueDepth)),
    ).toBeGreaterThan(
      maximum(tunedResult.frames.map((frame) => frame.queueDepth)),
    );
    expect(
      constrainedResult.frames.reduce(
        (total, frame) => total + frame.dataLoss,
        0,
      ),
    ).toBeGreaterThan(
      tunedResult.frames.reduce((total, frame) => total + frame.dataLoss, 0),
    );
    expect(
      constrainedResult.frames.reduce(
        (total, frame) => total + frame.consistencyViolations,
        0,
      ),
    ).toBeGreaterThan(0);
  });

  it("applies edge transport, asynchronous boundaries and runtime policies", () => {
    const scenario = structuredClone(DEFAULT_SCENARIO);
    scenario.incidents = [];
    scenario.workload.baseRps = 35_000;
    scenario.workload.peakRps = 35_000;
    scenario.workload.arrivalPattern = "steady";
    scenario.workload.durationSeconds = 45;
    const healthy = structuredClone(DEFAULT_ARCHITECTURE);
    const degraded = structuredClone(DEFAULT_ARCHITECTURE);
    const apiEdge = degraded.edges.find((edge) => edge.id === "e-lb-api")!;
    apiEdge.config = {
      bandwidthMbps: 5,
      baseLatencyMs: 600,
      jitterMs: 100,
      packetLossRate: 0.2,
      trafficShare: 1,
    };
    const degradedApi = degraded.nodes.find((node) => node.id === "api")!;
    degradedApi.config.behavior!.compute = {
      ...degradedApi.config.behavior!.compute,
      gcPauseMs: 900,
      gcIntervalSeconds: 5,
      memoryGb: 0.5,
      memoryLeakMbPerMinute: 20_000,
    };
    degradedApi.config.behavior!.resilience = {
      ...degradedApi.config.behavior!.resilience,
      timeoutMs: 100,
      bulkhead: false,
    };

    const healthyResult = simulate(scenario, healthy);
    const degradedResult = simulate(scenario, degraded);

    expect(
      maximum(
        degradedResult.frames.map(
          (frame) => frame.nodeMetrics.api?.networkUtilization ?? 0,
        ),
      ),
    ).toBeGreaterThan(
      maximum(
        healthyResult.frames.map(
          (frame) => frame.nodeMetrics.api?.networkUtilization ?? 0,
        ),
      ),
    );
    expect(
      maximum(degradedResult.frames.map((frame) => frame.p95LatencyMs)),
    ).toBeGreaterThan(
      maximum(healthyResult.frames.map((frame) => frame.p95LatencyMs)),
    );
    expect(
      maximum(
        degradedResult.frames.map(
          (frame) => frame.nodeMetrics.api?.memoryUtilization ?? 0,
        ),
      ),
    ).toBeGreaterThan(1);

    const asynchronous = structuredClone(degraded);
    asynchronous.edges.find((edge) => edge.id === "e-api-db")!.config = {
      asynchronous: true,
      baseLatencyMs: 3_000,
    };
    asynchronous.edges.find((edge) => edge.id === "e-worker-db")!.config = {
      asynchronous: true,
      baseLatencyMs: 3_000,
    };
    const synchronous = structuredClone(asynchronous);
    for (const edge of synchronous.edges.filter((edge) => edge.target === "db"))
      edge.config = { ...edge.config, asynchronous: false };
    const synchronousResult = simulate(scenario, synchronous);
    const asynchronousResult = simulate(scenario, asynchronous);
    expect(
      maximum(asynchronousResult.frames.map((frame) => frame.p95LatencyMs)),
    ).toBeLessThan(
      maximum(synchronousResult.frames.map((frame) => frame.p95LatencyMs)),
    );
  });

  it("uses placement and domain invariants in failure outcomes and analysis", () => {
    const scenario = structuredClone(DEFAULT_SCENARIO);
    scenario.incidents = [
      {
        id: "zone-loss",
        atSecond: 5,
        kind: "zone-outage",
        magnitude: 1,
        durationSeconds: 20,
        zone: "multi-az",
        label: "Availability zone unavailable",
      },
    ];
    scenario.workload.durationSeconds = 30;
    const resilient = structuredClone(DEFAULT_ARCHITECTURE);
    const singleZone = structuredClone(DEFAULT_ARCHITECTURE);
    const database = singleZone.nodes.find((node) => node.id === "db")!;
    database.config.behavior!.topology = {
      ...database.config.behavior!.topology,
      zone: "eu-1a",
    };
    database.config.replicas = 0;
    database.config.behavior!.storage = {
      ...database.config.behavior!.storage,
      replicationMode: "none",
      failoverSeconds: 300,
    };

    const singleZoneScenario = structuredClone(scenario);
    singleZoneScenario.incidents[0]!.zone = "eu-1a";
    const resilientResult = simulate(scenario, resilient);
    const singleZoneResult = simulate(singleZoneScenario, singleZone);

    expect(
      singleZoneResult.frames.reduce(
        (total, frame) => total + frame.dataLoss,
        0,
      ),
    ).toBeGreaterThan(
      resilientResult.frames.reduce(
        (total, frame) => total + frame.dataLoss,
        0,
      ),
    );
    expect(
      singleZoneResult.analysis.risks.some((risk) =>
        risk.includes("acknowledged-write invariant"),
      ),
    ).toBe(true);
    expect(
      singleZoneResult.analysis.strengths.some((strength) =>
        strength.includes("within the 60s domain limit"),
      ),
    ).toBe(true);
  });
});
