// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Architecture, Scenario } from "@systemforge/contracts";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  solveArchitecture,
  type SolveArchitectureOptions,
} from "@systemforge/sim-core";
import {
  LOCAL_SOLVER_WORK_UNIT_LIMIT,
  runLocalArchitectureSolver,
} from "../src/lib/localSolver";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("browser-local architecture solver", () => {
  it("executes the bounded solver in a disposable browser worker", async () => {
    const terminate = vi.fn();
    const WorkerMock = vi.fn(function (this: {
      onmessage?: (event: MessageEvent) => void;
      onerror?: () => void;
      postMessage: (payload: unknown) => void;
      terminate: () => void;
    }) {
      this.terminate = terminate;
      this.postMessage = (payload) => {
        const request = payload as {
          scenario: Scenario;
          architecture: Architecture;
          options: SolveArchitectureOptions;
        };
        const result = solveArchitecture(
          request.scenario,
          request.architecture,
          request.options,
        );
        queueMicrotask(() =>
          this.onmessage?.({ data: { ok: true, result } } as MessageEvent),
        );
      };
    });
    vi.stubGlobal("Worker", WorkerMock);

    const result = await runLocalArchitectureSolver(
      DEFAULT_SCENARIO,
      DEFAULT_ARCHITECTURE,
      { maxCandidates: 4, maxChangesPerCandidate: 1 },
    );

    expect(result).toMatchObject({
      engineVersion: "0.7.0",
      solverVersion: "0.1.0",
      exploredCandidates: 4,
    });
    expect(WorkerMock).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("rejects excessive solve work before allocating a worker", async () => {
    const WorkerMock = vi.fn();
    vi.stubGlobal("Worker", WorkerMock);
    const scenario = {
      ...structuredClone(DEFAULT_SCENARIO),
      workload: {
        ...structuredClone(DEFAULT_SCENARIO.workload),
        durationSeconds: 86_400,
      },
    };

    await expect(
      runLocalArchitectureSolver(scenario, DEFAULT_ARCHITECTURE, {
        maxCandidates: 64,
      }),
    ).rejects.toThrow(
      `browser-local solver safety budget of ${LOCAL_SOLVER_WORK_UNIT_LIMIT.toLocaleString("en-US")}`,
    );
    expect(WorkerMock).not.toHaveBeenCalled();
  });

  it("terminates a browser worker that exceeds its time limit", async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const WorkerMock = vi.fn(function (this: {
      postMessage: () => void;
      terminate: () => void;
    }) {
      this.postMessage = vi.fn();
      this.terminate = terminate;
    });
    vi.stubGlobal("Worker", WorkerMock);

    const pending = runLocalArchitectureSolver(
      DEFAULT_SCENARIO,
      DEFAULT_ARCHITECTURE,
      { maxCandidates: 1 },
    );
    const expectation = expect(pending).rejects.toThrow(
      "local solver exceeded its safety time limit",
    );
    await vi.advanceTimersByTimeAsync(15_000);

    await expectation;
    expect(terminate).toHaveBeenCalledOnce();
  });
});
