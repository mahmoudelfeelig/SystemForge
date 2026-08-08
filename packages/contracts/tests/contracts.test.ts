import { describe, expect, it } from "vitest";
import {
  architectureSchema,
  candidateScenario,
  INCIDENT_KINDS,
  scenarioSchema,
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
  it("rejects regional traffic shares that do not total one", () => {
    const invalid = structuredClone(interviewScenario);
    invalid.workload.regions[0]!.trafficShare = 0.7;
    expect(scenarioSchema.safeParse(invalid).success).toBe(false);
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
      magnitude: 1.5,
      durationSeconds: 5,
      label: kind,
    }));

    expect(scenarioSchema.safeParse(scenario).success).toBe(true);
    scenario.workload.requestMix[0]!.share = 0.5;
    expect(scenarioSchema.safeParse(scenario).success).toBe(false);
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
