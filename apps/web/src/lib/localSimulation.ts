import type {
  Architecture,
  Scenario,
  SimulationResult,
} from "@systemforge/contracts";

export const LOCAL_SIMULATION_WORK_UNIT_LIMIT = 120_000;

export const localSimulationWorkUnits = (
  scenario: Scenario,
  architecture: Architecture,
): number =>
  (scenario.workload.durationSeconds + 1) *
  (architecture.nodes.length + architecture.edges.length * 0.25);

export function runLocalSimulation(
  scenario: Scenario,
  architecture: Architecture,
): Promise<SimulationResult> {
  const workUnits = localSimulationWorkUnits(scenario, architecture);
  if (workUnits > LOCAL_SIMULATION_WORK_UNIT_LIMIT)
    return Promise.reject(
      new Error(
        `This model exceeds the browser-local safety budget of ${LOCAL_SIMULATION_WORK_UNIT_LIMIT.toLocaleString("en-US")} work units. Reduce the duration or topology size before running it.`,
      ),
    );
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("../workers/simulation.worker.ts", import.meta.url),
      { type: "module" },
    );
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("The local simulation exceeded its safety time limit."));
    }, 15_000);
    worker.onmessage = (
      event: MessageEvent<{
        ok: boolean;
        result?: SimulationResult;
        error?: string;
      }>,
    ) => {
      window.clearTimeout(timeout);
      worker.terminate();
      if (event.data.ok && event.data.result) resolve(event.data.result);
      else
        reject(new Error(event.data.error ?? "The local simulation failed."));
    };
    worker.onerror = () => {
      window.clearTimeout(timeout);
      worker.terminate();
      reject(
        new Error("The browser could not start the local simulation worker."),
      );
    };
    worker.postMessage({ scenario, architecture });
  });
}
