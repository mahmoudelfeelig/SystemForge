// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  analyzeRobustness,
} from "@systemforge/sim-core";
import {
  RobustnessAnalysisCancelledError,
  startRobustnessAnalysis,
  type RobustnessAnalysisIdentity,
  type RobustnessWorkerMessage,
} from "../src/lib/robustnessAnalysis";
import { createRobustnessWorkerRuntime } from "../src/workers/robustness.worker";

const identity: RobustnessAnalysisIdentity = {
  requestId: "robustness-1",
  scenarioRevision: 4,
  architectureRevision: 8,
  scenarioId: DEFAULT_SCENARIO.id,
  architectureId: DEFAULT_ARCHITECTURE.id,
};

class WorkerMock {
  static instances: WorkerMock[] = [];

  onmessage: ((event: MessageEvent<RobustnessWorkerMessage>) => void) | null =
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

  emit(message: RobustnessWorkerMessage) {
    this.onmessage?.({
      data: message,
    } as MessageEvent<RobustnessWorkerMessage>);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  WorkerMock.instances = [];
});

describe("robustness worker runtime", () => {
  it("matches the existing robustness result and emits deterministic progress", async () => {
    vi.useFakeTimers();
    const messages: RobustnessWorkerMessage[] = [];
    const dispatch = createRobustnessWorkerRuntime({
      postMessage: (message) => messages.push(message),
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer),
      now: () => performance.now(),
    });

    dispatch({
      type: "start",
      identity,
      scenario: structuredClone(DEFAULT_SCENARIO),
      architecture: structuredClone(DEFAULT_ARCHITECTURE),
      seedCount: 3,
      seedStride: 7_919,
      workUnitBudget: 2_000_000,
      maxWallClockMs: 12_000,
    });
    await vi.runAllTimersAsync();

    const expected = analyzeRobustness(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
      seedCount: 3,
      seedStride: 7_919,
    });
    expect(messages.every((message) => message.identity === identity)).toBe(
      true,
    );
    expect(
      messages
        .filter((message) => message.type === "progress")
        .map((message) => ({
          completedSeeds: message.completedSeeds,
          totalSeeds: message.totalSeeds,
          progress: message.progress,
        })),
    ).toEqual([
      { completedSeeds: 0, totalSeeds: 3, progress: 0 },
      { completedSeeds: 1, totalSeeds: 3, progress: 1 / 3 },
      { completedSeeds: 2, totalSeeds: 3, progress: 2 / 3 },
      { completedSeeds: 3, totalSeeds: 3, progress: 1 },
    ]);
    expect(messages.at(-1)).toEqual({
      type: "complete",
      identity,
      result: expected,
    });
  });

  it("cancels cooperatively before the next seed is evaluated", () => {
    vi.useFakeTimers();
    const messages: RobustnessWorkerMessage[] = [];
    const dispatch = createRobustnessWorkerRuntime({
      postMessage: (message) => messages.push(message),
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer),
      now: () => performance.now(),
    });
    dispatch({
      type: "start",
      identity,
      scenario: structuredClone(DEFAULT_SCENARIO),
      architecture: structuredClone(DEFAULT_ARCHITECTURE),
      seedCount: 3,
      seedStride: 7_919,
      workUnitBudget: 2_000_000,
      maxWallClockMs: 12_000,
    });

    dispatch({ type: "cancel", identity });
    vi.runAllTimers();

    expect(messages.at(-1)).toEqual({ type: "cancelled", identity });
    expect(messages.some((message) => message.type === "complete")).toBe(false);
  });
});

describe("robustness analysis browser session", () => {
  it("terminates immediately when cancelled", async () => {
    vi.stubGlobal("Worker", WorkerMock);
    const session = startRobustnessAnalysis(
      DEFAULT_SCENARIO,
      DEFAULT_ARCHITECTURE,
      { identity },
    );
    const worker = WorkerMock.instances[0]!;

    session.cancel();

    await expect(session.result).rejects.toBeInstanceOf(
      RobustnessAnalysisCancelledError,
    );
    expect(session.state).toBe("cancelled");
    expect(worker.messages).toEqual([
      expect.objectContaining({ type: "start", identity }),
      { type: "cancel", identity },
    ]);
    expect(worker.terminated).toBe(true);
  });

  it("ignores a completed response carrying stale revisions", async () => {
    vi.stubGlobal("Worker", WorkerMock);
    const expected = analyzeRobustness(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
      seedCount: 2,
    });
    const session = startRobustnessAnalysis(
      DEFAULT_SCENARIO,
      DEFAULT_ARCHITECTURE,
      { identity, seedCount: 2 },
    );
    const worker = WorkerMock.instances[0]!;

    worker.emit({
      type: "complete",
      identity: {
        ...identity,
        scenarioRevision: identity.scenarioRevision - 1,
      },
      result: expected,
    });
    expect(worker.terminated).toBe(false);
    worker.emit({ type: "complete", identity, result: expected });

    await expect(session.result).resolves.toEqual(expected);
    expect(session.state).toBe("complete");
    expect(worker.terminated).toBe(true);
  });

  it("terminates with no result at the wall-clock limit", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", WorkerMock);
    const session = startRobustnessAnalysis(
      DEFAULT_SCENARIO,
      DEFAULT_ARCHITECTURE,
      { identity, maxWallClockMs: 25 },
    );
    const rejection = expect(session.result).rejects.toThrow(
      "wall-clock safety limit",
    );

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(session.state).toBe("error");
    expect(WorkerMock.instances[0]?.terminated).toBe(true);
  });

  it("rejects over-budget work before allocating a worker", async () => {
    const WorkerConstructor = vi.fn();
    vi.stubGlobal("Worker", WorkerConstructor);
    const scenario = {
      ...structuredClone(DEFAULT_SCENARIO),
      workload: {
        ...structuredClone(DEFAULT_SCENARIO.workload),
        durationSeconds: 86_400,
      },
    };
    const session = startRobustnessAnalysis(scenario, DEFAULT_ARCHITECTURE, {
      identity,
    });

    await expect(session.result).rejects.toThrow("browser budget");
    expect(session.state).toBe("error");
    expect(WorkerConstructor).not.toHaveBeenCalled();
  });
});
