import type { Architecture } from "@systemforge/contracts";
import { describe, expect, it } from "vitest";
import {
  activeArchitecturePlacementGroupIds,
  architectureNodeDimensions,
  deriveArchitecturePlacementGroups,
} from "../src/lib/architecturePlacement";

const architecture: Architecture = {
  schemaVersion: 1,
  id: "placement-test",
  name: "Placement test",
  nodes: [
    {
      id: "api",
      kind: "api",
      name: "API",
      position: { x: 100, y: 80 },
      config: {
        instances: 1,
        capacityRps: 1_000,
        baseLatencyMs: 5,
        maxConnections: 1_000,
        cacheHitRate: 0,
        replicas: 0,
        monthlyCostEur: 10,
        autoscale: false,
        maxInstances: 1,
        consistency: "strong",
        behavior: {
          topology: { region: "EU", failureDomain: "compute-a" },
        },
      },
    },
    {
      id: "db",
      kind: "database",
      name: "Database",
      position: { x: 380, y: 220 },
      config: {
        instances: 1,
        capacityRps: 1_000,
        baseLatencyMs: 12,
        maxConnections: 1_000,
        cacheHitRate: 0,
        replicas: 1,
        monthlyCostEur: 40,
        autoscale: false,
        maxInstances: 1,
        consistency: "strong",
        behavior: {
          topology: { region: "EU", failureDomain: "data-a" },
        },
      },
    },
    {
      id: "cdn",
      kind: "cdn",
      name: "CDN",
      position: { x: -120, y: 20 },
      config: {
        instances: 1,
        capacityRps: 1_000,
        baseLatencyMs: 2,
        maxConnections: 1_000,
        cacheHitRate: 0.8,
        replicas: 0,
        monthlyCostEur: 5,
        autoscale: false,
        maxInstances: 1,
        consistency: "eventual",
        behavior: { topology: { region: "global" } },
      },
    },
  ],
  edges: [],
};

describe("architecture placement groups", () => {
  it("derives stable region bounds without changing node coordinates", () => {
    const groups = deriveArchitecturePlacementGroups(architecture, "region");

    expect(groups.map(({ label }) => label)).toEqual(["EU", "global"]);
    expect(groups[0]).toEqual({
      id: "region:EU",
      scope: "region",
      label: "EU",
      nodeIds: ["api", "db"],
      bounds: { x: 70, y: 44, width: 560, height: 318 },
    });
    expect(architecture.nodes.map(({ position }) => position)).toEqual([
      { x: 100, y: 80 },
      { x: 380, y: 220 },
      { x: -120, y: 20 },
    ]);
  });

  it("keeps failure-domain overlays separate from regional grouping", () => {
    expect(
      deriveArchitecturePlacementGroups(architecture, "failure-domain").map(
        ({ label, nodeIds }) => ({ label, nodeIds }),
      ),
    ).toEqual([
      { label: "compute-a", nodeIds: ["api"] },
      { label: "data-a", nodeIds: ["db"] },
    ]);
  });

  it("uses the same node dimensions as the topology renderer", () => {
    expect(architectureNodeDimensions("users")).toEqual({
      width: 142,
      height: 112,
    });
    expect(architectureNodeDimensions("database")).toEqual({
      width: 220,
      height: 118,
    });
  });

  it("highlights only placement incidents active at the modeled cursor", () => {
    const incidents = [
      {
        id: "eu-outage",
        atSecond: 10,
        durationSeconds: 4,
        kind: "region-outage" as const,
        magnitude: 1,
        label: "EU outage",
        region: "EU",
      },
      {
        id: "data-partition",
        atSecond: 12,
        durationSeconds: 2,
        kind: "network-partition" as const,
        magnitude: 1,
        label: "Data partition",
        failureDomain: "data-a",
      },
    ];

    expect([
      ...activeArchitecturePlacementGroupIds(incidents, 12, 120),
    ]).toEqual(["region:EU", "failure-domain:data-a"]);
    expect(activeArchitecturePlacementGroupIds(incidents, 14, 120).size).toBe(
      0,
    );
  });

  it("uses the engine's default incident lifetime for placement highlights", () => {
    const incident = {
      id: "default-region-outage",
      atSecond: 20,
      kind: "region-outage" as const,
      magnitude: 1,
      label: "EU outage",
      region: "EU",
    };

    expect(
      activeArchitecturePlacementGroupIds([incident], 49, 120).has("region:EU"),
    ).toBe(true);
    expect(activeArchitecturePlacementGroupIds([incident], 50, 120).size).toBe(
      0,
    );
  });
});
