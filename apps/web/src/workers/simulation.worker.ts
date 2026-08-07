/// <reference lib="webworker" />

import type { Architecture, Scenario } from "@systemforge/contracts";
import { simulate } from "@systemforge/sim-core";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (
  event: MessageEvent<{ scenario: Scenario; architecture: Architecture }>,
) => {
  try {
    const result = simulate(event.data.scenario, event.data.architecture);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({
      ok: false,
      error:
        error instanceof Error ? error.message : "The local simulation failed.",
    });
  }
};

export {};
