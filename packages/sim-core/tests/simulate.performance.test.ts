import { describe, expect, it } from "vitest";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  simulate,
  solveArchitecture,
} from "../src";

describe("simulation performance budget", () => {
  it("completes 250 representative simulations within two seconds", () => {
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

    expect(elapsedMs).toBeLessThan(2_000);
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
