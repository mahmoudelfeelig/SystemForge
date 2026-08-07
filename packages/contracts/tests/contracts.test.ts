import { describe, expect, it } from "vitest";
import { candidateScenario, scenarioSchema, type Scenario } from "../src/index";

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
  });
});
