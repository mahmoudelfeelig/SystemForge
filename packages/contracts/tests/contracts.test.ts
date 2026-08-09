import { describe, expect, it } from "vitest";
import {
  analyzeTopologyExecutionBounds,
  architectureDraftSchema,
  architectureSchema,
  behavioralProfileReferenceSchema,
  candidateScenario,
  componentOwnsState,
  componentUsesReadConsistency,
  INCIDENT_KINDS,
  incidentUsesMagnitude,
  MAX_GENERATED_INCIDENTS,
  MAX_STOCHASTIC_INCIDENT_RULES,
  runSubmissionSchema,
  scenarioSchema,
  simulationActionScheduleSchema,
  type EdgeMetricSnapshot,
  type MetricFrame,
  type SampledTrace,
  type Scenario,
} from "../src/index";

const interviewScenario: Scenario = {
  schemaVersion: 1,
  id: "interview-orders",
  title: "Order platform interview",
  summary: "Derive and design a reliable ordering system.",
  mode: "interview",
  seed: 19,
  workload: {
    baseRps: 1_000,
    peakRps: 5_000,
    readRatio: 0.7,
    durationSeconds: 600,
    regions: [{ name: "EU", trafficShare: 1, roundTripMs: 20 }],
  },
  requirements: [
    {
      id: "hidden-loss",
      label: "No confirmed order loss",
      metric: "dataLoss",
      operator: "eq",
      target: 0,
      unit: "orders",
      visibility: "hidden",
      owner: "interviewer",
    },
  ],
  incidents: [],
  interview: {
    candidateBrief: "Design the checkout path.",
    interviewerBrief: "Probe durability assumptions.",
    timeboxMinutes: 45,
    allowCandidateRequirements: true,
    revealPolicy: "interviewer-controlled",
  },
};

describe("scenario contracts", () => {
  it("defines state capabilities without narrowing legacy node configs", () => {
    expect(
      (["cache", "database", "object-store", "queue", "stream"] as const).every(
        componentOwnsState,
      ),
    ).toBe(true);
    expect(
      (["users", "cdn", "load-balancer", "api", "worker"] as const).some(
        componentOwnsState,
      ),
    ).toBe(false);
    expect(componentUsesReadConsistency("database")).toBe(true);
    expect(componentUsesReadConsistency("cache")).toBe(false);
    expect(componentUsesReadConsistency("object-store")).toBe(false);
    expect(componentUsesReadConsistency("queue")).toBe(false);
    expect(componentUsesReadConsistency("api")).toBe(false);

    const legacyStatelessConfig = architectureSchema.parse({
      schemaVersion: 1,
      id: "legacy-stateless-replica-config",
      name: "Legacy stateless replica config",
      nodes: [
        {
          id: "api",
          kind: "api",
          name: "API",
          position: { x: 0, y: 0 },
          config: {
            capacityRps: 1_000,
            baseLatencyMs: 5,
            replicas: 3,
            consistency: "eventual",
          },
        },
      ],
      edges: [],
    });

    expect(legacyStatelessConfig.nodes[0]?.config).toMatchObject({
      replicas: 3,
      consistency: "eventual",
    });
  });

  it("accepts optional versioned profile references without changing legacy drafts", () => {
    expect(
      behavioralProfileReferenceSchema.safeParse({
        id: "aws.rds-postgresql.db-r7g-large",
        version: 1,
      }).success,
    ).toBe(true);
    expect(
      behavioralProfileReferenceSchema.safeParse({
        id: "AWS RDS latest",
        version: 1,
      }).success,
    ).toBe(false);

    const legacy = {
      schemaVersion: 1 as const,
      id: "legacy-profile-free",
      name: "Legacy profile-free architecture",
      nodes: [
        {
          id: "db",
          kind: "database" as const,
          name: "Database",
          position: { x: 0, y: 0 },
          config: { capacityRps: 1_000, baseLatencyMs: 5 },
        },
      ],
      edges: [],
    };
    const parsed = architectureSchema.parse(legacy);

    expect(parsed.nodes[0]?.config.behavioralProfile).toBeUndefined();
  });

  it("exposes modeled per-edge path telemetry on metric frames", () => {
    const edgeMetric: EdgeMetricSnapshot = {
      attemptedRps: 100,
      throughputRps: 95,
      retryRps: 10,
      lostRps: 5,
      packetLossPercent: 5,
      latencyMs: 18,
      asynchronous: true,
    };
    const framePathMetrics: Pick<MetricFrame, "edgeMetrics"> = {
      edgeMetrics: { "api-queue": edgeMetric },
    };

    expect(framePathMetrics.edgeMetrics["api-queue"]).toEqual(edgeMetric);
  });

  it("types bounded sampled traces with explicit parent span identifiers", () => {
    const trace: SampledTrace = {
      traceId: "trace-1",
      second: 0,
      requestClass: "Write",
      modeledRps: 100,
      entryNodeId: "api",
      terminalNodeId: "queue",
      truncated: false,
      spans: [
        {
          spanId: "entry",
          kind: "entry",
          name: "Enter api",
          nodeId: "api",
          attemptedRps: 100,
          throughputRps: 100,
          retryRps: 0,
          lostRps: 0,
          latencyMs: 0,
          asynchronous: false,
          status: "ok",
        },
        {
          spanId: "edge",
          parentSpanId: "entry",
          kind: "async-queue",
          name: "Enqueue",
          edgeId: "api-queue",
          attemptedRps: 100,
          throughputRps: 100,
          retryRps: 0,
          lostRps: 0,
          latencyMs: 4,
          retryAttempt: 1,
          queryClass: "write",
          messageId: "message-1",
          parentMessageId: "request-1",
          connectionPoolWaitMs: 12,
          failureCause: "capacity-pressure",
          asynchronous: true,
          status: "ok",
        },
      ],
    };

    expect(trace.spans[1]!.parentSpanId).toBe("entry");
    expect(trace.spans[1]).toMatchObject({
      retryAttempt: 1,
      queryClass: "write",
      messageId: "message-1",
      parentMessageId: "request-1",
      connectionPoolWaitMs: 12,
      failureCause: "capacity-pressure",
    });
  });

  it("rejects regional traffic shares that do not total one", () => {
    const invalid = structuredClone(interviewScenario);
    invalid.workload.regions[0]!.trafficShare = 0.7;
    expect(scenarioSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects duplicate workload-region and authored-incident identifiers", () => {
    const duplicateRegions = structuredClone(interviewScenario);
    duplicateRegions.workload.regions = [
      { name: "EU", trafficShare: 0.5, roundTripMs: 20 },
      { name: " eu ", trafficShare: 0.5, roundTripMs: 30 },
    ];
    expect(scenarioSchema.safeParse(duplicateRegions).success).toBe(false);

    const duplicateIncidents = structuredClone(interviewScenario);
    duplicateIncidents.incidents = [
      {
        id: "duplicate",
        atSecond: 1,
        kind: "traffic-spike",
        magnitude: 2,
        label: "First",
      },
      {
        id: "duplicate",
        atSecond: 2,
        kind: "traffic-spike",
        magnitude: 3,
        label: "Second",
      },
    ];
    expect(scenarioSchema.safeParse(duplicateIncidents).success).toBe(false);
  });

  it("requires truthful binary incident magnitudes and physical outage scopes", () => {
    const invalidMagnitude = structuredClone(interviewScenario);
    invalidMagnitude.incidents = [
      {
        id: "oversold-node-failure",
        atSecond: 1,
        kind: "node-failure",
        magnitude: 100,
        targetId: "db",
        label: "Node failure",
      },
    ];
    expect(scenarioSchema.safeParse(invalidMagnitude).success).toBe(false);

    const missingNode = structuredClone(interviewScenario);
    missingNode.incidents = [
      {
        id: "unscoped-node-failure",
        atSecond: 1,
        kind: "node-failure",
        magnitude: 1,
        label: "Node failure",
      },
    ];
    expect(scenarioSchema.safeParse(missingNode).success).toBe(false);

    const missingZone = structuredClone(interviewScenario);
    missingZone.incidents = [
      {
        id: "unscoped-zone-outage",
        atSecond: 1,
        kind: "zone-outage",
        magnitude: 1,
        label: "Zone outage",
      },
    ];
    expect(scenarioSchema.safeParse(missingZone).success).toBe(false);

    const missingRegion = structuredClone(interviewScenario);
    missingRegion.incidents = [
      {
        id: "unscoped-region-outage",
        atSecond: 1,
        kind: "region-outage",
        magnitude: 1,
        label: "Region outage",
      },
    ];
    expect(scenarioSchema.safeParse(missingRegion).success).toBe(false);
  });

  it("detects cycles returning to explicit sources and structural fan-out", () => {
    const baseNode = (id: string, kind: "users" | "api") => ({
      id,
      kind,
      name: id,
      position: { x: 0, y: 0 },
      config: { capacityRps: 1_000, baseLatencyMs: 1 },
    });
    const cyclic = architectureSchema.parse({
      schemaVersion: 1,
      id: "cycle",
      name: "Cycle",
      nodes: [baseNode("users", "users"), baseNode("api", "api")],
      edges: [
        { id: "users-api", source: "users", target: "api" },
        { id: "api-users", source: "api", target: "users" },
      ],
    });
    const fanout = architectureSchema.parse({
      schemaVersion: 1,
      id: "fanout",
      name: "Fanout",
      nodes: [baseNode("users", "users"), baseNode("api", "api")],
      edges: Array.from({ length: 4 }, (_, index) => ({
        id: `edge-${index}`,
        source: "users",
        target: "api",
      })),
    });

    expect(
      analyzeTopologyExecutionBounds(cyclic).reachableCycleNodeIds,
    ).toEqual(expect.arrayContaining(["users", "api"]));
    expect(analyzeTopologyExecutionBounds(fanout).fanoutAmplification).toBe(4);
  });

  it("removes interviewer-only material from the candidate view", () => {
    const candidate = candidateScenario(interviewScenario);
    expect(candidate.requirements).toEqual([]);
    expect(candidate.interview?.interviewerBrief).toBe("");

    const revealed = candidateScenario(interviewScenario, true);
    expect(revealed.requirements).toEqual([
      expect.objectContaining({ id: "hidden-loss", visibility: "public" }),
    ]);
    expect(revealed.interview?.interviewerBrief).toBe("");
  });

  it("rejects hidden material outside interviews and mismatched derived ownership", () => {
    const custom = structuredClone(interviewScenario);
    custom.mode = "custom";
    delete custom.interview;
    expect(scenarioSchema.safeParse(custom).success).toBe(false);

    const mismatched = structuredClone(interviewScenario);
    mismatched.requirements[0] = {
      ...mismatched.requirements[0]!,
      visibility: "derived",
      owner: "interviewer",
    };
    expect(scenarioSchema.safeParse(mismatched).success).toBe(false);
  });

  it("rejects and defensively strips interview configuration outside interview mode", () => {
    const customWithPrivateInterview = structuredClone(interviewScenario);
    customWithPrivateInterview.mode = "custom";
    customWithPrivateInterview.requirements = [];

    expect(scenarioSchema.safeParse(customWithPrivateInterview)).toMatchObject({
      success: false,
      error: {
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["interview"] }),
        ]),
      },
    });
    expect(
      candidateScenario(customWithPrivateInterview).interview,
    ).toBeUndefined();
  });

  it("validates the complete incident vocabulary and custom workload mix", () => {
    const scenario = structuredClone(interviewScenario);
    scenario.workload.requestMix = [
      {
        name: "Reads",
        share: 0.7,
        readRatio: 1,
        payloadKb: 12,
        computeMs: 3,
        databaseQueries: 1,
        cacheable: true,
        critical: false,
      },
      {
        name: "Writes",
        share: 0.3,
        readRatio: 0,
        payloadKb: 6,
        computeMs: 8,
        databaseQueries: 3,
        cacheable: false,
        critical: true,
      },
    ];
    scenario.incidents = INCIDENT_KINDS.map((kind, index) => ({
      id: `incident-${index}`,
      atSecond: index,
      kind,
      magnitude: incidentUsesMagnitude(kind) ? 1.5 : 1,
      durationSeconds: 5,
      label: kind,
      ...(kind === "node-failure" ? { targetId: "db" } : {}),
      ...(kind === "zone-outage" ? { zone: "eu-1a" } : {}),
      ...(kind === "region-outage" ? { region: "EU" } : {}),
    }));

    expect(scenarioSchema.safeParse(scenario).success).toBe(true);
    scenario.workload.requestMix[0]!.share = 0.5;
    expect(scenarioSchema.safeParse(scenario).success).toBe(false);
  });

  it("bounds stochastic incident rules, triggers, and unique identifiers", () => {
    const scenario = structuredClone(interviewScenario);
    scenario.stochasticIncidents = {
      enabled: true,
      maxGeneratedIncidents: 8,
      rules: [
        {
          id: "database-pressure",
          enabled: true,
          kind: "database-degradation",
          label: "Seeded database pressure",
          hazardRatePerSecond: 0.25,
          cooldownSeconds: 10,
          maxOccurrences: 3,
          magnitude: 2,
          durationSeconds: 8,
          scope: {
            failureDomain: "orders-primary",
            correlated: true,
          },
          trigger: {
            metric: "p95LatencyMs",
            operator: "gte",
            threshold: 250,
          },
        },
      ],
    };

    expect(scenarioSchema.safeParse(scenario).success).toBe(true);

    scenario.stochasticIncidents.rules.push({
      ...structuredClone(scenario.stochasticIncidents.rules[0]!),
    });
    expect(scenarioSchema.safeParse(scenario).success).toBe(false);

    scenario.stochasticIncidents.rules[1]!.id = "other-rule";
    scenario.stochasticIncidents.rules[1]!.trigger = {
      metric: "availability",
      operator: "lte",
      threshold: 100.01,
    };
    expect(scenarioSchema.safeParse(scenario).success).toBe(false);

    scenario.stochasticIncidents.maxGeneratedIncidents =
      MAX_GENERATED_INCIDENTS + 1;
    expect(scenarioSchema.safeParse(scenario).success).toBe(false);

    scenario.stochasticIncidents.maxGeneratedIncidents = 8;
    scenario.stochasticIncidents.rules = Array.from(
      { length: MAX_STOCHASTIC_INCIDENT_RULES + 1 },
      (_, index) => ({
        ...structuredClone(scenario.stochasticIncidents!.rules[0]!),
        id: `rule-${index}`,
        trigger: undefined,
      }),
    );
    expect(scenarioSchema.safeParse(scenario).success).toBe(false);
  });

  it("accepts compatible request-class entry and route constraints", () => {
    const scenario = structuredClone(interviewScenario);
    scenario.workload.requestMix = [
      {
        name: "Checkout",
        share: 1,
        readRatio: 0.2,
        payloadKb: 12,
        computeMs: 8,
        databaseQueries: 3,
        cacheable: false,
        critical: true,
        entryNodeId: "users",
        route: {
          edgeIds: ["users-api", "api-db"],
          terminalNodeId: "db",
        },
      },
    ];
    expect(scenarioSchema.safeParse(scenario).success).toBe(true);

    scenario.workload.requestMix[0]!.route = {};
    expect(scenarioSchema.safeParse(scenario).success).toBe(false);

    scenario.workload.requestMix[0]!.route = {
      edgeIds: ["users-api", "users-api"],
    };
    expect(scenarioSchema.safeParse(scenario).success).toBe(false);
  });

  it("bounds deterministic simulation action schedules and payloads", () => {
    const action = {
      type: "apply-intervention" as const,
      id: "scale-api",
      atSecond: 8,
      nodeId: "api",
      intervention: { kind: "scale" as const, instances: 4 },
    };
    expect(simulationActionScheduleSchema.safeParse([action]).success).toBe(
      true,
    );
    expect(
      simulationActionScheduleSchema.safeParse([
        action,
        { ...action, intervention: { kind: "scale", instances: 10_001 } },
      ]).success,
    ).toBe(false);
    expect(
      simulationActionScheduleSchema.safeParse(
        Array.from({ length: 65 }, (_, index) => ({
          ...action,
          id: `scale-${index}`,
        })),
      ).success,
    ).toBe(false);
    expect(
      simulationActionScheduleSchema.safeParse([
        action,
        { ...action, nodeId: "worker" },
      ]).success,
    ).toBe(false);
  });

  it("rejects dangling architecture edges and duplicate identifiers", () => {
    const architecture = {
      schemaVersion: 1 as const,
      id: "invalid-graph",
      name: "Invalid graph",
      nodes: [
        {
          id: "api",
          kind: "api" as const,
          name: "API",
          position: { x: 0, y: 0 },
          config: {
            instances: 1,
            capacityRps: 1_000,
            baseLatencyMs: 5,
            maxConnections: 100,
            cacheHitRate: 0,
            replicas: 0,
            monthlyCostEur: 10,
            autoscale: false,
            maxInstances: 1,
            consistency: "strong" as const,
          },
        },
      ],
      edges: [{ id: "edge", source: "api", target: "missing" }],
    };

    expect(architectureSchema.safeParse(architecture).success).toBe(false);
  });

  it("accepts a blank editor draft without making it runnable", () => {
    const blankArchitecture = {
      schemaVersion: 1 as const,
      id: "blank-editor",
      name: "Blank editor",
      nodes: [],
      edges: [],
    };

    expect(architectureDraftSchema.safeParse(blankArchitecture).success).toBe(
      true,
    );
    expect(architectureSchema.safeParse(blankArchitecture).success).toBe(false);
    expect(
      runSubmissionSchema.safeParse({
        scenario: interviewScenario,
        architecture: blankArchitecture,
        clientEngineVersion: "test",
      }).success,
    ).toBe(false);
  });

  it("rejects contradictory scaling bounds", () => {
    const architecture = {
      schemaVersion: 1 as const,
      id: "invalid-scaling",
      name: "Invalid scaling",
      nodes: [
        {
          id: "api",
          kind: "api" as const,
          name: "API",
          position: { x: 0, y: 0 },
          config: {
            instances: 4,
            capacityRps: 1_000,
            baseLatencyMs: 5,
            maxInstances: 2,
            behavior: { scaling: { minInstances: 3 } },
          },
        },
      ],
      edges: [],
    };

    const result = architectureSchema.safeParse(architecture);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          "Maximum instances cannot be lower than active instances.",
          "Minimum instances cannot exceed maximum instances.",
        ]),
      );
  });
});
