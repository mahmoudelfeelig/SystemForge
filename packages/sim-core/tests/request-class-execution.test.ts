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
    capacityRps: kind === "users" ? 1_000_000 : 50_000,
    baseLatencyMs: kind === "users" ? 0 : 5,
    maxConnections: 1_000_000,
    cacheHitRate: kind === "cache" ? 0.85 : 0,
    replicas: 0,
    monthlyCostEur: 0,
    autoscale: false,
    maxInstances: 1,
    consistency: "strong",
    ...overrides,
  },
});

const model: Architecture = {
  schemaVersion: 1,
  id: "request-classes",
  name: "Request classes",
  nodes: [
    node("users", "users"),
    node("router", "api"),
    node("read-api", "api"),
    node("cache", "cache", {
      cacheHitRate: 0.85,
      behavior: { cache: { capacityGb: 10_000, ttlSeconds: 300 } },
    }),
    node("read-db", "database"),
    node("write-api", "api", {
      behavior: {
        resilience: {
          maxRetries: 2,
          backoffBaseMs: 0,
          jitter: false,
        },
      },
    }),
    node("queue", "queue", {
      behavior: {
        messaging: { partitions: 8, delivery: "at-least-once" },
      },
    }),
    node("worker", "worker"),
    node("orphan", "api"),
  ],
  edges: [
    { id: "users-router", source: "users", target: "router" },
    { id: "router-read", source: "router", target: "read-api" },
    { id: "read-cache", source: "read-api", target: "cache" },
    { id: "cache-db", source: "cache", target: "read-db" },
    { id: "read-direct-db", source: "read-api", target: "read-db" },
    { id: "router-write", source: "router", target: "write-api" },
    {
      id: "write-queue",
      source: "write-api",
      target: "queue",
      config: { asynchronous: true, baseLatencyMs: 12 },
    },
    { id: "queue-worker", source: "queue", target: "worker" },
  ],
};

const requestClass = (
  name: string,
  share: number,
  route: string[],
  overrides: Partial<
    NonNullable<Scenario["workload"]["requestMix"]>[number]
  > = {},
): NonNullable<Scenario["workload"]["requestMix"]>[number] => ({
  name,
  share,
  readRatio: 1,
  payloadKb: 8,
  computeMs: 2,
  databaseQueries: 1,
  cacheable: true,
  critical: false,
  entryNodeId: "users",
  route: { edgeIds: route },
  ...overrides,
});

const scenario = (): Scenario => ({
  schemaVersion: 1,
  id: "request-class-routing",
  title: "Request-class routing",
  summary: "Route reads and writes through different executed paths.",
  mode: "custom",
  seed: 4_242,
  workload: {
    baseRps: 10_000,
    peakRps: 10_000,
    readRatio: 0.5,
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
    requestMix: [
      requestClass("Read path", 0.5, [
        "users-router",
        "router-read",
        "read-cache",
        "cache-db",
      ]),
      requestClass(
        "Write path",
        0.5,
        ["users-router", "router-write", "write-queue", "queue-worker"],
        {
          readRatio: 0,
          payloadKb: 64,
          computeMs: 20,
          databaseQueries: 3,
          cacheable: false,
          critical: true,
        },
      ),
    ],
  },
  requirements: [],
  incidents: [
    {
      id: "queue-failure",
      atSecond: 1,
      durationSeconds: 10,
      kind: "node-failure",
      magnitude: 1,
      targetId: "queue",
      label: "Queue unavailable",
    },
  ],
});

describe("request-class topology execution", () => {
  it("executes two request classes through their own constrained paths", () => {
    const result = simulate(scenario(), model);
    const first = result.frames[0]!;

    expect(first.edgeMetrics["router-read"]!.attemptedRps).toBeGreaterThan(0);
    expect(first.edgeMetrics["router-write"]!.attemptedRps).toBeGreaterThan(0);
    expect(first.edgeMetrics["read-cache"]!.attemptedRps).toBeGreaterThan(0);
    expect(first.edgeMetrics["write-queue"]!.attemptedRps).toBeGreaterThan(0);
    expect(first.edgeMetrics["cache-db"]!.attemptedRps).toBeLessThan(
      first.edgeMetrics["read-cache"]!.attemptedRps * 0.25,
    );
    expect(first.nodeMetrics["write-api"]!.cpuUtilization).toBeGreaterThan(
      first.nodeMetrics["read-api"]!.cpuUtilization,
    );

    const directInput = scenario();
    directInput.workload.requestMix = [
      requestClass("Direct read", 1, [
        "users-router",
        "router-read",
        "read-direct-db",
      ]),
    ];
    const direct = simulate(directInput, model).frames[0]!;
    expect(direct.edgeMetrics["read-cache"]!.attemptedRps).toBe(0);
    expect(direct.nodeMetrics["read-db"]!.iopsUtilization).toBeGreaterThan(
      first.nodeMetrics["read-db"]!.iopsUtilization * 4,
    );
  });

  it("executes every edge in an explicit route even when legacy kind heuristics would omit it", () => {
    const explicitModel: Architecture = {
      schemaVersion: 1,
      id: "explicit-route",
      name: "Explicit route",
      nodes: [
        node("users", "users"),
        node("api", "api"),
        node("queue", "queue"),
      ],
      edges: [
        { id: "users-api", source: "users", target: "api" },
        { id: "api-queue", source: "api", target: "queue" },
      ],
    };
    const input = scenario();
    input.incidents = [];
    input.workload.requestMix = [
      requestClass("Explicit read route", 1, ["users-api", "api-queue"], {
        readRatio: 1,
        databaseQueries: 0,
        cacheable: false,
        route: {
          edgeIds: ["users-api", "api-queue"],
          terminalNodeId: "queue",
        },
      }),
    ];

    const result = simulate(input, explicitModel);
    expect(
      result.frames[0]!.edgeMetrics["api-queue"]!.attemptedRps,
    ).toBeGreaterThan(0);
    expect(result.frames[0]!.nodeMetrics.queue!.cpuUtilization).toBeGreaterThan(
      0,
    );
    expect(
      result.traces
        ?.flatMap((trace) => trace.spans)
        .some((span) => span.edgeId === "api-queue"),
    ).toBe(true);
  });

  it("rejects unknown, unreachable and disconnected request-class routes", () => {
    const unknownEntry = scenario();
    unknownEntry.workload.requestMix![0]!.entryNodeId = "missing";
    expect(() => simulate(unknownEntry, model)).toThrow(
      "invalid_scenario:request-class:0:unknown-entry:missing",
    );

    const unreachableEntry = scenario();
    unreachableEntry.workload.requestMix![0]!.entryNodeId = "orphan";
    delete unreachableEntry.workload.requestMix![0]!.route;
    expect(() => simulate(unreachableEntry, model)).toThrow(
      "invalid_scenario:request-class:0:unreachable-entry:orphan",
    );

    const unknownEdge = scenario();
    unknownEdge.workload.requestMix![0]!.route!.edgeIds![1] = "missing-edge";
    expect(() => simulate(unknownEdge, model)).toThrow(
      "invalid_scenario:request-class:0:unknown-route-edge:missing-edge",
    );

    const disconnected = scenario();
    disconnected.workload.requestMix![0]!.route!.edgeIds = [
      "users-router",
      "write-queue",
    ];
    expect(() => simulate(disconnected, model)).toThrow(
      "invalid_scenario:request-class:0:disconnected-route-edge:write-queue:router",
    );

    const terminalMismatch = scenario();
    terminalMismatch.workload.requestMix![0]!.route!.terminalNodeId = "worker";
    expect(() => simulate(terminalMismatch, model)).toThrow(
      "invalid_scenario:request-class:0:route-terminal-mismatch:read-db:worker",
    );

    const unknownTerminal = scenario();
    unknownTerminal.workload.requestMix![0]!.route = {
      terminalNodeId: "missing",
    };
    expect(() => simulate(unknownTerminal, model)).toThrow(
      "invalid_scenario:request-class:0:unknown-terminal:missing",
    );

    const unreachableTerminal = scenario();
    unreachableTerminal.workload.requestMix![0]!.route = {
      terminalNodeId: "orphan",
    };
    expect(() => simulate(unreachableTerminal, model)).toThrow(
      "invalid_scenario:request-class:0:unreachable-terminal:orphan",
    );
  });

  it("is deterministic and samples spans from the actually executed class edges", () => {
    const input = scenario();
    const first = simulate(input, model);
    const second = simulate(input, model);

    expect(first).toEqual(second);
    expect(first.traces).toBeDefined();
    expect(first.traces!.length).toBeLessThanOrEqual(16);
    expect(first.traces!.every((trace) => trace.spans.length <= 64)).toBe(true);

    const readTrace = first.traces!.find(
      (trace) => trace.requestClass === "Read path" && trace.second === 0,
    )!;
    const writeTrace = first.traces!.find(
      (trace) => trace.requestClass === "Write path" && trace.second === 0,
    )!;
    expect(
      readTrace.spans
        .filter((span) => span.kind === "edge")
        .map((span) => span.edgeId),
    ).toEqual(["users-router", "router-read", "read-cache", "cache-db"]);
    expect(
      writeTrace.spans
        .filter((span) => span.kind === "edge")
        .map((span) => span.edgeId),
    ).toEqual(["users-router", "router-write", "write-queue", "queue-worker"]);
    expect(readTrace.spans.some((span) => span.kind === "cache")).toBe(true);
    expect(writeTrace.spans.some((span) => span.kind === "async-queue")).toBe(
      true,
    );
    const databaseEdgeSpan = readTrace.spans.find(
      (span) => span.kind === "edge" && span.edgeId === "cache-db",
    )!;
    expect(databaseEdgeSpan.queryClass).toBe("read");
    expect(databaseEdgeSpan.connectionPoolWaitMs).toBeDefined();
    const enqueueSpan = writeTrace.spans.find(
      (span) => span.kind === "async-queue",
    )!;
    const queuedWorkSpan = writeTrace.spans.find(
      (span) => span.kind === "edge" && span.edgeId === "queue-worker",
    )!;
    expect(enqueueSpan.messageId).toBeDefined();
    expect(enqueueSpan.parentMessageId).toBeDefined();
    expect(queuedWorkSpan.messageId).toBe(enqueueSpan.messageId);
    expect(queuedWorkSpan.parentMessageId).toBe(enqueueSpan.parentMessageId);

    const retryTrace = first.traces!.find(
      (trace) => trace.requestClass === "Write path" && trace.second === 2,
    )!;
    const retrySpans = retryTrace.spans.filter(
      (span) => span.kind === "retry" && span.edgeId === "write-queue",
    );
    expect(retrySpans.map((span) => span.retryAttempt)).toEqual([1, 2]);
    expect(retrySpans[0]!.failureCause).toBe("target-offline");
    expect(retrySpans[1]!.parentSpanId).toBe(retrySpans[0]!.spanId);

    const constrainedPoolModel = structuredClone(model);
    const database = constrainedPoolModel.nodes.find(
      (candidate) => candidate.id === "read-db",
    )!;
    database.config.maxConnections = 1;
    database.config.baseLatencyMs = 50;
    const poolTrace = simulate(scenario(), constrainedPoolModel).traces!.find(
      (trace) => trace.requestClass === "Read path" && trace.second === 0,
    )!;
    expect(
      poolTrace.spans.find(
        (span) => span.kind === "edge" && span.edgeId === "cache-db",
      )!.connectionPoolWaitMs,
    ).toBeGreaterThan(0);
    for (const trace of [readTrace, writeTrace, retryTrace]) {
      const spanIds = new Set(trace.spans.map((span) => span.spanId));
      expect(
        trace.spans.every(
          (span) =>
            span.kind === "entry" ||
            (span.parentSpanId !== undefined && spanIds.has(span.parentSpanId)),
        ),
      ).toBe(true);
    }
  });
});
