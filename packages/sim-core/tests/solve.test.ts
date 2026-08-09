import { describe, expect, it } from "vitest";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  estimateSolverWorkUnits,
  solveArchitecture,
} from "../src/index";

describe("bounded architecture solver", () => {
  it("is deterministic, bounded, ranked, and does not mutate caller inputs", () => {
    const scenario = structuredClone(DEFAULT_SCENARIO);
    const architecture = structuredClone(DEFAULT_ARCHITECTURE);
    const scenarioBefore = structuredClone(scenario);
    const architectureBefore = structuredClone(architecture);
    const options = { maxCandidates: 12 as const };

    const first = solveArchitecture(scenario, architecture, options);
    const second = solveArchitecture(scenario, architecture, options);

    expect(first).toEqual(second);
    expect(scenario).toEqual(scenarioBefore);
    expect(architecture).toEqual(architectureBefore);
    expect(first.engineVersion).toBe("0.7.0");
    expect(first.solverVersion).toBe("0.1.0");
    expect(first.exploredCandidates).toBeLessThanOrEqual(12);
    expect(first.candidates.map((candidate) => candidate.rank)).toEqual(
      first.candidates.map((_, index) => index + 1),
    );
    expect(
      first.candidates.every((candidate) => candidate.changes.length <= 2),
    ).toBe(true);
    expect(first.paretoFrontierIds.length).toBeGreaterThan(0);
  });

  it("finds modeled resilience or requirement gains in a fragile design", () => {
    const scenario = structuredClone(DEFAULT_SCENARIO);
    scenario.incidents = [
      {
        id: "solver-ddos",
        atSecond: 10,
        kind: "ddos",
        magnitude: 6,
        durationSeconds: 45,
        label: "Untrusted edge flood",
      },
      {
        id: "solver-db-loss",
        atSecond: 30,
        kind: "node-failure",
        magnitude: 1,
        durationSeconds: 20,
        targetId: "db",
        label: "Primary database loss",
      },
    ];
    scenario.workload.durationSeconds = 70;
    const architecture = structuredClone(DEFAULT_ARCHITECTURE);
    for (const node of architecture.nodes) {
      if (
        node.kind === "cdn" ||
        node.kind === "load-balancer" ||
        node.kind === "api"
      ) {
        node.config.behavior = {
          ...node.config.behavior,
          resilience: {
            ...node.config.behavior?.resilience,
            maxRetries: 8,
            backoffBaseMs: 0,
            jitter: false,
            circuitBreaker: false,
            loadSheddingThreshold: undefined,
            bulkhead: false,
          },
        };
      }
    }
    const database = architecture.nodes.find((node) => node.id === "db")!;
    database.config.replicas = 0;
    database.config.behavior = {
      ...database.config.behavior,
      storage: {
        ...database.config.behavior?.storage,
        replicationMode: "none",
      },
      topology: {
        ...database.config.behavior?.topology,
        zone: "single-az",
      },
    };

    const solved = solveArchitecture(scenario, architecture, {
      maxCandidates: 30,
      allowedStrategies: [
        "resilience-controls",
        "durable-replication",
        "horizontal-scale",
      ],
      weights: { requirements: 0.65, resilience: 0.3, cost: 0.05 },
    });

    expect(
      solved.candidates.some(
        (candidate) =>
          candidate.deltas.requirementsPassed > 0 ||
          candidate.deltas.resilienceFitness > 0,
      ),
    ).toBe(true);
    expect(
      solved.candidates.some((candidate) =>
        candidate.changes.some(
          (change) => change.strategy === "durable-replication",
        ),
      ),
    ).toBe(true);
    expect(solved.recommendedCandidateId).toBeTruthy();
  });

  it("keeps hidden interview requirements out unless a trusted caller opts in", () => {
    const scenario = structuredClone(DEFAULT_SCENARIO);
    scenario.mode = "interview";
    scenario.interview = {
      candidateBrief:
        "Design a checkout path and derive the missing constraints.",
      interviewerBrief: "Look for acknowledged-write durability.",
      timeboxMinutes: 45,
      allowCandidateRequirements: true,
      revealPolicy: "interviewer-controlled",
    };
    scenario.requirements[0] = {
      ...scenario.requirements[0]!,
      visibility: "hidden",
      owner: "interviewer",
    };

    const participant = solveArchitecture(scenario, DEFAULT_ARCHITECTURE, {
      maxCandidates: 2,
      maxChangesPerCandidate: 1,
    });
    const interviewer = solveArchitecture(scenario, DEFAULT_ARCHITECTURE, {
      maxCandidates: 2,
      maxChangesPerCandidate: 1,
      includeHiddenRequirements: true,
    });

    expect(participant.excludedHiddenRequirementCount).toBe(1);
    expect(participant.baseline.metrics.requirementsTotal).toBe(
      scenario.requirements.length - 1,
    );
    expect(
      participant.baseline.requirements.some(
        (result) => result.requirement.visibility === "hidden",
      ),
    ).toBe(false);
    expect(interviewer.excludedHiddenRequirementCount).toBe(0);
    expect(interviewer.baseline.metrics.requirementsTotal).toBe(
      scenario.requirements.length,
    );
  });

  it("respects locked components and explicit strategy boundaries", () => {
    const solved = solveArchitecture(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
      maxCandidates: 20,
      maxChangesPerCandidate: 1,
      allowedStrategies: ["horizontal-scale"],
      lockedNodeIds: ["api", "db"],
    });

    expect(solved.candidates.length).toBeGreaterThan(0);
    expect(
      solved.candidates.every((candidate) =>
        candidate.changes.every(
          (change) =>
            !change.nodeIds.includes("api") && !change.nodeIds.includes("db"),
        ),
      ),
    ).toBe(true);
    expect(
      solved.candidates.every((candidate) =>
        candidate.changes.every(
          (change) => change.strategy === "horizontal-scale",
        ),
      ),
    ).toBe(true);
  });

  it("marks candidates outside hard cost ceilings as ineligible", () => {
    const solved = solveArchitecture(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
      maxCandidates: 20,
      maxChangesPerCandidate: 1,
      allowedStrategies: ["horizontal-scale"],
      maximumMonthlyCostEur: 0,
    });

    expect(solved.candidates.length).toBeGreaterThan(0);
    expect(solved.baseline.eligible).toBe(false);
    expect(solved.baseline.constraintViolations).toHaveLength(1);
    expect(solved.candidates.every((candidate) => !candidate.eligible)).toBe(
      true,
    );
    expect(
      solved.candidates.every(
        (candidate) => candidate.constraintViolations.length === 1,
      ),
    ).toBe(true);
    expect(solved.recommendedCandidateId).toBeUndefined();
  });

  it("truncates safely at the work budget and rejects an oversized baseline", () => {
    const baselineUnits = estimateSolverWorkUnits(
      DEFAULT_SCENARIO,
      DEFAULT_ARCHITECTURE,
      0,
    );
    const baselineOnly = solveArchitecture(
      DEFAULT_SCENARIO,
      DEFAULT_ARCHITECTURE,
      {
        maxCandidates: 10,
        workUnitBudget: baselineUnits,
      },
    );

    expect(baselineOnly.exploredCandidates).toBe(0);
    expect(baselineOnly.candidates).toEqual([]);
    expect(baselineOnly.truncated).toBe(true);
    expect(() =>
      solveArchitecture(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
        maxCandidates: 1,
        workUnitBudget: baselineUnits - 1,
      }),
    ).toThrow(/baseline alone requires/i);
  });

  it("rejects invalid configuration instead of silently widening scope", () => {
    expect(() =>
      solveArchitecture(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
        maxCandidates: 65,
      }),
    ).toThrow(/maxCandidates/);
    expect(() =>
      solveArchitecture(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
        lockedNodeIds: ["missing-node"],
      }),
    ).toThrow(/does not exist/);
    expect(() =>
      solveArchitecture(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
        weights: {
          requirements: 0,
          resilience: 0,
          latency: 0,
          cost: 0,
          complexity: 0,
        },
      }),
    ).toThrow(/at least one solver weight/i);
  });
});
