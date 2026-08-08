import { Worker, type WorkerOptions } from "node:worker_threads";
import type { Architecture, Scenario } from "@systemforge/contracts";
import type {
  SolveArchitectureOptions,
  SolveArchitectureResult,
} from "@systemforge/sim-core";

export type SolverRunner = (
  scenario: Scenario,
  architecture: Architecture,
  options: SolveArchitectureOptions,
  timeoutMilliseconds: number,
  maximumResultBytes: number,
) => Promise<SolveArchitectureResult>;

export interface SolverWorker {
  once(event: "message", listener: (message: unknown) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

export type SolverWorkerFactory = (
  filename: URL,
  options: WorkerOptions,
) => SolverWorker;

const defaultWorkerFactory: SolverWorkerFactory = (filename, options) =>
  new Worker(filename, options);

export const createSolverRunner =
  (createWorker: SolverWorkerFactory = defaultWorkerFactory): SolverRunner =>
  (scenario, architecture, options, timeoutMilliseconds, maximumResultBytes) =>
    new Promise((resolve, reject) => {
      const worker = createWorker(
        new URL("./solverThread.js", import.meta.url),
        {
          workerData: {
            scenario,
            architecture,
            options,
            maximumResultBytes,
          },
        },
      );
      let settled = false;
      const finish = (action: () => void, terminate: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (terminate) void worker.terminate();
        action();
      };
      const timeout = setTimeout(() => {
        finish(() => reject(new Error("canonical_solver_timeout")), true);
      }, timeoutMilliseconds);
      timeout.unref();
      worker.once("message", (value) => {
        const message = value as {
          ok: boolean;
          result?: SolveArchitectureResult;
          error?: string;
        };
        const result = message.result;
        if (message.ok && result) finish(() => resolve(result), true);
        else
          finish(
            () => reject(new Error(message.error ?? "canonical_solver_failed")),
            true,
          );
      });
      worker.once("error", (error) => {
        finish(
          () =>
            reject(error instanceof Error ? error : new Error(String(error))),
          false,
        );
      });
      worker.once("exit", (code) => {
        if (code !== 0)
          finish(
            () => reject(new Error(`canonical_solver_worker_exit_${code}`)),
            false,
          );
      });
    });

export const runSolverInThread = createSolverRunner();
