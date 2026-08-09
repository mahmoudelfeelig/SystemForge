import { describe, expect, it } from "vitest";
import { DEFAULT_ARCHITECTURE, DEFAULT_SCENARIO } from "@systemforge/sim-core";
import { lintArchitecture } from "../src/lib/architectureLint";

describe("architecture graph lint", () => {
  it("accepts the seeded topology without blocking errors", () => {
    const issues = lintArchitecture(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("reports blank and unreachable drafts before a run", () => {
    const blank = lintArchitecture(DEFAULT_SCENARIO, {
      ...structuredClone(DEFAULT_ARCHITECTURE),
      nodes: [],
      edges: [],
    });
    expect(blank.map((issue) => issue.id)).toContain("empty-architecture");

    const architecture = structuredClone(DEFAULT_ARCHITECTURE);
    architecture.nodes.push({
      ...structuredClone(architecture.nodes[1]!),
      id: "orphan",
      name: "Orphan API",
    });
    expect(lintArchitecture(DEFAULT_SCENARIO, architecture)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "unreachable:orphan" }),
      ]),
    );
  });

  it("rejects impossible shares and invalid incident scopes", () => {
    const architecture = structuredClone(DEFAULT_ARCHITECTURE);
    const source = architecture.edges[0]!.source;
    architecture.edges.push({
      id: "overflow-route",
      source,
      target: architecture.edges[0]!.target,
      config: { trafficShare: 0.6 },
    });
    architecture.edges[0]!.config = { trafficShare: 0.7 };
    const scenario = structuredClone(DEFAULT_SCENARIO);
    scenario.incidents.push({
      id: "bad-scope",
      atSecond: 10,
      kind: "zone-outage",
      magnitude: 1,
      label: "Unknown zone outage",
      zone: "does-not-exist",
    });

    const issueIds = lintArchitecture(scenario, architecture).map(
      (issue) => issue.id,
    );
    expect(issueIds).toContain(`share-overflow:${source}`);
    expect(issueIds).toContain("incident-zone:bad-scope");
  });
});
