import {
  estimateSimulationOutputMetricCells,
  estimateSimulationResultBytes,
  MAX_SIMULATION_ESTIMATED_RESULT_BYTES,
  MAX_SIMULATION_OUTPUT_METRIC_CELLS,
  type Architecture,
  type Scenario,
} from "@systemforge/contracts";
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
  const baselineWorkUnits = estimateSolverWorkUnits(scenario, architecture, 0);
  if (baselineWorkUnits > LOCAL_SOLVER_WORK_UNIT_LIMIT)
    return Promise.reject(
      new Error(
        `The baseline alone exceeds the browser-local solver safety budget of ${LOCAL_SOLVER_WORK_UNIT_LIMIT.toLocaleString("en-US")} work units. Reduce the duration or topology size before solving it.`,
      ),
    );
  const outputMetricCells = estimateSimulationOutputMetricCells(
    scenario,
    architecture,
  );
  if (outputMetricCells > MAX_SIMULATION_OUTPUT_METRIC_CELLS)
    return Promise.reject(
      new Error(
        `Each candidate would emit ${outputMetricCells.toLocaleString("en-US")} frame-metric cells, above the ${MAX_SIMULATION_OUTPUT_METRIC_CELLS.toLocaleString("en-US")} solver result-size limit. Reduce the duration or topology size before solving it.`,
      ),
    );
  const estimatedResultBytes = estimateSimulationResultBytes(
    scenario,
    architecture,
  );
  if (estimatedResultBytes > MAX_SIMULATION_ESTIMATED_RESULT_BYTES)
    return Promise.reject(
      new Error(
        `Each candidate's estimated ${estimatedResultBytes.toLocaleString("en-US")}-byte result exceeds the ${MAX_SIMULATION_ESTIMATED_RESULT_BYTES.toLocaleString("en-US")}-byte solver retention limit. Reduce the duration or topology size before solving it.`,
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
