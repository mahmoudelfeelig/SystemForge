import { describe, expect, it } from "vitest";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  simulate,
  solveArchitecture,
} from "../src";

describe("simulation performance budget", () => {
  it("completes 250 queue-aware simulations within 3.5 seconds", () => {
    // Keep this throughput budget independent from one-time V8 compilation.
    // Browser build and smoke checks cover cold application startup separately.
    for (let iteration = 0; iteration < 100; iteration += 1) {
      simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
        includeTraces: false,
      });
    }
    const startedAt = performance.now();
    for (let iteration = 0; iteration < 250; iteration += 1) {
      simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
        includeTraces: false,
      });
    }
    const elapsedMs = performance.now() - startedAt;

    // The queue-aware engine evaluates G/G/c wait, FIFO cohorts, and dynamic
    // admission for every modeled node and second. Keep the batch below 14 ms
    // per complete two-minute simulation on the canonical Windows runner.
    expect(elapsedMs).toBeLessThan(3_500);
  });

  it("evaluates five bounded architecture searches within two seconds", () => {
    const startedAt = performance.now();
    for (let iteration = 0; iteration < 5; iteration += 1) {
      solveArchitecture(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
        maxCandidates: 12,
        maxChangesPerCandidate: 1,
      });
    }
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2_000);
  });
});
