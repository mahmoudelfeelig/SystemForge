import type { Architecture, Scenario } from "@systemforge/contracts";
import {
  estimateSolverWorkUnits,
  type SolveArchitectureOptions,
  type SolveArchitectureResult,
} from "@systemforge/sim-core";

export const LOCAL_SOLVER_WORK_UNIT_LIMIT = 250_000;
export const LOCAL_SOLVER_TIMEOUT_MS = 15_000;

const DEFAULT_LOCAL_SOLVER_CANDIDATES = 36;

export function runLocalArchitectureSolver(
  scenario: Scenario,
  architecture: Architecture,
  options: SolveArchitectureOptions = {},
): Promise<SolveArchitectureResult> {
  const requestedCandidates =
    options.maxCandidates ?? DEFAULT_LOCAL_SOLVER_CANDIDATES;
  const workUnits = estimateSolverWorkUnits(
    scenario,
    architecture,
    requestedCandidates,
  );
  if (workUnits > LOCAL_SOLVER_WORK_UNIT_LIMIT)
    return Promise.reject(
      new Error(
        `This model exceeds the browser-local solver safety budget of ${LOCAL_SOLVER_WORK_UNIT_LIMIT.toLocaleString("en-US")} work units. Reduce the duration, topology size, or candidate count before solving it.`,
      ),
    );

  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("../workers/solver.worker.ts", import.meta.url),
      { type: "module" },
    );
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("The local solver exceeded its safety time limit."));
    }, LOCAL_SOLVER_TIMEOUT_MS);
    worker.onmessage = (
      event: MessageEvent<{
        ok: boolean;
        result?: SolveArchitectureResult;
        error?: string;
      }>,
    ) => {
      window.clearTimeout(timeout);
      worker.terminate();
      if (event.data.ok && event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error ?? "The local solver failed."));
    };
    worker.onerror = () => {
      window.clearTimeout(timeout);
      worker.terminate();
      reject(new Error("The browser could not start the local solver worker."));
    };
    worker.postMessage({
      scenario,
      architecture,
      options: {
        ...options,
        maxCandidates: requestedCandidates,
        workUnitBudget: LOCAL_SOLVER_WORK_UNIT_LIMIT,
      },
    });
  });
}
