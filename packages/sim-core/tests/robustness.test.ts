import { describe, expect, it } from "vitest";
import {
  analyzeRobustness,
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
} from "../src/index";

describe("multi-seed robustness analysis", () => {
  it("summarizes deterministic seed variance without mutating inputs", () => {
    const scenario = structuredClone(DEFAULT_SCENARIO);
    const architecture = structuredClone(DEFAULT_ARCHITECTURE);
    const before = structuredClone(scenario);

    const first = analyzeRobustness(scenario, architecture, {
      seedCount: 7,
      seedStride: 17,
    });
    const second = analyzeRobustness(scenario, architecture, {
      seedCount: 7,
      seedStride: 17,
    });

    expect(first).toEqual(second);
    expect(first.seeds).toHaveLength(7);
    expect(first.metrics.p95LatencyMs.p95).toBeGreaterThanOrEqual(
      first.metrics.p95LatencyMs.median,
    );
    expect(first.requirementPassRate).toBeGreaterThanOrEqual(0);
    expect(first.requirementPassRate).toBeLessThanOrEqual(1);
    expect(scenario).toEqual(before);
  });

  it("rejects an unbounded seed request", () => {
    expect(() =>
      analyzeRobustness(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
        seedCount: 65,
      }),
    ).toThrow(/seedCount/i);
  });
});
