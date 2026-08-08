import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  ENGINE_VERSION,
  solveArchitecture,
} from "@systemforge/sim-core";
import type { FastifyInstance } from "fastify";
import { buildApp, type SolverRunner } from "../src/app";
import type { ApiConfig } from "../src/config";
import { MemoryControlStore } from "../src/memoryStore";

const config: ApiConfig = {
  port: 8080,
  host: "127.0.0.1",
  databaseUrl: "postgres://unused",
  publicOrigin: "https://systemforge.elfeel.me",
  trustProxy: false,
  maxQueuedRuns: 10,
  maxStoredRuns: 100,
  maxSharedScenarios: 100,
  maxCanonicalWorkUnits: 30_000,
  maxConcurrentRequests: 8,
  maxConcurrentSolves: 1,
  maxSolverCandidates: 12,
  maxSolverWorkUnits: 120_000,
  solverTimeoutMs: 10_000,
  maxSolverResultBytes: 4_000_000,
  rateLimitMax: 100,
  rateLimitWindow: "1 minute",
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

describe("canonical architecture solver API", () => {
  it("isolates a bounded solve and always excludes hidden requirements", async () => {
    const scenario = {
      ...structuredClone(DEFAULT_SCENARIO),
      mode: "interview" as const,
      interview: {
        candidateBrief: "Derive the system requirements before designing.",
        interviewerBrief: "Private evaluation rubric.",
        timeboxMinutes: 45,
        allowCandidateRequirements: true,
        revealPolicy: "never" as const,
      },
      requirements: DEFAULT_SCENARIO.requirements.map((requirement, index) =>
        index === 0
          ? {
              ...requirement,
              visibility: "hidden" as const,
              owner: "interviewer" as const,
            }
          : requirement,
      ),
    };
    const result = solveArchitecture(scenario, DEFAULT_ARCHITECTURE, {
      maxCandidates: 2,
      includeHiddenRequirements: false,
      workUnitBudget: config.maxSolverWorkUnits,
    });
    const runner = vi.fn<SolverRunner>().mockResolvedValue(result);
    app = await buildApp(config, new MemoryControlStore(), runner);

    const response = await app.inject({
      method: "POST",
      url: "/api/solve",
      payload: {
        scenario,
        architecture: DEFAULT_ARCHITECTURE,
        clientEngineVersion: ENGINE_VERSION,
        options: {
          maxCandidates: 2,
          includeHiddenRequirements: true,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      execution: "canonical",
      result: {
        solverVersion: "0.1.0",
        excludedHiddenRequirementCount: 1,
      },
    });
    expect(runner).toHaveBeenCalledWith(
      scenario,
      DEFAULT_ARCHITECTURE,
      expect.objectContaining({
        maxCandidates: 2,
        includeHiddenRequirements: false,
        workUnitBudget: config.maxSolverWorkUnits,
      }),
      config.solverTimeoutMs,
      config.maxSolverResultBytes,
    );
  });

  it("rejects stale engines and excessive solver work before allocation", async () => {
    const runner = vi.fn<SolverRunner>();
    app = await buildApp(config, new MemoryControlStore(), runner);

    const stale = await app.inject({
      method: "POST",
      url: "/api/solve",
      payload: {
        scenario: DEFAULT_SCENARIO,
        architecture: DEFAULT_ARCHITECTURE,
        clientEngineVersion: "0.2.0",
      },
    });
    const oversized = await app.inject({
      method: "POST",
      url: "/api/solve",
      payload: {
        scenario: {
          ...structuredClone(DEFAULT_SCENARIO),
          workload: {
            ...structuredClone(DEFAULT_SCENARIO.workload),
            durationSeconds: 86_400,
          },
        },
        architecture: DEFAULT_ARCHITECTURE,
        clientEngineVersion: ENGINE_VERSION,
        options: { maxCandidates: config.maxSolverCandidates },
      },
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("engine_version_mismatch");
    expect(oversized.statusCode).toBe(422);
    expect(oversized.json()).toMatchObject({
      error: {
        code: "solver_workload_too_large",
        localModeAvailable: true,
      },
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("caps requested candidates independently from the work estimate", async () => {
    const runner = vi.fn<SolverRunner>();
    app = await buildApp(config, new MemoryControlStore(), runner);

    const response = await app.inject({
      method: "POST",
      url: "/api/solve",
      payload: {
        scenario: DEFAULT_SCENARIO,
        architecture: DEFAULT_ARCHITECTURE,
        clientEngineVersion: ENGINE_VERSION,
        options: { maxCandidates: config.maxSolverCandidates + 1 },
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("solver_candidate_limit_exceeded");
    expect(runner).not.toHaveBeenCalled();
  });

  it("maps an amplified worker result to a bounded local-mode response", async () => {
    const runner = vi
      .fn<SolverRunner>()
      .mockRejectedValue(new Error("solver_result_too_large:5000000:4000000"));
    app = await buildApp(config, new MemoryControlStore(), runner);

    const response = await app.inject({
      method: "POST",
      url: "/api/solve",
      payload: {
        scenario: DEFAULT_SCENARIO,
        architecture: DEFAULT_ARCHITECTURE,
        clientEngineVersion: ENGINE_VERSION,
        options: { maxCandidates: 1 },
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        code: "solver_result_too_large",
        localModeAvailable: true,
      },
    });
  });

  it("sheds concurrent solver work through its independent admission lane", async () => {
    let release!: () => void;
    const result = solveArchitecture(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
      maxCandidates: 1,
      workUnitBudget: config.maxSolverWorkUnits,
    });
    const runner = vi.fn<SolverRunner>().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(result);
        }),
    );
    app = await buildApp(config, new MemoryControlStore(), runner);
    const payload = {
      scenario: DEFAULT_SCENARIO,
      architecture: DEFAULT_ARCHITECTURE,
      clientEngineVersion: ENGINE_VERSION,
      options: { maxCandidates: 1 },
    };

    const admitted = app.inject({ method: "POST", url: "/api/solve", payload });
    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
    const rejected = await app.inject({
      method: "POST",
      url: "/api/solve",
      payload,
    });

    expect(rejected.statusCode).toBe(503);
    expect(rejected.headers["retry-after"]).toBe("2");
    expect(rejected.json()).toMatchObject({
      error: {
        code: "solver_capacity_exceeded",
        localModeAvailable: true,
      },
    });
    release();
    expect((await admitted).statusCode).toBe(200);
  });
});
