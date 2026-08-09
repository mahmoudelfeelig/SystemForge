// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimulationAction } from "@systemforge/contracts";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  simulate,
} from "@systemforge/sim-core";
import {
  SimulationRunCancelledError,
  runLocalSimulation,
  startLocalSimulation,
  type SimulationRunIdentity,
  type SimulationWorkerMessage,
} from "../src/lib/localSimulation";
import { createSimulationWorkerRuntime } from "../src/workers/simulation.worker";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const identity: SimulationRunIdentity = {
  runId: "run-1",
  scenarioRevision: 3,
  architectureRevision: 7,
  scenarioId: DEFAULT_SCENARIO.id,
  architectureId: DEFAULT_ARCHITECTURE.id,
};

const scaleAction = (
  id: string,
  atSecond: number,
): Extract<SimulationAction, { type: "apply-intervention" }> => ({
  type: "apply-intervention",
  id,
  atSecond,
  nodeId: "api",
  intervention: { kind: "scale", instances: 12 },
});

const fingerprintForTest = (value: unknown): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
};

class WorkerMock {
  static instances: WorkerMock[] = [];

  onmessage: ((event: MessageEvent<SimulationWorkerMessage>) => void) | null =
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

  emit(message: SimulationWorkerMessage) {
    this.onmessage?.({
      data: message,
    } as MessageEvent<SimulationWorkerMessage>);
  }
}

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
    await expect(
      startLocalSimulation(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
        restore: {
          version: 1,
          snapshotId: "oversized-restore",
          sourceRunId: "oversized-source",
          scenario,
          architecture: structuredClone(DEFAULT_ARCHITECTURE),
          actions: [],
          cursor: {
            nextFrame: 0,
            nextEvent: 0,
            batchIndex: 0,
            deliveredSecond: null,
          },
          prefixFingerprint: "unused",
          resultFingerprint: "unused",
          restoration: "deterministic-replay-from-second-zero",
          opaqueRuntimeStateSerialized: false,
        },
      }).result,
    ).rejects.toThrow("browser-local safety budget");
    expect(WorkerMock).not.toHaveBeenCalled();
  });

  it("rejects cancellation without waiting for a synchronous simulation", async () => {
    WorkerMock.instances = [];
    vi.stubGlobal("Worker", WorkerMock);
    const session = startLocalSimulation(
      DEFAULT_SCENARIO,
      DEFAULT_ARCHITECTURE,
      { identity },
    );
    const worker = WorkerMock.instances[0]!;

    session.cancel();

    await expect(session.result).rejects.toBeInstanceOf(
      SimulationRunCancelledError,
    );
    expect(worker.messages).toEqual([
      expect.objectContaining({ type: "start", identity }),
      { type: "cancel", identity },
    ]);
    expect(worker.terminated).toBe(true);
  });

  it("ignores worker messages for another run identity", async () => {
    WorkerMock.instances = [];
    vi.stubGlobal("Worker", WorkerMock);
    const expected = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const session = startLocalSimulation(
      DEFAULT_SCENARIO,
      DEFAULT_ARCHITECTURE,
      { identity },
    );
    const worker = WorkerMock.instances[0]!;
    const staleIdentities: SimulationRunIdentity[] = [
      { ...identity, runId: "stale-run" },
      { ...identity, scenarioRevision: identity.scenarioRevision + 1 },
      {
        ...identity,
        architectureRevision: identity.architectureRevision + 1,
      },
      { ...identity, scenarioId: "stale-scenario" },
      { ...identity, architectureId: "stale-architecture" },
    ];

    for (const staleIdentity of staleIdentities) {
      worker.emit({
        type: "complete",
        identity: staleIdentity,
        result: expected,
      });
      expect(worker.terminated).toBe(false);
    }
    worker.emit({ type: "complete", identity, result: expected });

    await expect(session.result).resolves.toEqual(expected);
    expect(worker.terminated).toBe(true);
  });

  it("preserves final equivalence while the worker streams deterministic batches", async () => {
    vi.useFakeTimers();
    const messages: SimulationWorkerMessage[] = [];
    const dispatch = createSimulationWorkerRuntime({
      postMessage: (message) => messages.push(message),
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer),
    });

    dispatch({
      type: "start",
      identity,
      scenario: structuredClone(DEFAULT_SCENARIO),
      architecture: structuredClone(DEFAULT_ARCHITECTURE),
      batchSize: 11,
      speed: 16,
    });
    await vi.runAllTimersAsync();

    const expected = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const batches = messages.filter((message) => message.type === "batch");
    const complete = messages.find((message) => message.type === "complete");
    expect(messages.every((message) => message.identity === identity)).toBe(
      true,
    );
    expect(batches.flatMap((message) => message.frames)).toEqual(
      expected.frames,
    );
    expect(batches.flatMap((message) => message.events)).toEqual(
      expected.events,
    );
    expect(complete).toMatchObject({ type: "complete", result: expected });
  });

  it("pauses, steps one batch, changes speed, and resumes the same run", async () => {
    vi.useFakeTimers();
    const messages: SimulationWorkerMessage[] = [];
    const dispatch = createSimulationWorkerRuntime({
      postMessage: (message) => messages.push(message),
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer),
    });
    dispatch({
      type: "start",
      identity,
      scenario: structuredClone(DEFAULT_SCENARIO),
      architecture: structuredClone(DEFAULT_ARCHITECTURE),
      batchSize: 7,
      speed: 1,
    });

    dispatch({ type: "pause", identity });
    dispatch({ type: "step", identity });
    expect(messages.filter((message) => message.type === "batch")).toHaveLength(
      1,
    );
    expect(messages.at(-1)).toEqual({ type: "paused", identity });

    dispatch({ type: "set-speed", identity, speed: 8 });
    dispatch({ type: "resume", identity });
    await vi.runAllTimersAsync();

    expect(messages).toContainEqual({ type: "speed", identity, speed: 8 });
    expect(messages).toContainEqual({ type: "running", identity });
    expect(messages.at(-1)).toEqual({
      type: "complete",
      identity,
      result: simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE),
    });
    expect(messages.every((message) => message.identity === identity)).toBe(
      true,
    );
  });

  it("applies paused future actions without changing delivered frames", async () => {
    vi.useFakeTimers();
    const messages: SimulationWorkerMessage[] = [];
    const dispatch = createSimulationWorkerRuntime({
      postMessage: (message) => messages.push(message),
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer),
    });
    dispatch({
      type: "start",
      identity,
      scenario: structuredClone(DEFAULT_SCENARIO),
      architecture: structuredClone(DEFAULT_ARCHITECTURE),
      batchSize: 4,
      speed: 1,
    });
    await vi.advanceTimersByTimeAsync(4);
    dispatch({ type: "pause", identity });
    const delivered = messages.find((message) => message.type === "batch")!;
    const prefix = structuredClone(delivered.frames);
    const action = scaleAction("future-scale", 5);

    dispatch({ type: "apply-intervention", identity, action });

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "action-applied",
        identity,
        action,
        deliveredSecond: 3,
      }),
    );
    expect(
      messages.find((message) => message.type === "batch")!.frames,
    ).toEqual(prefix);
    dispatch({
      type: "apply-intervention",
      identity,
      action: scaleAction("stale-scale", 3),
    });
    expect(messages.at(-1)).toMatchObject({
      type: "command-rejected",
      command: "apply-intervention",
    });

    dispatch({ type: "resume", identity });
    await vi.runAllTimersAsync();
    const complete = messages.findLast(
      (message) => message.type === "complete",
    )!;
    expect(complete).toEqual({
      type: "complete",
      identity,
      result: simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
        actions: [action],
      }),
    });
  });

  it("injects one instance failure while paused and finishes the remaining playback", () => {
    vi.useFakeTimers();
    const messages: SimulationWorkerMessage[] = [];
    const dispatch = createSimulationWorkerRuntime({
      postMessage: (message) => messages.push(message),
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer),
    });
    const action: Extract<SimulationAction, { type: "inject-incident" }> = {
      type: "inject-incident",
      id: "inject-api-outage",
      atSecond: 2,
      incident: {
        id: "api-outage-at-two",
        kind: "node-failure",
        magnitude: 1,
        durationSeconds: 4,
        targetId: "api",
        label: "Paused API instance failure",
      },
    };
    dispatch({
      type: "start",
      identity,
      scenario: structuredClone(DEFAULT_SCENARIO),
      architecture: structuredClone(DEFAULT_ARCHITECTURE),
      batchSize: 5,
      speed: 1,
    });
    dispatch({ type: "inject-incident", identity, action });
    expect(messages.at(-1)).toMatchObject({
      type: "command-rejected",
      command: "inject-incident",
    });
    dispatch({ type: "pause", identity });
    dispatch({ type: "inject-incident", identity, action });
    dispatch({ type: "finish", identity });

    const complete = messages.at(-1)!;
    expect(complete.type).toBe("complete");
    if (complete.type !== "complete") throw new Error("Expected completion.");
    expect(complete.result.frames[2]!.nodeMetrics.api!.state).toBe("warning");
    expect(
      complete.result.frames[2]!.nodeMetrics.api!.errorRate,
    ).toBeGreaterThan(0);
    expect(complete.result.events).toContainEqual(
      expect.objectContaining({ id: "incident-api-outage-at-two", second: 2 }),
    );
  });

  it("restores snapshots and forks by replaying to an equivalent cursor", async () => {
    vi.useFakeTimers();
    const sourceMessages: SimulationWorkerMessage[] = [];
    const sourceDispatch = createSimulationWorkerRuntime({
      postMessage: (message) => sourceMessages.push(message),
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer),
    });
    sourceDispatch({
      type: "start",
      identity,
      scenario: structuredClone(DEFAULT_SCENARIO),
      architecture: structuredClone(DEFAULT_ARCHITECTURE),
      batchSize: 3,
      speed: 1,
    });
    await vi.advanceTimersByTimeAsync(4);
    sourceDispatch({ type: "pause", identity });
    sourceDispatch({
      type: "apply-intervention",
      identity,
      action: scaleAction("snapshot-scale", 5),
    });
    sourceDispatch({ type: "snapshot", identity });
    sourceDispatch({ type: "fork", identity, forkKey: "capacity-branch" });
    const snapshotMessage = sourceMessages.find(
      (message) => message.type === "snapshot-created",
    )!;
    const forkMessage = sourceMessages.find(
      (message) => message.type === "fork-created",
    )!;
    if (
      snapshotMessage.type !== "snapshot-created" ||
      forkMessage.type !== "fork-created"
    )
      throw new Error("Expected replay snapshots.");
    expect(snapshotMessage.snapshot).toMatchObject({
      cursor: { nextFrame: 3, deliveredSecond: 2 },
      restoration: "deterministic-replay-from-second-zero",
      opaqueRuntimeStateSerialized: false,
    });
    expect(forkMessage.snapshot.resultFingerprint).toBe(
      snapshotMessage.snapshot.resultFingerprint,
    );

    const invalidIdentity = { ...identity, runId: "invalid-restore" };
    const invalidMessages: SimulationWorkerMessage[] = [];
    const invalidDispatch = createSimulationWorkerRuntime({
      postMessage: (message) => invalidMessages.push(message),
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer),
    });
    invalidDispatch({
      type: "start",
      identity: invalidIdentity,
      scenario: snapshotMessage.snapshot.scenario,
      architecture: snapshotMessage.snapshot.architecture,
      restore: {
        ...snapshotMessage.snapshot,
        cursor: {
          ...snapshotMessage.snapshot.cursor,
          deliveredSecond: 99,
        },
      },
      batchSize: 3,
      speed: 1,
    });
    expect(invalidMessages.at(-1)).toMatchObject({
      type: "error",
      identity: invalidIdentity,
      error: expect.stringContaining("cursor is inconsistent"),
    });

    const forkIdentity = { ...identity, runId: "run-fork" };
    const forkMessages: SimulationWorkerMessage[] = [];
    const forkDispatch = createSimulationWorkerRuntime({
      postMessage: (message) => forkMessages.push(message),
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer),
    });
    forkDispatch({
      type: "start",
      identity: forkIdentity,
      scenario: snapshotMessage.snapshot.scenario,
      architecture: snapshotMessage.snapshot.architecture,
      restore: snapshotMessage.snapshot,
      batchSize: 3,
      speed: 1,
    });
    expect(forkMessages.at(-1)).toEqual({
      type: "paused",
      identity: forkIdentity,
    });
    sourceDispatch({ type: "resume", identity });
    forkDispatch({ type: "resume", identity: forkIdentity });
    await vi.runAllTimersAsync();

    const sourceComplete = sourceMessages.findLast(
      (message) => message.type === "complete",
    )!;
    const forkComplete = forkMessages.findLast(
      (message) => message.type === "complete",
    )!;
    if (sourceComplete.type !== "complete" || forkComplete.type !== "complete")
      throw new Error("Expected both replay branches to complete.");
    expect(forkComplete.result).toEqual(sourceComplete.result);
    expect(fingerprintForTest(forkComplete.result)).toBe(
      snapshotMessage.snapshot.resultFingerprint,
    );
  });

  it("guards stale, cancelled and over-capacity action commands", () => {
    vi.useFakeTimers();
    const messages: SimulationWorkerMessage[] = [];
    const dispatch = createSimulationWorkerRuntime({
      postMessage: (message) => messages.push(message),
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer),
    });
    const actions = Array.from({ length: 64 }, (_, index) =>
      scaleAction(`scale-${index}`, 10),
    );
    dispatch({
      type: "start",
      identity,
      scenario: structuredClone(DEFAULT_SCENARIO),
      architecture: structuredClone(DEFAULT_ARCHITECTURE),
      actions,
      batchSize: 5,
      speed: 1,
    });
    dispatch({ type: "pause", identity });
    dispatch({
      type: "apply-intervention",
      identity,
      action: scaleAction("scale-65", 11),
    });
    expect(messages.at(-1)).toMatchObject({
      type: "command-rejected",
      reason: expect.stringContaining("at most 64"),
    });
    const staleIdentity = { ...identity, runId: "stale" };
    const countBeforeStale = messages.length;
    dispatch({ type: "snapshot", identity: staleIdentity });
    expect(messages).toHaveLength(countBeforeStale);
    dispatch({ type: "cancel", identity });
    const countAfterCancel = messages.length;
    dispatch({ type: "snapshot", identity });
    expect(messages).toHaveLength(countAfterCancel);
  });
});
