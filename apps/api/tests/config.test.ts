import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const environment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  DATABASE_URL: "postgres://systemforge:test@127.0.0.1:5432/systemforge",
  ...overrides,
});

describe("API capacity configuration", () => {
  it("uses disk-safe durable defaults while leaving larger models local", () => {
    const config = loadConfig(environment());

    expect(config.maxQueuedRuns).toBe(250);
    expect(config.maxStoredRuns).toBe(250);
    expect(config.maxSharedScenarios).toBe(2_000);
    expect(config.maxCanonicalWorkUnits).toBe(30_000);
    expect(config.maxConcurrentSolves).toBe(1);
    expect(config.maxSolverCandidates).toBe(12);
    expect(config.maxSolverWorkUnits).toBe(120_000);
    expect(config.solverTimeoutMs).toBe(10_000);
    expect(config.maxSolverResultBytes).toBe(4_000_000);
  });

  it("never configures fewer durable slots than active queue slots", () => {
    const config = loadConfig(
      environment({ MAX_QUEUED_RUNS: "400", MAX_STORED_RUNS: "25" }),
    );

    expect(config.maxQueuedRuns).toBe(400);
    expect(config.maxStoredRuns).toBe(400);
  });
});
