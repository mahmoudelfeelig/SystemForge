import { DEFAULT_ARCHITECTURE } from "@systemforge/sim-core";
import { describe, expect, it } from "vitest";
import {
  autoLayoutArchitecture,
  blankArchitecture,
  connectArchitecture,
  duplicateArchitectureSelection,
  removeArchitectureElements,
  removeArchitectureNodes,
} from "../src/lib/architectureEditing";

describe("architecture editing", () => {
  it("appends a link without stripping existing transport configuration", () => {
    const architecture = structuredClone(DEFAULT_ARCHITECTURE);
    architecture.edges[0]!.config = {
      trafficShare: 0.42,
      baseLatencyMs: 17,
      asynchronous: true,
    };

    const next = connectArchitecture(
      architecture,
      { source: "users", target: "api" },
      () => "new",
    );

    expect(next.edges[0]).toEqual(architecture.edges[0]);
    expect(next.edges.at(-1)).toEqual({
      id: "edge-users-api-new",
      source: "users",
      target: "api",
    });
  });

  it("removes selected components and every connected link", () => {
    const next = removeArchitectureNodes(DEFAULT_ARCHITECTURE, ["api"]);

    expect(next.nodes.some((node) => node.id === "api")).toBe(false);
    expect(
      next.edges.some((edge) => edge.source === "api" || edge.target === "api"),
    ).toBe(false);
  });

  it("removes a mixed node and link selection in one architecture change", () => {
    const detachedEdge = DEFAULT_ARCHITECTURE.edges.find(
      (edge) => edge.source !== "api" && edge.target !== "api",
    )!;
    const next = removeArchitectureElements(
      DEFAULT_ARCHITECTURE,
      ["api"],
      [detachedEdge.id],
    );

    expect(next.nodes.some((node) => node.id === "api")).toBe(false);
    expect(next.edges.some((edge) => edge.id === detachedEdge.id)).toBe(false);
    expect(
      next.edges.some((edge) => edge.source === "api" || edge.target === "api"),
    ).toBe(false);
  });

  it("duplicates selected components and only their internal links", () => {
    let sequence = 0;
    const duplicated = duplicateArchitectureSelection(
      DEFAULT_ARCHITECTURE,
      ["users", "cdn"],
      () => `id-${sequence++}`,
    );

    expect(duplicated.selectedNodeIds).toEqual([
      "users-copy-id-0",
      "cdn-copy-id-1",
    ]);
    expect(duplicated.architecture.nodes).toHaveLength(
      DEFAULT_ARCHITECTURE.nodes.length + 2,
    );
    expect(
      duplicated.architecture.edges.find((edge) =>
        edge.id.startsWith("e-users-cdn-copy-"),
      ),
    ).toMatchObject({
      source: "users-copy-id-0",
      target: "cdn-copy-id-1",
    });
  });

  it("lays out reachable columns deterministically", () => {
    const first = autoLayoutArchitecture(DEFAULT_ARCHITECTURE);
    const second = autoLayoutArchitecture(DEFAULT_ARCHITECTURE);
    const users = first.nodes.find((node) => node.id === "users")!;
    const cdn = first.nodes.find((node) => node.id === "cdn")!;

    expect(first).toEqual(second);
    expect(cdn.position.x).toBeGreaterThan(users.position.x);
  });

  it("creates a truly blank, recoverable editor state", () => {
    const next = blankArchitecture(DEFAULT_ARCHITECTURE, "blank-draft");

    expect(next).toMatchObject({
      id: "blank-draft",
      name: "Untitled architecture",
      nodes: [],
      edges: [],
    });
  });
});
