import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  solveArchitecture,
} from "@systemforge/sim-core";
import { solveArchitectureWithFallback } from "../src/lib/solverGateway";

const result = solveArchitecture(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
  maxCandidates: 1,
});

describe("solver execution gateway", () => {
  it("uses the canonical solver when it is available", async () => {
    const canonical = vi.fn().mockResolvedValue({
      execution: "canonical" as const,
      result,
    });
    const local = vi.fn();

    await expect(
      solveArchitectureWithFallback(
        DEFAULT_SCENARIO,
        DEFAULT_ARCHITECTURE,
        { maxCandidates: 1 },
        true,
        { canonical, local },
      ),
    ).resolves.toEqual({ execution: "canonical", result });
    expect(local).not.toHaveBeenCalled();
  });

  it("falls back to a fully local solve when canonical capacity is unavailable", async () => {
    const canonical = vi
      .fn()
      .mockRejectedValue(new Error("Canonical solver capacity is busy."));
    const local = vi.fn().mockResolvedValue(result);

    await expect(
      solveArchitectureWithFallback(
        DEFAULT_SCENARIO,
        DEFAULT_ARCHITECTURE,
        { maxCandidates: 1 },
        true,
        { canonical, local },
      ),
    ).resolves.toEqual({
      execution: "local",
      result,
      fallbackReason: "Canonical solver capacity is busy.",
    });
    expect(local).toHaveBeenCalledOnce();
  });

  it("does not contact canonical services while release access is unavailable", async () => {
    const canonical = vi.fn();
    const local = vi.fn().mockResolvedValue(result);

    const solved = await solveArchitectureWithFallback(
      DEFAULT_SCENARIO,
      DEFAULT_ARCHITECTURE,
      { maxCandidates: 1 },
      false,
      { canonical, local },
    );

    expect(solved.execution).toBe("local");
    expect(canonical).not.toHaveBeenCalled();
  });
});
