// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ARCHITECTURE, DEFAULT_SCENARIO } from "@systemforge/sim-core";
import { runLocalSimulation } from "../src/lib/localSimulation";

afterEach(() => vi.unstubAllGlobals());

describe("browser-local simulation admission", () => {
  it("rejects pathological valid workloads before allocating a worker", async () => {
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
      runLocalSimulation(scenario, DEFAULT_ARCHITECTURE),
    ).rejects.toThrow("browser-local safety budget");
    expect(WorkerMock).not.toHaveBeenCalled();
  });
});
