import type {
  Architecture,
  ArchitectureNode,
  Scenario,
} from "@systemforge/contracts";
import { describe, expect, it } from "vitest";
import { simulate } from "../src/index";

const node = (
  id: string,
  kind: ArchitectureNode["kind"],
  overrides: Partial<ArchitectureNode["config"]> = {},
): ArchitectureNode => ({
  id,
  kind,
  name: id,
  position: { x: 0, y: 0 },
  config: {
    instances: 1,
    capacityRps: kind === "users" ? 10_000_000 : 10_000,
    baseLatencyMs: kind === "users" ? 0 : 10,
    maxConnections: 1_000_000,
    cacheHitRate: kind === "cache" ? 0.9 : 0,
    replicas: 0,
    monthlyCostEur: 0,
    autoscale: false,
    maxInstances: 1,
    consistency: "strong",
    ...overrides,
  },
});

const scenario = (overrides: Partial<Scenario["workload"]> = {}): Scenario => ({
  schemaVersion: 1,
  id: "topology-execution",
  title: "Topology execution",
  summary: "Exercise directed demand propagation.",
  mode: "custom",
  seed: 91_337,
  workload: {
    baseRps: 8_000,
    peakRps: 8_000,
    readRatio: 0.7,
    durationSeconds: 15,
    regions: [{ name: "test", trafficShare: 1, roundTripMs: 0 }],
    concurrentUsers: 100,
    arrivalPattern: "steady",
    clientTimeoutMs: 120_000,
    retryPolicy: {
      maxRetries: 0,
      backoffBaseMs: 0,
      jitter: false,
      retryOnTimeout: false,
    },
    ...overrides,
  },
  requirements: [],
  incidents: [],
});

const architecture = (
  nodes: ArchitectureNode[],
  edges: Architecture["edges"],
): Architecture => ({
  schemaVersion: 1,
  id: "topology",
  name: "Topology",
  nodes,
  edges,
});

const maximumNodeMetric = (
  result: ReturnType<typeof simulate>,
  nodeId: string,
  metric:
    | "utilization"
    | "cpuUtilization"
    | "iopsUtilization"
    | "errorRate"
    | "latencyMs",
): number =>
  Math.max(
    ...result.frames.map((frame) => frame.nodeMetrics[nodeId]?.[metric] ?? 0),
  );

describe("topology execution", () => {
  it("propagates outgoing traffic shares to the selected targets deterministically", () => {
    const model = architecture(
      [
        node("users", "users"),
        node("router", "api"),
        node("hot", "api"),
        node("cold", "api"),
      ],
      [
        { id: "users-router", source: "users", target: "router" },
        {
          id: "router-hot",
          source: "router",
          target: "hot",
          config: { trafficShare: 0.75 },
        },
        {
          id: "router-cold",
          source: "router",
          target: "cold",
          config: { trafficShare: 0.25 },
        },
      ],
    );
    const input = scenario();
    const first = simulate(input, model);
    const second = simulate(input, model);

    expect(first).toEqual(second);
    expect(maximumNodeMetric(first, "hot", "cpuUtilization")).toBeGreaterThan(
      maximumNodeMetric(first, "cold", "cpuUtilization") * 2.5,
    );
  });

  it("distinguishes two APIs in series from the same APIs in parallel", () => {
    const nodes = [
      node("users", "users"),
      node("api-a", "api", { baseLatencyMs: 35 }),
      node("api-b", "api", { baseLatencyMs: 35 }),
    ];
    const serial = architecture(nodes, [
      { id: "users-a", source: "users", target: "api-a" },
      { id: "a-b", source: "api-a", target: "api-b" },
    ]);
    const parallel = architecture(nodes, [
      {
        id: "users-a",
        source: "users",
        target: "api-a",
        config: { trafficShare: 0.5 },
      },
      {
        id: "users-b",
        source: "users",
        target: "api-b",
        config: { trafficShare: 0.5 },
      },
    ]);

    const serialResult = simulate(scenario(), serial);
    const parallelResult = simulate(scenario(), parallel);

    expect(
      maximumNodeMetric(serialResult, "api-b", "utilization"),
    ).toBeGreaterThan(
      maximumNodeMetric(parallelResult, "api-b", "utilization") * 1.7,
    );
    expect(
      Math.max(...serialResult.frames.map((frame) => frame.p50LatencyMs)),
    ).toBeGreaterThan(
      Math.max(...parallelResult.frames.map((frame) => frame.p50LatencyMs)),
    );
  });

  it("makes a cache reduce database demand only when it precedes the database", () => {
    const input = scenario({ readRatio: 1 });
    const nodes = [
      node("users", "users"),
      node("api", "api"),
      node("cache", "cache", {
        capacityRps: 1_000_000,
        cacheHitRate: 0.9,
        behavior: {
          cache: { capacityGb: 1_000, ttlSeconds: 300 },
        },
      }),
      node("db", "database", { capacityRps: 5_000 }),
    ];
    const cacheFirst = architecture(nodes, [
      { id: "users-api", source: "users", target: "api" },
      { id: "api-cache", source: "api", target: "cache" },
      { id: "cache-db", source: "cache", target: "db" },
    ]);
    const databaseFirst = architecture(nodes, [
      { id: "users-api", source: "users", target: "api" },
      { id: "api-db", source: "api", target: "db" },
      { id: "db-cache", source: "db", target: "cache" },
    ]);

    const cacheFirstResult = simulate(input, cacheFirst);
    const databaseFirstResult = simulate(input, databaseFirst);

    expect(
      maximumNodeMetric(databaseFirstResult, "db", "utilization"),
    ).toBeGreaterThan(
      maximumNodeMetric(cacheFirstResult, "db", "utilization") * 3,
    );
  });

  it("treats sibling cache hits as successful when the database miss branch is offline", () => {
    const model = architecture(
      [
        node("users", "users"),
        node("api", "api", { capacityRps: 1_000_000 }),
        node("cache", "cache", {
          capacityRps: 1_000_000,
          cacheHitRate: 0.9,
          behavior: {
            cache: { capacityGb: 100, ttlSeconds: 300 },
          },
        }),
        node("db", "database", { capacityRps: 1_000_000 }),
      ],
      [
        { id: "users-api", source: "users", target: "api" },
        { id: "api-cache", source: "api", target: "cache" },
        { id: "api-db", source: "api", target: "db" },
      ],
    );
    const input = scenario({
      baseRps: 2_500,
      peakRps: 2_500,
      readRatio: 1,
    });
    input.incidents = [
      {
        id: "db-down",
        atSecond: 1,
        durationSeconds: 10,
        kind: "node-failure",
        magnitude: 1,
        targetId: "db",
        label: "Database down",
      },
    ];

    const frame = simulate(input, model).frames[2]!;
    expect(frame.nodeMetrics.cache!.state).toBe("healthy");
    expect(frame.nodeMetrics.db!.state).toBe("offline");
    expect(frame.errorRate).toBeGreaterThan(8);
    expect(frame.errorRate).toBeLessThan(12);
    expect(frame.throughputRps).toBeGreaterThan(frame.rps * 0.85);
  });

  it("uses the actual source demand when an asynchronous lane is redirected", () => {
    const input = scenario({ readRatio: 0, baseRps: 10_000, peakRps: 10_000 });
    const nodes = [
      node("users", "users"),
      node("primary", "api"),
      node("side", "api"),
      node("queue", "queue", {
        capacityRps: 2_000,
        behavior: {
          messaging: { partitions: 8, delivery: "at-least-once" },
        },
      }),
      node("worker", "worker", { capacityRps: 10_000 }),
    ];
    const sharedEdges: Architecture["edges"] = [
      {
        id: "users-primary",
        source: "users",
        target: "primary",
        config: { trafficShare: 0.9 },
      },
      {
        id: "users-side",
        source: "users",
        target: "side",
        config: { trafficShare: 0.1 },
      },
      { id: "queue-worker", source: "queue", target: "worker" },
    ];
    const fromPrimary = architecture(nodes, [
      ...sharedEdges,
      {
        id: "async-lane",
        source: "primary",
        target: "queue",
        config: { asynchronous: true },
      },
    ]);
    const fromSide = architecture(nodes, [
      ...sharedEdges,
      {
        id: "async-lane",
        source: "side",
        target: "queue",
        config: { asynchronous: true },
      },
    ]);

    const primaryResult = simulate(input, fromPrimary);
    const sideResult = simulate(input, fromSide);

    expect(
      maximumNodeMetric(primaryResult, "queue", "utilization"),
    ).toBeGreaterThan(
      maximumNodeMetric(sideResult, "queue", "utilization") * 2,
    );
  });

  it("shares one worker fleet's capacity across every upstream queue", () => {
    const queueBehavior = {
      messaging: { partitions: 8, delivery: "at-least-once" as const },
    };
    const model = architecture(
      [
        node("users", "users"),
        node("q1", "queue", { behavior: queueBehavior }),
        node("q2", "queue", { behavior: queueBehavior }),
        node("worker", "worker", { capacityRps: 700 }),
      ],
      [
        { id: "users-q1", source: "users", target: "q1" },
        { id: "users-q2", source: "users", target: "q2" },
        { id: "q1-worker", source: "q1", target: "worker" },
        { id: "q2-worker", source: "q2", target: "worker" },
      ],
    );
    const input = scenario({
      baseRps: 2_000,
      peakRps: 2_000,
      readRatio: 0,
    });

    const frame = simulate(input, model).frames[0]!;
    expect(frame.edgeMetrics["q1-worker"]!.attemptedRps).toBeGreaterThan(500);
    expect(frame.edgeMetrics["q2-worker"]!.attemptedRps).toBeGreaterThan(500);
    expect(frame.nodeMetrics.q1!.queueDepth).toBeGreaterThan(0);
    expect(frame.nodeMetrics.q2!.queueDepth).toBeGreaterThan(0);
    expect(frame.queueDepth).toBeGreaterThan(0);
  });

  it("does not let an offline worker drain an available queue", () => {
    const model = architecture(
      [
        node("users", "users"),
        node("queue", "queue", {
          behavior: {
            storage: { replicationMode: "none" },
            messaging: { partitions: 8, delivery: "at-least-once" },
          },
        }),
        node("worker", "worker", { capacityRps: 2_000 }),
      ],
      [
        { id: "users-queue", source: "users", target: "queue" },
        { id: "queue-worker", source: "queue", target: "worker" },
      ],
    );
    const input = scenario({
      baseRps: 1_000,
      peakRps: 1_000,
      readRatio: 0,
    });
    input.incidents = [
      {
        id: "worker-down",
        atSecond: 1,
        durationSeconds: 5,
        kind: "node-failure",
        magnitude: 1,
        targetId: "worker",
        label: "Worker down",
      },
    ];

    const result = simulate(input, model);
    expect(result.frames[2]!.nodeMetrics.worker!.state).toBe("offline");
    expect(result.frames[2]!.edgeMetrics["queue-worker"]!.throughputRps).toBe(
      0,
    );
    expect(result.frames[2]!.nodeMetrics.queue!.queueDepth).toBeGreaterThan(0);
    expect(result.frames[3]!.nodeMetrics.queue!.queueDepth).toBeGreaterThan(
      result.frames[2]!.nodeMetrics.queue!.queueDepth,
    );
  });

  it("removes disconnected nodes from executed demand and the synchronous path", () => {
    const nodes = [
      node("users", "users"),
      node("api", "api"),
      node("db", "database", {
        capacityRps: 2_000,
        baseLatencyMs: 400,
      }),
    ];
    const connected = architecture(nodes, [
      { id: "users-api", source: "users", target: "api" },
      { id: "api-db", source: "api", target: "db" },
    ]);
    const disconnected = architecture(nodes, [
      { id: "users-api", source: "users", target: "api" },
    ]);

    const connectedResult = simulate(scenario(), connected);
    const disconnectedResult = simulate(scenario(), disconnected);

    expect(
      maximumNodeMetric(connectedResult, "db", "iopsUtilization"),
    ).toBeGreaterThan(0);
    expect(maximumNodeMetric(disconnectedResult, "db", "iopsUtilization")).toBe(
      0,
    );
    expect(
      Math.max(...connectedResult.frames.map((frame) => frame.p95LatencyMs)),
    ).toBeGreaterThan(
      Math.max(...disconnectedResult.frames.map((frame) => frame.p95LatencyMs)),
    );
  });

  it("applies edge latency and loss to the routed target while async work stays off the request path", () => {
    const nodes = [node("users", "users"), node("api", "api")];
    const healthy = architecture(nodes, [
      { id: "users-api", source: "users", target: "api" },
    ]);
    const degraded = architecture(nodes, [
      {
        id: "users-api",
        source: "users",
        target: "api",
        config: { baseLatencyMs: 500, packetLossRate: 0.4 },
      },
    ]);
    const asynchronous = architecture(nodes, [
      {
        id: "users-api",
        source: "users",
        target: "api",
        config: {
          baseLatencyMs: 500,
          packetLossRate: 0.4,
          asynchronous: true,
        },
      },
    ]);
    const lost = architecture(nodes, [
      {
        id: "users-api",
        source: "users",
        target: "api",
        config: { packetLossRate: 1 },
      },
    ]);

    const healthyResult = simulate(scenario(), healthy);
    const degradedResult = simulate(scenario(), degraded);
    const asynchronousResult = simulate(scenario(), asynchronous);
    const lostResult = simulate(scenario(), lost);

    expect(
      maximumNodeMetric(degradedResult, "api", "latencyMs"),
    ).toBeGreaterThan(
      maximumNodeMetric(healthyResult, "api", "latencyMs") + 400,
    );
    expect(
      maximumNodeMetric(degradedResult, "api", "errorRate"),
    ).toBeGreaterThan(
      maximumNodeMetric(healthyResult, "api", "errorRate") + 30,
    );
    expect(
      Math.max(...asynchronousResult.frames.map((frame) => frame.p95LatencyMs)),
    ).toBeLessThan(
      Math.max(...degradedResult.frames.map((frame) => frame.p95LatencyMs)),
    );
    expect(
      Math.max(...lostResult.frames.map((frame) => frame.errorRate)),
    ).toBeGreaterThan(90);
    const degradedEdge = degradedResult.frames[0]!.edgeMetrics["users-api"]!;
    expect(degradedEdge.attemptedRps).toBeGreaterThan(0);
    expect(degradedEdge.throughputRps).toBeCloseTo(
      degradedEdge.attemptedRps * 0.6,
      0,
    );
    expect(degradedEdge.lostRps).toBeCloseTo(
      degradedEdge.attemptedRps * 0.4,
      0,
    );
    expect(degradedEdge.packetLossPercent).toBe(40);
    expect(degradedEdge.latencyMs).toBe(500);
    expect(degradedEdge.asynchronous).toBe(false);
    expect(
      asynchronousResult.frames[0]!.edgeMetrics["users-api"]!.asynchronous,
    ).toBe(true);
  });

  it("retries only the failed dependency branch in proportion to its routed demand", () => {
    const model = architecture(
      [
        node("users", "users"),
        node("router", "api", {
          behavior: {
            resilience: {
              maxRetries: 3,
              backoffBaseMs: 0,
              jitter: false,
            },
          },
        }),
        node("major", "database", {
          capacityRps: 100_000,
          behavior: { storage: { bufferHitRate: 0 } },
        }),
        node("minor", "database", {
          capacityRps: 100_000,
          behavior: { storage: { bufferHitRate: 0 } },
        }),
      ],
      [
        { id: "users-router", source: "users", target: "router" },
        {
          id: "router-major",
          source: "router",
          target: "major",
          config: { trafficShare: 0.8 },
        },
        {
          id: "router-minor",
          source: "router",
          target: "minor",
          config: { trafficShare: 0.2 },
        },
      ],
    );
    const withFailure = (targetId: string): Scenario => {
      const input = scenario({
        baseRps: 4_000,
        peakRps: 4_000,
        readRatio: 1,
        durationSeconds: 15,
      });
      input.incidents = [
        {
          id: `failure-${targetId}`,
          atSecond: 1,
          durationSeconds: 14,
          kind: "node-failure",
          magnitude: 1,
          targetId,
          label: `${targetId} failed`,
        },
      ];
      return input;
    };
    const majorFailure = simulate(withFailure("major"), model);
    const minorFailure = simulate(withFailure("minor"), model);
    const majorBranchRetry =
      majorFailure.frames[3]!.edgeMetrics["router-major"]!.retryRps;
    const minorBranchRetry =
      minorFailure.frames[3]!.edgeMetrics["router-minor"]!.retryRps;
    expect(majorBranchRetry).toBeGreaterThan(minorBranchRetry * 3.5);
    expect(majorFailure.frames[3]!.edgeMetrics["router-minor"]!.retryRps).toBe(
      0,
    );
    expect(minorFailure.frames[3]!.edgeMetrics["router-major"]!.retryRps).toBe(
      0,
    );
  });

  it("rejects edges that reference a missing route endpoint", () => {
    const invalid = architecture(
      [node("users", "users")],
      [{ id: "missing", source: "users", target: "missing" }],
    );

    expect(() => simulate(scenario(), invalid)).toThrow();
  });

  it("rejects incidents whose target is not present in the architecture", () => {
    const input = scenario();
    input.incidents = [
      {
        id: "missing-target",
        atSecond: 1,
        kind: "node-failure",
        magnitude: 1,
        targetId: "missing",
        label: "Missing target",
      },
    ];
    const model = architecture(
      [node("users", "users"), node("api", "api")],
      [{ id: "users-api", source: "users", target: "api" }],
    );

    expect(() => simulate(input, model)).toThrow(
      "invalid_scenario:incident:missing-target:unknown-target:missing",
    );
  });

  it("rejects a model with no reachable workload entry target", () => {
    const model = architecture(
      [node("users", "users"), node("api", "api")],
      [],
    );
    const rootlessCycle = architecture(
      [node("api-a", "api"), node("api-b", "api")],
      [
        { id: "a-b", source: "api-a", target: "api-b" },
        { id: "b-a", source: "api-b", target: "api-a" },
      ],
    );

    expect(() => simulate(scenario(), model)).toThrow(
      "invalid_topology:disconnected-entry:users",
    );
    expect(() => simulate(scenario(), rootlessCycle)).toThrow(
      "invalid_topology:no-entry-path",
    );
  });

  it("requires complete explicit routing shares and preserves all-omitted fan-out", () => {
    const nodes = [
      node("users", "users"),
      node("router", "api"),
      node("a", "api"),
      node("b", "api"),
    ];
    const oversubscribed = architecture(nodes, [
      { id: "users-router", source: "users", target: "router" },
      {
        id: "router-a",
        source: "router",
        target: "a",
        config: { trafficShare: 0.75 },
      },
      {
        id: "router-b",
        source: "router",
        target: "b",
        config: { trafficShare: 0.5 },
      },
    ]);
    const legacyFanOut = structuredClone(oversubscribed);
    legacyFanOut.edges.find((edge) => edge.id === "router-a")!.config = {};
    legacyFanOut.edges.find((edge) => edge.id === "router-b")!.config = {};
    const shareGap = architecture(nodes, [
      { id: "users-router", source: "users", target: "router" },
      {
        id: "router-a",
        source: "router",
        target: "a",
        config: { trafficShare: 0.2 },
      },
    ]);

    expect(() => simulate(scenario(), oversubscribed)).toThrow(
      "invalid_topology:outgoing-traffic-share:router:1.25",
    );
    expect(() => simulate(scenario(), shareGap)).toThrow(
      "invalid_topology:outgoing-traffic-share:router:0.2",
    );
    expect(() => simulate(scenario(), legacyFanOut)).not.toThrow();
  });

  it("weights mutually exclusive route failures without destroying healthy alternatives", () => {
    const model = architecture(
      [
        node("users", "users"),
        node("api-a", "api", { capacityRps: 1_000_000 }),
        node("api-b", "api", { capacityRps: 1_000_000 }),
      ],
      [
        {
          id: "users-a",
          source: "users",
          target: "api-a",
          config: { trafficShare: 0.5 },
        },
        {
          id: "users-b",
          source: "users",
          target: "api-b",
          config: { trafficShare: 0.5 },
        },
      ],
    );
    const input = scenario({ baseRps: 1_000, peakRps: 1_000 });
    input.incidents = [
      {
        id: "api-a-down",
        atSecond: 1,
        durationSeconds: 10,
        kind: "node-failure",
        magnitude: 1,
        targetId: "api-a",
        label: "API A down",
      },
    ];

    const frame = simulate(input, model).frames[2]!;
    expect(frame.errorRate).toBeGreaterThan(45);
    expect(frame.errorRate).toBeLessThan(55);
    expect(frame.throughputRps).toBeGreaterThan(frame.rps * 0.45);
  });

  it("fails an explicit synchronous route when its object-store terminal is offline", () => {
    const model = architecture(
      [
        node("users", "users"),
        node("api", "api", { capacityRps: 1_000_000 }),
        node("store", "object-store", { capacityRps: 1_000_000 }),
      ],
      [
        { id: "users-api", source: "users", target: "api" },
        { id: "api-store", source: "api", target: "store" },
      ],
    );
    const input = scenario({ baseRps: 1_000, peakRps: 1_000, readRatio: 1 });
    input.workload.requestMix = [
      {
        name: "fetch",
        share: 1,
        readRatio: 1,
        payloadKb: 1,
        computeMs: 1,
        databaseQueries: 0,
        cacheable: false,
        critical: true,
        entryNodeId: "users",
        route: {
          edgeIds: ["users-api", "api-store"],
          terminalNodeId: "store",
        },
      },
    ];
    input.incidents = [
      {
        id: "store-down",
        atSecond: 1,
        durationSeconds: 10,
        kind: "node-failure",
        magnitude: 1,
        targetId: "store",
        label: "Store down",
      },
    ];

    const frame = simulate(input, model).frames[2]!;
    expect(frame.nodeMetrics.store!.state).toBe("offline");
    expect(frame.errorRate).toBeGreaterThan(90);
    expect(frame.availability).toBeLessThan(10);
  });

  it("routes regional workload shares through matching Region entries", () => {
    const model = architecture(
      [
        node("eu", "region", {
          behavior: { topology: { region: "EU" } },
        }),
        node("us", "region", {
          behavior: { topology: { region: "US" } },
        }),
        node("api", "api", { capacityRps: 1_000_000 }),
      ],
      [
        { id: "eu-api", source: "eu", target: "api" },
        { id: "us-api", source: "us", target: "api" },
      ],
    );
    const input = scenario({
      regions: [
        { name: "EU", trafficShare: 0.9, roundTripMs: 10 },
        { name: "US", trafficShare: 0.1, roundTripMs: 40 },
      ],
    });
    input.workload.requestMix = [
      {
        name: "regional read",
        share: 1,
        readRatio: 1,
        payloadKb: 1,
        computeMs: 1,
        databaseQueries: 0,
        cacheable: false,
        critical: true,
        route: { terminalNodeId: "api" },
      },
    ];

    const result = simulate(input, model);
    const frame = result.frames[0]!;
    expect(frame.edgeMetrics["eu-api"]!.attemptedRps).toBeCloseTo(
      frame.edgeMetrics["us-api"]!.attemptedRps * 9,
      0,
    );
    const trace = result.traces?.find((candidate) => candidate.second === 0);
    expect(trace?.entryNodeIds).toEqual(["eu", "us"]);
    const root = trace?.spans[0];
    expect(root).toMatchObject({
      kind: "entry",
      name: "Enter 2 modeled sources",
    });
    expect(root).not.toHaveProperty("nodeId");
    expect(trace?.spans).toContainEqual(
      expect.objectContaining({
        parentSpanId: root?.spanId,
        kind: "entry",
        nodeId: "eu",
      }),
    );
    expect(trace?.spans).toContainEqual(
      expect.objectContaining({
        parentSpanId: root?.spanId,
        kind: "entry",
        nodeId: "us",
      }),
    );
    expect(trace?.spans).toContainEqual(
      expect.objectContaining({
        parentSpanId: root?.spanId,
        kind: "terminal",
        nodeId: "api",
      }),
    );
  });

  it("rejects any positive-weight regional entry without a service path", () => {
    const model = architecture(
      [
        node("eu", "region", {
          behavior: { topology: { region: "EU" } },
        }),
        node("us", "region", {
          behavior: { topology: { region: "US" } },
        }),
        node("api", "api"),
      ],
      [{ id: "eu-api", source: "eu", target: "api" }],
    );
    const input = scenario({
      regions: [
        { name: "EU", trafficShare: 0.1, roundTripMs: 10 },
        { name: "US", trafficShare: 0.9, roundTripMs: 40 },
      ],
    });

    expect(() => simulate(input, model)).toThrow(
      "invalid_topology:disconnected-entry:us",
    );
  });

  it("preserves regional weights for terminal-only request-class routes", () => {
    const model = architecture(
      [
        node("eu", "region", {
          behavior: { topology: { region: "EU" } },
        }),
        node("us", "region", {
          behavior: { topology: { region: "US" } },
        }),
        node("api", "api", { capacityRps: 1_000_000 }),
      ],
      [
        { id: "eu-api", source: "eu", target: "api" },
        { id: "us-api", source: "us", target: "api" },
      ],
    );
    const input = scenario({
      regions: [
        { name: "EU", trafficShare: 0.9, roundTripMs: 10 },
        { name: "US", trafficShare: 0.1, roundTripMs: 40 },
      ],
    });
    input.workload.requestMix = [
      {
        name: "regional read",
        share: 1,
        readRatio: 1,
        payloadKb: 1,
        computeMs: 1,
        databaseQueries: 0,
        cacheable: false,
        critical: true,
        route: { terminalNodeId: "api" },
      },
    ];

    const frame = simulate(input, model).frames[0]!;
    expect(frame.edgeMetrics["eu-api"]!.attemptedRps).toBeCloseTo(
      frame.edgeMetrics["us-api"]!.attemptedRps * 9,
      0,
    );
  });

  it("does not reverse-route a terminal-only class through a disabled edge", () => {
    const model = architecture(
      [
        node("users", "users"),
        node("router", "api", { capacityRps: 1_000_000 }),
        node("good", "api", { capacityRps: 1_000_000 }),
        node("dead", "api", { capacityRps: 1_000_000 }),
        node("terminal", "api", { capacityRps: 1_000_000 }),
      ],
      [
        { id: "users-router", source: "users", target: "router" },
        {
          id: "router-good",
          source: "router",
          target: "good",
          config: { trafficShare: 0.5 },
        },
        {
          id: "router-dead",
          source: "router",
          target: "dead",
          config: { trafficShare: 0.5 },
        },
        { id: "good-terminal", source: "good", target: "terminal" },
        {
          id: "dead-terminal-disabled",
          source: "dead",
          target: "terminal",
          config: { trafficShare: 0 },
        },
      ],
    );
    const input = scenario({ baseRps: 1_000, peakRps: 1_000, readRatio: 1 });
    input.workload.requestMix = [
      {
        name: "terminal route",
        share: 1,
        readRatio: 1,
        payloadKb: 1,
        computeMs: 1,
        databaseQueries: 0,
        cacheable: false,
        critical: true,
        route: { terminalNodeId: "terminal" },
      },
    ];

    const frame = simulate(input, model).frames[0]!;
    expect(frame.edgeMetrics["dead-terminal-disabled"]!.attemptedRps).toBe(0);
    expect(frame.edgeMetrics["router-dead"]!.attemptedRps).toBe(0);
    expect(frame.errorRate).toBeGreaterThan(45);
    expect(frame.errorRate).toBeLessThan(55);
  });

  it("keeps cache hit and pressure behavior local to each routed cache", () => {
    const model = architecture(
      [
        node("users", "users"),
        node("router", "api", { capacityRps: 1_000_000 }),
        node("small-hit", "cache", {
          capacityRps: 1_000_000,
          cacheHitRate: 1,
          behavior: {
            cache: { capacityGb: 0.01, ttlSeconds: 300 },
          },
        }),
        node("miss", "cache", {
          capacityRps: 1_000_000,
          cacheHitRate: 0,
          behavior: {
            cache: { capacityGb: 100, ttlSeconds: 300 },
          },
        }),
        node("db", "database", { capacityRps: 1_000_000 }),
      ],
      [
        { id: "users-router", source: "users", target: "router" },
        {
          id: "router-small",
          source: "router",
          target: "small-hit",
          config: { trafficShare: 0.01 },
        },
        {
          id: "router-miss",
          source: "router",
          target: "miss",
          config: { trafficShare: 0.99 },
        },
        { id: "small-db", source: "small-hit", target: "db" },
        { id: "miss-db", source: "miss", target: "db" },
      ],
    );
    const input = scenario({ baseRps: 1_000, peakRps: 1_000, readRatio: 1 });
    input.workload.requestMix = [
      {
        name: "cache read",
        share: 1,
        readRatio: 1,
        payloadKb: 1,
        computeMs: 1,
        databaseQueries: 1,
        cacheable: true,
        critical: false,
      },
    ];

    const frame = simulate(input, model).frames[0]!;
    expect(frame.edgeMetrics["router-small"]!.attemptedRps).toBeGreaterThan(5);
    expect(frame.edgeMetrics["small-db"]!.attemptedRps).toBeLessThan(0.1);
    expect(frame.edgeMetrics["miss-db"]!.attemptedRps).toBeGreaterThan(900);
  });

  it("computes cache working-set pressure from each routed payload mix", () => {
    const model = architecture(
      [
        node("users", "users"),
        node("router", "api", { capacityRps: 1_000_000 }),
        node("small-payload-cache", "cache", {
          capacityRps: 1_000_000,
          cacheHitRate: 1,
          behavior: { cache: { capacityGb: 1, ttlSeconds: 300 } },
        }),
        node("large-payload-cache", "cache", {
          capacityRps: 1_000_000,
          cacheHitRate: 1,
          behavior: { cache: { capacityGb: 1, ttlSeconds: 300 } },
        }),
        node("small-db", "database", { capacityRps: 1_000_000 }),
        node("large-db", "database", { capacityRps: 1_000_000 }),
      ],
      [
        { id: "users-router", source: "users", target: "router" },
        { id: "router-small", source: "router", target: "small-payload-cache" },
        {
          id: "small-cache-db",
          source: "small-payload-cache",
          target: "small-db",
        },
        { id: "router-large", source: "router", target: "large-payload-cache" },
        {
          id: "large-cache-db",
          source: "large-payload-cache",
          target: "large-db",
        },
      ],
    );
    const input = scenario({
      baseRps: 1_000,
      peakRps: 1_000,
      readRatio: 1,
    });
    input.workload.requestMix = [
      {
        name: "small cache read",
        share: 0.5,
        readRatio: 1,
        payloadKb: 1,
        computeMs: 1,
        databaseQueries: 1,
        cacheable: true,
        critical: false,
        entryNodeId: "users",
        route: {
          edgeIds: ["users-router", "router-small", "small-cache-db"],
          terminalNodeId: "small-db",
        },
      },
      {
        name: "large cache read",
        share: 0.5,
        readRatio: 1,
        payloadKb: 1_000,
        computeMs: 1,
        databaseQueries: 1,
        cacheable: true,
        critical: false,
        entryNodeId: "users",
        route: {
          edgeIds: ["users-router", "router-large", "large-cache-db"],
          terminalNodeId: "large-db",
        },
      },
    ];

    const frame = simulate(input, model).frames[2]!;
    expect(frame.edgeMetrics["small-cache-db"]!.attemptedRps).toBeLessThan(1);
    expect(frame.edgeMetrics["large-cache-db"]!.attemptedRps).toBeGreaterThan(
      400,
    );
  });

  it("applies persistent user concurrency to every serial service it crosses", () => {
    const model = architecture(
      [
        node("users", "users"),
        node("api-a", "api", {
          capacityRps: 1_000_000,
          maxConnections: 600,
        }),
        node("api-b", "api", {
          capacityRps: 1_000_000,
          maxConnections: 600,
        }),
      ],
      [
        { id: "users-a", source: "users", target: "api-a" },
        { id: "a-b", source: "api-a", target: "api-b" },
      ],
    );
    const input = scenario({
      baseRps: 100,
      peakRps: 100,
      concurrentUsers: 1_000,
      readRatio: 1,
    });

    const frame = simulate(input, model).frames[0]!;
    expect(frame.nodeMetrics["api-a"]!.connectionUtilization).toBeGreaterThan(
      1.5,
    );
    expect(frame.nodeMetrics["api-b"]!.connectionUtilization).toBeCloseTo(
      frame.nodeMetrics["api-a"]!.connectionUtilization,
      4,
    );
  });

  it("does not apply resilience controls from an excluded request branch", () => {
    const nodes = [
      node("users", "users"),
      node("router", "api", { capacityRps: 1_000_000 }),
      node("main", "third-party", { capacityRps: 1_000_000 }),
      node("side", "api", { capacityRps: 1_000_000 }),
    ];
    const model = architecture(nodes, [
      { id: "users-router", source: "users", target: "router" },
      {
        id: "router-main",
        source: "router",
        target: "main",
        config: { trafficShare: 0.5 },
      },
      {
        id: "router-side",
        source: "router",
        target: "side",
        config: { trafficShare: 0.5 },
      },
    ]);
    const input = scenario({ baseRps: 1_000, peakRps: 1_000, readRatio: 1 });
    input.workload.requestMix = [
      {
        name: "main only",
        share: 1,
        readRatio: 1,
        payloadKb: 1,
        computeMs: 1,
        databaseQueries: 0,
        cacheable: false,
        critical: true,
        entryNodeId: "users",
        route: {
          edgeIds: ["users-router", "router-main"],
          terminalNodeId: "main",
        },
      },
    ];
    input.incidents = [
      {
        id: "main-down",
        atSecond: 1,
        durationSeconds: 10,
        kind: "third-party-outage",
        magnitude: 1,
        targetId: "main",
        label: "Main dependency down",
      },
    ];
    const withSidePolicy = structuredClone(model);
    withSidePolicy.nodes.find(
      (candidate) => candidate.id === "side",
    )!.config.behavior = {
      resilience: { circuitBreaker: true },
    };

    const baseline = simulate(input, model);
    const policy = simulate(input, withSidePolicy);
    expect(policy.frames.map((frame) => frame.retryAmplification)).toEqual(
      baseline.frames.map((frame) => frame.retryAmplification),
    );
  });

  it("reports complete failure and recovery transitions without a two-percent floor", () => {
    const base = architecture(
      [
        node("users", "users"),
        node("db", "database", {
          capacityRps: 1_000_000,
          instances: 1,
          maxInstances: 1,
          replicas: 2,
          behavior: {
            storage: { replicationMode: "async", failoverSeconds: 1 },
            topology: { zone: "multi-az" },
          },
        }),
      ],
      [{ id: "users-db", source: "users", target: "db" }],
    );
    const slow = structuredClone(base);
    slow.nodes.find((candidate) => candidate.id === "db")!.config.behavior = {
      storage: { replicationMode: "async", failoverSeconds: 100 },
      topology: { zone: "multi-az" },
    };
    const input = scenario({ baseRps: 1_000, peakRps: 1_000, readRatio: 1 });
    input.incidents = [
      {
        id: "db-failure",
        atSecond: 1,
        durationSeconds: 5,
        kind: "node-failure",
        magnitude: 1,
        targetId: "db",
        label: "Database copy failed",
      },
    ];

    const fastResult = simulate(input, base);
    const slowResult = simulate(input, slow);
    expect(fastResult.frames[2]!.availability).toBe(100);
    expect(slowResult.frames[2]!.availability).toBeLessThan(100);
    expect(fastResult.frames[1]!.recoveryTimeSeconds).toBe(1);
    expect(slowResult.frames[1]!.recoveryTimeSeconds).toBe(5);

    const noReplica = structuredClone(base);
    const db = noReplica.nodes.find((candidate) => candidate.id === "db")!;
    db.config.replicas = 0;
    db.config.behavior = {
      ...db.config.behavior,
      storage: { replicationMode: "none", failoverSeconds: 100 },
    };
    const unavailable = simulate(input, noReplica).frames[2]!;
    expect(unavailable.errorRate).toBe(100);
    expect(unavailable.availability).toBe(0);
    expect(unavailable.nodeMetrics.db!.state).toBe("offline");
    expect(unavailable.recoveryTimeSeconds).toBe(5);
  });

  it("counts routed messaging operations in durability evidence", () => {
    const model = architecture(
      [
        node("users", "users"),
        node("queue", "queue", {
          capacityRps: 1_000_000,
          replicas: 2,
          behavior: {
            storage: { replicationMode: "quorum", failoverSeconds: 5 },
            messaging: { delivery: "at-most-once" },
          },
        }),
      ],
      [{ id: "users-queue", source: "users", target: "queue" }],
    );
    const input = scenario({ baseRps: 1_000, peakRps: 1_000, readRatio: 1 });
    input.workload.requestMix = [
      {
        name: "message delivery",
        share: 1,
        readRatio: 1,
        payloadKb: 1,
        computeMs: 1,
        databaseQueries: 0,
        cacheable: false,
        critical: true,
        entryNodeId: "users",
        route: {
          edgeIds: ["users-queue"],
          terminalNodeId: "queue",
        },
      },
    ];
    input.incidents = [
      {
        id: "queue-failure",
        atSecond: 1,
        durationSeconds: 5,
        kind: "node-failure",
        magnitude: 1,
        targetId: "queue",
        label: "Queue copy failed",
      },
    ];

    const result = simulate(input, model);
    expect(result.frames.some((frame) => frame.dataLoss > 0)).toBe(true);
    expect(result.frames.some((frame) => frame.durabilityPercent < 100)).toBe(
      true,
    );
  });

  it("counts rejected asynchronous enqueues when the queue is offline", () => {
    const model = architecture(
      [
        node("users", "users"),
        node("queue", "queue", {
          capacityRps: 1_000_000,
          replicas: 0,
          behavior: {
            storage: { replicationMode: "none" },
            messaging: { delivery: "at-least-once" },
          },
        }),
        node("worker", "worker", { capacityRps: 1_000_000 }),
      ],
      [
        {
          id: "users-queue",
          source: "users",
          target: "queue",
          config: { asynchronous: true },
        },
        { id: "queue-worker", source: "queue", target: "worker" },
      ],
    );
    const input = scenario({ baseRps: 1_000, peakRps: 1_000, readRatio: 0 });
    input.workload.requestMix = [
      {
        name: "enqueue",
        share: 1,
        readRatio: 0,
        payloadKb: 1,
        computeMs: 1,
        databaseQueries: 0,
        cacheable: false,
        critical: true,
        entryNodeId: "users",
        route: {
          edgeIds: ["users-queue", "queue-worker"],
          terminalNodeId: "worker",
        },
      },
    ];
    input.incidents = [
      {
        id: "queue-outage",
        atSecond: 1,
        durationSeconds: 3,
        kind: "node-failure",
        magnitude: 1,
        targetId: "queue",
        label: "Queue unavailable",
      },
    ];

    const result = simulate(input, model);
    const outage = result.frames[2]!;
    expect(outage.availability).toBe(100);
    expect(outage.nodeMetrics.queue!.state).toBe("offline");
    expect(outage.edgeMetrics["users-queue"]!.throughputRps).toBe(0);
    expect(outage.dataLoss).toBeGreaterThan(900);
    expect(outage.durabilityPercent).toBeLessThan(100);
    expect(outage.nodeMetrics.queue!.queueDepth).toBe(0);
  });

  it("includes object-store writes in durability and loss evidence", () => {
    const model = architecture(
      [
        node("users", "users"),
        node("store", "object-store", {
          capacityRps: 1_000_000,
          replicas: 0,
          behavior: { storage: { replicationMode: "none" } },
        }),
      ],
      [{ id: "users-store", source: "users", target: "store" }],
    );
    const input = scenario({ baseRps: 1_000, peakRps: 1_000, readRatio: 0 });
    input.workload.requestMix = [
      {
        name: "object write",
        share: 1,
        readRatio: 0,
        payloadKb: 1,
        computeMs: 1,
        databaseQueries: 0,
        cacheable: false,
        critical: true,
        entryNodeId: "users",
        route: {
          edgeIds: ["users-store"],
          terminalNodeId: "store",
        },
      },
    ];
    input.incidents = [
      {
        id: "store-outage",
        atSecond: 1,
        durationSeconds: 5,
        kind: "node-failure",
        magnitude: 1,
        targetId: "store",
        label: "Object store unavailable",
      },
    ];

    const result = simulate(input, model);
    const outage = result.frames[2]!;
    expect(outage.availability).toBe(0);
    expect(outage.nodeMetrics.store!.state).toBe("offline");
    expect(outage.dataLoss).toBeGreaterThan(0);
    expect(outage.durabilityPercent).toBeLessThan(100);
  });

  it("reports regional single points of failure in structural analysis", () => {
    const model = architecture(
      [
        node("users", "users"),
        node("api", "api", {
          instances: 2,
          maxInstances: 2,
          capacityRps: 1_000_000,
          behavior: { topology: { failureDomain: "multi-region" } },
        }),
        node("db", "database", {
          capacityRps: 1_000_000,
          instances: 3,
          maxInstances: 3,
          replicas: 2,
          behavior: {
            storage: { replicationMode: "quorum" },
            topology: {
              region: "EU",
              zone: "multi-az",
              failureDomain: "regional-cluster",
            },
          },
        }),
      ],
      [
        { id: "users-api", source: "users", target: "api" },
        { id: "api-db", source: "api", target: "db" },
      ],
    );
    const input = scenario({ baseRps: 1_000, peakRps: 1_000, readRatio: 1 });
    input.incidents = [
      {
        id: "eu-outage",
        atSecond: 1,
        durationSeconds: 5,
        kind: "region-outage",
        magnitude: 1,
        region: "EU",
        label: "EU unavailable",
      },
    ];

    const result = simulate(input, model);
    expect(result.frames[2]!.availability).toBe(0);
    expect(result.analysis.risks).toContain(
      "db keeps its retained state inside one regional failure domain.",
    );
    expect(result.analysis.risks).not.toContain(
      "No structural single point of failure was detected in the modeled primitives.",
    );
  });

  it("ignores disabled back-edges when deriving sources and execution order", () => {
    const nodes = [
      node("users", "users"),
      node("b", "api", { capacityRps: 1_000_000 }),
      node("a", "api", { capacityRps: 1_000_000 }),
      node("c", "api", { capacityRps: 1_000_000 }),
    ];
    const baseline = architecture(nodes, [
      { id: "users-a", source: "users", target: "a" },
      { id: "a-b", source: "a", target: "b" },
      {
        id: "b-c",
        source: "b",
        target: "c",
        config: { trafficShare: 1 },
      },
    ]);
    const withDisabledBackEdge = architecture(nodes, [
      ...baseline.edges,
      {
        id: "b-a-disabled",
        source: "b",
        target: "a",
        config: { trafficShare: 0 },
      },
    ]);

    const baselineFrame = simulate(scenario(), baseline).frames[0]!;
    const disabledFrame = simulate(scenario(), withDisabledBackEdge).frames[0]!;
    expect(disabledFrame.edgeMetrics["b-c"]!.attemptedRps).toBeCloseTo(
      baselineFrame.edgeMetrics["b-c"]!.attemptedRps,
      8,
    );
    expect(disabledFrame.nodeMetrics.c!.cpuUtilization).toBeCloseTo(
      baselineFrame.nodeMetrics.c!.cpuUtilization,
      8,
    );

    const inferredSource = architecture(
      [node("a", "api"), node("b", "api")],
      [
        { id: "a-b", source: "a", target: "b", config: { trafficShare: 1 } },
        {
          id: "b-a-disabled",
          source: "b",
          target: "a",
          config: { trafficShare: 0 },
        },
      ],
    );
    expect(() => simulate(scenario(), inferredSource)).not.toThrow();
  });

  it("rejects reachable feedback cycles and excessive fan-out before execution", () => {
    const returningCycle = architecture(
      [node("users", "users"), node("api", "api")],
      [
        { id: "users-api", source: "users", target: "api" },
        { id: "api-users", source: "api", target: "users" },
      ],
    );
    const selfLoop = architecture(
      [node("users", "users"), node("api", "api")],
      [
        { id: "users-users", source: "users", target: "users" },
        { id: "users-api", source: "users", target: "api" },
      ],
    );
    const fanoutNodes = Array.from({ length: 11 }, (_, index) =>
      node(
        index === 0 ? "users" : `api-${index}`,
        index === 0 ? "users" : "api",
      ),
    );
    const fanoutEdges: Architecture["edges"] = [];
    for (let index = 0; index < fanoutNodes.length - 1; index += 1) {
      for (let lane = 0; lane < 4; lane += 1)
        fanoutEdges.push({
          id: `edge-${index}-${lane}`,
          source: fanoutNodes[index]!.id,
          target: fanoutNodes[index + 1]!.id,
        });
    }

    expect(() => simulate(scenario(), returningCycle)).toThrow(
      "invalid_topology:reachable-cycle",
    );
    expect(() => simulate(scenario(), selfLoop)).toThrow(
      "invalid_topology:reachable-cycle",
    );
    expect(() =>
      simulate(scenario(), architecture(fanoutNodes, fanoutEdges)),
    ).toThrow("invalid_topology:fanout-amplification");
  });

  it("applies partial stateless fleet failure once and stops downstream work when offline", () => {
    const partial = architecture(
      [
        node("users", "users"),
        node("api", "api", {
          instances: 2,
          maxInstances: 2,
          capacityRps: 1_000_000,
        }),
        node("db", "database", { capacityRps: 1_000_000 }),
      ],
      [
        { id: "users-api", source: "users", target: "api" },
        { id: "api-db", source: "api", target: "db" },
      ],
    );
    const input = scenario({ baseRps: 1_000, peakRps: 1_000 });
    input.incidents = [
      {
        id: "api-failure",
        atSecond: 1,
        durationSeconds: 10,
        kind: "node-failure",
        magnitude: 1,
        targetId: "api",
        label: "API instance failed",
      },
    ];

    const partialFrame = simulate(input, partial).frames[2]!;
    expect(partialFrame.errorRate).toBeGreaterThan(45);
    expect(partialFrame.errorRate).toBeLessThan(55);
    expect(partialFrame.edgeMetrics["api-db"]!.attemptedRps).toBeCloseTo(
      partialFrame.edgeMetrics["users-api"]!.throughputRps,
      0,
    );

    partial.nodes.find(
      (candidate) => candidate.id === "api",
    )!.config.instances = 1;
    partial.nodes.find(
      (candidate) => candidate.id === "api",
    )!.config.maxInstances = 1;
    const offlineFrame = simulate(input, partial).frames[2]!;
    expect(offlineFrame.nodeMetrics.api!.state).toBe("offline");
    expect(offlineFrame.edgeMetrics["api-db"]!.attemptedRps).toBe(0);
  });

  it("rejects physically inapplicable authored incident scopes", () => {
    const model = architecture(
      [node("users", "users"), node("api", "api")],
      [{ id: "users-api", source: "users", target: "api" }],
    );
    const badKind = scenario();
    badKind.incidents = [
      {
        id: "db-on-api",
        atSecond: 1,
        durationSeconds: 10,
        kind: "database-degradation",
        magnitude: 4,
        targetId: "api",
        label: "DB degradation",
      },
    ];
    const badRegion = scenario();
    badRegion.incidents = [
      {
        id: "bad-region",
        atSecond: 1,
        durationSeconds: 10,
        kind: "region-outage",
        magnitude: 1,
        region: "does-not-exist",
        label: "Bad region",
      },
    ];
    const badAutoscaling = scenario();
    badAutoscaling.incidents = [
      {
        id: "bad-autoscaling",
        atSecond: 1,
        durationSeconds: 10,
        kind: "bad-autoscaling",
        magnitude: 2,
        targetId: "api",
        label: "No autoscaler",
      },
    ];

    expect(() => simulate(badKind, model)).toThrow("inapplicable-kind-scope");
    expect(() => simulate(badRegion, model)).toThrow("unknown-region");
    expect(() => simulate(badAutoscaling, model)).toThrow(
      "inapplicable-kind-scope",
    );
  });

  it("rejects execution work above the direct simulator budget", () => {
    const nodes = Array.from({ length: 500 }, (_, index) =>
      node(
        index === 0 ? "users" : `node-${index}`,
        index === 0 ? "users" : "api",
      ),
    );
    const edges: Architecture["edges"] = [];
    for (let index = 0; index < nodes.length - 1; index += 1) {
      for (let lane = 0; lane < 4; lane += 1)
        edges.push({
          id: `edge-${index}-${lane}`,
          source: nodes[index]!.id,
          target: nodes[index + 1]!.id,
          config: { trafficShare: 0.25 },
        });
    }
    const input = scenario({ durationSeconds: 86_400 });
    input.workload.requestMix = Array.from({ length: 40 }, (_, index) => ({
      name: `class-${index}`,
      share: 0.025,
      readRatio: 1,
      payloadKb: 1,
      computeMs: 1,
      databaseQueries: 0,
      cacheable: false,
      critical: false,
    }));

    expect(() => simulate(input, architecture(nodes, edges))).toThrow(
      "simulation_work_budget_exceeded",
    );
  });
});
