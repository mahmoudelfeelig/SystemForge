// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  solveArchitecture,
} from "@systemforge/sim-core";

const solveArchitectureWithFallback = vi.fn();
vi.mock("../src/lib/solverGateway", () => ({
  solveArchitectureWithFallback,
}));

const { useLabStore } = await import("../src/store/useLabStore");
const result = solveArchitecture(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
  maxCandidates: 1,
});

afterEach(() => {
  vi.clearAllMocks();
  useLabStore.setState({
    scenario: structuredClone(DEFAULT_SCENARIO),
    architecture: structuredClone(DEFAULT_ARCHITECTURE),
    apiAvailability: "offline",
    role: "participant",
    solverResult: null,
    solverState: "idle",
    solverExecution: null,
    notice: null,
  });
});

describe("lab solver state", () => {
  it("records local fallback state without losing a completed comparison", async () => {
    solveArchitectureWithFallback.mockResolvedValue({
      execution: "local",
      result,
      fallbackReason: "Canonical solver capacity is busy.",
    });
    useLabStore.setState({ apiAvailability: "online" });

    await useLabStore.getState().solveAlternatives({ maxCandidates: 1 });

    expect(solveArchitectureWithFallback).toHaveBeenCalledWith(
      DEFAULT_SCENARIO,
      DEFAULT_ARCHITECTURE,
      { maxCandidates: 1, includeHiddenRequirements: false },
      true,
    );
    expect(useLabStore.getState()).toMatchObject({
      solverResult: result,
      solverState: "complete",
      solverExecution: "local",
    });
    expect(useLabStore.getState().notice).toContain("ran locally");
  });

  it("keeps private interviewer scoring in the local trust boundary", async () => {
    solveArchitectureWithFallback.mockResolvedValue({
      execution: "local",
      result,
    });
    useLabStore.setState({ apiAvailability: "online", role: "interviewer" });

    await useLabStore.getState().solveAlternatives({ maxCandidates: 1 });

    expect(solveArchitectureWithFallback).toHaveBeenCalledWith(
      DEFAULT_SCENARIO,
      DEFAULT_ARCHITECTURE,
      { maxCandidates: 1, includeHiddenRequirements: true },
      false,
    );
  });

  it("does not apply a result after the authored architecture changes", async () => {
    let release!: () => void;
    solveArchitectureWithFallback.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ execution: "local", result });
        }),
    );

    const pending = useLabStore
      .getState()
      .solveAlternatives({ maxCandidates: 1 });
    await vi.waitFor(() =>
      expect(solveArchitectureWithFallback).toHaveBeenCalledOnce(),
    );
    useLabStore
      .getState()
      .setArchitecture(structuredClone(DEFAULT_ARCHITECTURE));
    release();
    await pending;

    expect(useLabStore.getState()).toMatchObject({
      solverResult: null,
      solverState: "idle",
      solverExecution: null,
    });
  });
});
