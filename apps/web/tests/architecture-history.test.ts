// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ARCHITECTURE, DEFAULT_SCENARIO } from "@systemforge/sim-core";
import { useLabStore } from "../src/store/useLabStore";

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useLabStore.setState({
    scenario: structuredClone(DEFAULT_SCENARIO),
    architecture: structuredClone(DEFAULT_ARCHITECTURE),
    architectureUndo: [],
    architectureRedo: [],
    architectureSnapshots: [],
  });
});

describe("architecture history", () => {
  it("supports undo, redo, named snapshots, and candidate application", () => {
    const changed = structuredClone(DEFAULT_ARCHITECTURE);
    changed.name = "Scaled checkout";
    changed.nodes[3]!.config.instances += 4;

    useLabStore.getState().setArchitecture(changed);
    expect(useLabStore.getState().canUndo()).toBe(true);
    useLabStore.getState().undoArchitecture();
    expect(useLabStore.getState().architecture.name).toBe(
      DEFAULT_ARCHITECTURE.name,
    );
    useLabStore.getState().redoArchitecture();
    expect(useLabStore.getState().architecture.name).toBe("Scaled checkout");

    useLabStore.getState().saveArchitectureSnapshot("before launch");
    expect(useLabStore.getState().architectureSnapshots).toHaveLength(1);
    expect(
      JSON.parse(localStorage.getItem("systemforge:architecture-snapshots")!),
    ).toHaveLength(1);
  });
});
