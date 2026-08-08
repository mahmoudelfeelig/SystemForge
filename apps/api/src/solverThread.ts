import { parentPort, workerData } from "node:worker_threads";
import type { Architecture, Scenario } from "@systemforge/contracts";
import {
  solveArchitecture,
  type SolveArchitectureOptions,
} from "@systemforge/sim-core";

if (!parentPort)
  throw new Error("Solver worker thread requires a parent port.");

try {
  const { scenario, architecture, options, maximumResultBytes } =
    workerData as {
      scenario: Scenario;
      architecture: Architecture;
      options: SolveArchitectureOptions;
      maximumResultBytes: number;
    };
  const result = solveArchitecture(scenario, architecture, options);
  const resultBytes = Buffer.byteLength(JSON.stringify(result));
  if (resultBytes > maximumResultBytes)
    throw new Error(
      `solver_result_too_large:${resultBytes}:${maximumResultBytes}`,
    );
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : "canonical_solver_failed",
  });
}
