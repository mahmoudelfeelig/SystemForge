import { describe, expect, it } from "vitest";
import { DEFAULT_ARCHITECTURE, DEFAULT_SCENARIO, simulate } from "../src/index";

describe("deterministic simulation", () => {
  it("produces identical results for the same seed and inputs", () => {
    expect(simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE)).toEqual(
      simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE),
    );
  });

  it("derives database overload and retry amplification from a cache failure", () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const cacheFailure = result.events.find(
      (event) => event.kind === "cache-miss-collapse",
    );
    const databaseOverload = result.events.find(
      (event) => event.title === "Database capacity exceeded",
    );
    const retryStorm = result.events.find(
      (event) => event.kind === "retry-storm",
    );
    expect(cacheFailure).toBeDefined();
    expect(databaseOverload?.parentIds).toContain(cacheFailure?.id);
    expect(retryStorm).toBeDefined();
    expect(result.frames.some((frame) => frame.retryAmplification > 1)).toBe(
      true,
    );
  });

  it("does not mutate caller-owned inputs", () => {
    const architectureBefore = structuredClone(DEFAULT_ARCHITECTURE);
    const scenarioBefore = structuredClone(DEFAULT_SCENARIO);
    simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    expect(DEFAULT_ARCHITECTURE).toEqual(architectureBefore);
    expect(DEFAULT_SCENARIO).toEqual(scenarioBefore);
  });
});
