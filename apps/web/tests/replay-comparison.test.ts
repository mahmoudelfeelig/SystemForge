// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  simulate,
} from "@systemforge/sim-core";
import {
  appendCompletedRunAction,
  createCompletedRunArtifact,
} from "../src/lib/completedRun";
import { createCompletedRunReplayBundle } from "../src/lib/replayBundle";
import {
  ReplayComparisonCancelledError,
  startSynchronizedReplayComparison,
  summarizeSynchronizedReplayComparison,
  type ReplayComparisonWorkerMessage,
} from "../src/lib/replayComparison";
import { createReplayComparisonWorkerRuntime } from "../src/workers/replayComparison.worker";

const testDigestProvider: Pick<SubtleCrypto, "digest"> = {
  digest: (_algorithm, data) => {
    const input = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    const output = new Uint8Array(32);
    for (const [index, byte] of input.entries())
      output[index % output.length] =
        (output[index % output.length]! * 33 + byte + index) & 0xff;
    return Promise.resolve(output.buffer);
  },
};

const createBundle = async (
  runId: string,
  architecture = structuredClone(DEFAULT_ARCHITECTURE),
) => {
  const result = simulate(DEFAULT_SCENARIO, architecture);
  const artifact = await createCompletedRunArtifact({
    identity: {
      runId,
      scenarioId: DEFAULT_SCENARIO.id,
      architectureId: architecture.id,
      scenarioRevision: 1,
      architectureRevision: 2,
    },
    scenario: DEFAULT_SCENARIO,
    architecture,
    result,
    actionLog: appendCompletedRunAction([], "start", null),
    digestProvider: null,
  });
  return {
    bundle: await createCompletedRunReplayBundle(artifact, testDigestProvider),
    result,
  };
};

class WorkerMock {
  static instances: WorkerMock[] = [];

  onmessage:
    ((event: MessageEvent<ReplayComparisonWorkerMessage>) => void) | null =
    null;
  onerror: (() => void) | null = null;
  messages: unknown[] = [];
  terminated = false;

  constructor() {
    WorkerMock.instances.push(this);
  }

  postMessage(message: unknown) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  emit(message: ReplayComparisonWorkerMessage) {
    this.onmessage?.({
      data: message,
    } as MessageEvent<ReplayComparisonWorkerMessage>);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  WorkerMock.instances = [];
});

describe("synchronized replay comparison", () => {
  it("recomputes both branches, aligns modeled seconds, and verifies each digest", async () => {
    vi.useFakeTimers();
    const source = await createBundle("comparison-source");
    const comparisonArchitecture = structuredClone(DEFAULT_ARCHITECTURE);
    const api = comparisonArchitecture.nodes.find((node) => node.id === "api")!;
    api.config.capacityRps = Math.max(
      1,
      Math.floor(api.config.capacityRps / 2),
    );
    const comparison = await createBundle(
      "comparison-branch",
      comparisonArchitecture,
    );
    const messages: ReplayComparisonWorkerMessage[] = [];
    const dispatch = createReplayComparisonWorkerRuntime({
      postMessage: (message) => messages.push(message),
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer),
      now: () => performance.now(),
    });

    dispatch({
      type: "start",
      requestId: "worker-compare",
      source: source.bundle,
      comparison: comparison.bundle,
      workUnitBudget: 2_000_000,
      maxWallClockMs: 20_000,
    });
    await vi.runAllTimersAsync();
    await vi.waitFor(() =>
      expect(messages.some((message) => message.type === "complete")).toBe(
        true,
      ),
    );

    expect(
      messages
        .filter((message) => message.type === "progress")
        .map((message) => message.progress),
    ).toEqual([0, 0.5, 1]);
    const complete = messages.find((message) => message.type === "complete");
    expect(complete).toMatchObject({
      type: "complete",
      requestId: "worker-compare",
      result: {
        verified: true,
        source: { resultDigestMatched: true },
        comparison: { resultDigestMatched: true },
        boundary: {
          execution: "two-fresh-deterministic-recomputations",
          alignment: "modeled-second",
          opaqueRuntimeStateRestored: false,
          productionTelemetryCompared: false,
        },
      },
    });
    if (complete?.type !== "complete") throw new Error("Missing comparison.");
    expect(complete.result.timeline.alignedFrameCount).toBe(
      source.result.frames.length,
    );
    expect(complete.result.metrics.p95LatencyMs.delta).not.toBeNaN();
  });

  it("reports a source digest mismatch without treating the output as verified", async () => {
    const source = await createBundle("digest-source");
    const comparison = await createBundle("digest-comparison");
    source.bundle.source.resultDigest.value = "different-source-digest";

    const result = await summarizeSynchronizedReplayComparison(
      source.bundle,
      source.result,
      comparison.bundle,
      comparison.result,
    );

    expect(result).toMatchObject({
      verified: false,
      source: { resultDigestMatched: false },
      comparison: { resultDigestMatched: true },
    });
  });

  it("terminates the disposable worker when cancelled", async () => {
    vi.stubGlobal("Worker", WorkerMock);
    const source = await createBundle("cancel-source");
    const comparison = await createBundle("cancel-comparison");
    const session = startSynchronizedReplayComparison(
      source.bundle,
      comparison.bundle,
      { requestId: "cancel-comparison" },
    );

    session.cancel();

    await expect(session.result).rejects.toBeInstanceOf(
      ReplayComparisonCancelledError,
    );
    expect(session.state).toBe("cancelled");
    expect(WorkerMock.instances[0]?.terminated).toBe(true);
  });

  it("ignores a stale worker response and accepts only its request identity", async () => {
    vi.stubGlobal("Worker", WorkerMock);
    const source = await createBundle("identity-source");
    const comparison = await createBundle("identity-comparison");
    const expected = await summarizeSynchronizedReplayComparison(
      source.bundle,
      source.result,
      comparison.bundle,
      comparison.result,
    );
    const session = startSynchronizedReplayComparison(
      source.bundle,
      comparison.bundle,
      { requestId: "current-request" },
    );
    const worker = WorkerMock.instances[0]!;

    worker.emit({
      type: "complete",
      requestId: "stale-request",
      result: expected,
    });
    expect(worker.terminated).toBe(false);
    worker.emit({
      type: "complete",
      requestId: "current-request",
      result: expected,
    });

    await expect(session.result).resolves.toEqual(expected);
    expect(worker.terminated).toBe(true);
  });

  it("rejects over-budget comparisons before allocating a worker", async () => {
    const WorkerConstructor = vi.fn();
    vi.stubGlobal("Worker", WorkerConstructor);
    const source = await createBundle("budget-source");
    const comparison = await createBundle("budget-comparison");
    source.bundle.inputs.scenario.workload.durationSeconds = 86_400;
    comparison.bundle.inputs.scenario.workload.durationSeconds = 86_400;

    const session = startSynchronizedReplayComparison(
      source.bundle,
      comparison.bundle,
      { requestId: "over-budget" },
    );

    await expect(session.result).rejects.toThrow("browser budget");
    expect(session.state).toBe("error");
    expect(WorkerConstructor).not.toHaveBeenCalled();
  });
});
