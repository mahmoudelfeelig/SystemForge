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
    architectureRevision: 0,
    transientArchitectureUpdate: null,
    result: null,
    runState: "idle",
    notice: null,
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

  it("coalesces transient architecture updates into one persisted undo step", () => {
    const first = structuredClone(DEFAULT_ARCHITECTURE);
    first.nodes[0]!.position.x += 20;
    const second = structuredClone(first);
    second.nodes[0]!.position.x += 30;

    useLabStore.getState().setArchitectureTransient(first);
    useLabStore.getState().setArchitectureTransient(second);

    expect(useLabStore.getState()).toMatchObject({
      architecture: second,
      architectureUndo: [],
      transientArchitectureUpdate: { updateCount: 2 },
      result: null,
      runState: "idle",
    });
    expect(localStorage.getItem("systemforge:draft")).toBeNull();

    useLabStore.getState().commitArchitectureTransient();

    expect(useLabStore.getState()).toMatchObject({
      architecture: second,
      transientArchitectureUpdate: null,
      notice: null,
    });
    expect(useLabStore.getState().architectureUndo).toEqual([
      DEFAULT_ARCHITECTURE,
    ]);
    expect(
      JSON.parse(localStorage.getItem("systemforge:draft")!).architecture,
    ).toEqual(second);

    useLabStore.getState().undoArchitecture();
    expect(useLabStore.getState().architecture).toEqual(DEFAULT_ARCHITECTURE);
  });
});
