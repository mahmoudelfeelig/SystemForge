/// <reference lib="webworker" />

import type { Architecture, Scenario } from "@systemforge/contracts";
import {
  solveArchitecture,
  type SolveArchitectureOptions,
} from "@systemforge/sim-core";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (
  event: MessageEvent<{
    scenario: Scenario;
    architecture: Architecture;
    options: SolveArchitectureOptions;
  }>,
) => {
  try {
    const result = solveArchitecture(
      event.data.scenario,
      event.data.architecture,
      event.data.options,
    );
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({
      ok: false,
      error:
        error instanceof Error ? error.message : "The local solver failed.",
    });
  }
};

export {};
