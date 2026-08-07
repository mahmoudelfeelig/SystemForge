import type {
  Architecture,
  Scenario,
  SimulationResult,
} from "@systemforge/contracts";

export function runLocalSimulation(
  scenario: Scenario,
  architecture: Architecture,
): Promise<SimulationResult> {
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
