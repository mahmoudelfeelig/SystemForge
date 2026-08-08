import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  solveArchitecture,
} from "@systemforge/sim-core";
import {
  createSolverRunner,
  type SolverWorkerFactory,
} from "../src/runSolverInThread";

class WorkerDouble extends EventEmitter {
  terminate = vi.fn(() => Promise.resolve(1));
}

const result = solveArchitecture(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
  maxCandidates: 1,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("canonical solver thread lifecycle", () => {
  it("resolves a worker result and disposes the worker", async () => {
    const worker = new WorkerDouble();
    const factory = vi.fn<SolverWorkerFactory>(() => worker);
    const run = createSolverRunner(factory);

    const pending = run(
      DEFAULT_SCENARIO,
      DEFAULT_ARCHITECTURE,
      { maxCandidates: 1 },
      10_000,
      4_000_000,
    );
    worker.emit("message", { ok: true, result });

    await expect(pending).resolves.toBe(result);
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        href: expect.stringContaining("solverThread.js"),
      }),
      expect.objectContaining({
        workerData: expect.objectContaining({ maximumResultBytes: 4_000_000 }),
      }),
    );
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates a solve that exceeds its wall-clock budget", async () => {
    vi.useFakeTimers();
    const worker = new WorkerDouble();
    const run = createSolverRunner(() => worker);

    const pending = run(
      DEFAULT_SCENARIO,
      DEFAULT_ARCHITECTURE,
      { maxCandidates: 1 },
      1_000,
      4_000_000,
    );
    const expectation = expect(pending).rejects.toThrow(
      "canonical_solver_timeout",
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await expectation;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects a worker-side solver failure", async () => {
    const worker = new WorkerDouble();
    const run = createSolverRunner(() => worker);

    const pending = run(
      DEFAULT_SCENARIO,
      DEFAULT_ARCHITECTURE,
      { maxCandidates: 1 },
      10_000,
      4_000_000,
    );
    worker.emit("message", { ok: false, error: "solver_result_too_large" });

    await expect(pending).rejects.toThrow("solver_result_too_large");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
