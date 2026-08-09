/// <reference lib="webworker" />

import {
  MAX_SIMULATION_ACTIONS,
  simulationActionScheduleSchema,
  type Architecture,
  type Scenario,
  type SimulationAction,
  type SimulationResult,
} from "@systemforge/contracts";
import { simulate } from "@systemforge/sim-core";
import type {
  SimulationRunIdentity,
  SimulationSessionSnapshot,
  SimulationWorkerCommand,
  SimulationWorkerMessage,
} from "../lib/localSimulation";

declare const self: DedicatedWorkerGlobalScope;

export interface SimulationWorkerRuntimeScope {
  postMessage: (message: SimulationWorkerMessage) => void;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (timer: number) => void;
}

const sameIdentity = (
  left: SimulationRunIdentity,
  right: SimulationRunIdentity,
): boolean =>
  left.runId === right.runId &&
  left.scenarioRevision === right.scenarioRevision &&
  left.architectureRevision === right.architectureRevision &&
  left.scenarioId === right.scenarioId &&
  left.architectureId === right.architectureId;

const boundedSpeed = (speed: number): number =>
  Number.isFinite(speed) ? Math.min(16, Math.max(0.25, speed)) : 1;

const fingerprint = (value: unknown): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
};

const deliveredSecondFor = (
  result: SimulationResult,
  nextFrame: number,
): number | null => result.frames[nextFrame - 1]?.second ?? null;

const deliveredPrefix = (
  result: SimulationResult,
  nextFrame: number,
  nextEvent: number,
) => ({
  frames: result.frames.slice(0, nextFrame),
  events: result.events.slice(0, nextEvent),
});

const sameDeliveredPrefix = (
  current: SimulationResult,
  candidate: SimulationResult,
  nextFrame: number,
  nextEvent: number,
): boolean =>
  JSON.stringify(deliveredPrefix(current, nextFrame, nextEvent)) ===
  JSON.stringify(deliveredPrefix(candidate, nextFrame, nextEvent));

export const createSimulationWorkerRuntime = (
  scope: SimulationWorkerRuntimeScope,
): ((command: SimulationWorkerCommand) => void) => {
  type ActiveRun = {
    identity: SimulationRunIdentity;
    scenario: Scenario;
    architecture: Architecture;
    actions: SimulationAction[];
    result: SimulationResult;
    batchSize: number;
    speed: number;
    state: "running" | "paused";
    nextFrame: number;
    nextEvent: number;
    batchIndex: number;
    snapshotSequence: number;
    timer: number | null;
  };

  let active: ActiveRun | null = null;

  const clearTimer = (run: ActiveRun) => {
    if (run.timer !== null) scope.clearTimeout(run.timer);
    run.timer = null;
  };

  const rejectCommand = (
    run: ActiveRun,
    command: SimulationWorkerCommand["type"],
    reason: string,
  ) => {
    scope.postMessage({
      type: "command-rejected",
      identity: run.identity,
      command,
      reason,
    });
  };

  const sessionSnapshot = (
    run: ActiveRun,
    snapshotId: string,
  ): SimulationSessionSnapshot => ({
    version: 1,
    snapshotId,
    sourceRunId: run.identity.runId,
    scenario: structuredClone(run.scenario),
    architecture: structuredClone(run.architecture),
    actions: structuredClone(run.actions),
    cursor: {
      nextFrame: run.nextFrame,
      nextEvent: run.nextEvent,
      batchIndex: run.batchIndex,
      deliveredSecond: deliveredSecondFor(run.result, run.nextFrame),
    },
    prefixFingerprint: fingerprint(
      deliveredPrefix(run.result, run.nextFrame, run.nextEvent),
    ),
    resultFingerprint: fingerprint(run.result),
    restoration: "deterministic-replay-from-second-zero",
    opaqueRuntimeStateSerialized: false,
  });

  const applyAction = (run: ActiveRun, action: SimulationAction) => {
    if (run.state !== "paused") {
      rejectCommand(
        run,
        action.type,
        "Pause the run before scheduling actions.",
      );
      return;
    }
    const deliveredSecond = deliveredSecondFor(run.result, run.nextFrame);
    if (action.atSecond <= (deliveredSecond ?? -1)) {
      rejectCommand(
        run,
        action.type,
        "The action must target a second after the delivered cursor.",
      );
      return;
    }
    if (run.actions.length >= MAX_SIMULATION_ACTIONS) {
      rejectCommand(
        run,
        action.type,
        `A run can schedule at most ${MAX_SIMULATION_ACTIONS} actions.`,
      );
      return;
    }
    const parsed = simulationActionScheduleSchema.safeParse([
      ...run.actions,
      action,
    ]);
    if (!parsed.success) {
      rejectCommand(
        run,
        action.type,
        parsed.error.issues[0]?.message ?? "Invalid action.",
      );
      return;
    }
    try {
      const candidate = simulate(run.scenario, run.architecture, {
        actions: parsed.data,
      });
      if (
        !sameDeliveredPrefix(
          run.result,
          candidate,
          run.nextFrame,
          run.nextEvent,
        )
      ) {
        rejectCommand(
          run,
          action.type,
          "Recomputation changed an already delivered frame or event.",
        );
        return;
      }
      run.actions = parsed.data;
      run.result = candidate;
      scope.postMessage({
        type: "action-applied",
        identity: run.identity,
        action,
        deliveredSecond,
        totalFrames: candidate.frames.length,
        totalEvents: candidate.events.length,
      });
    } catch (error) {
      rejectCommand(
        run,
        action.type,
        error instanceof Error
          ? error.message
          : "The action could not be applied.",
      );
    }
  };

  const finish = (run: ActiveRun) => {
    clearTimer(run);
    if (active !== run) return;
    active = null;
    scope.postMessage({
      type: "complete",
      identity: run.identity,
      result: run.result,
    });
  };

  const emitBatch = (run: ActiveRun, remainPaused = false) => {
    clearTimer(run);
    if (active !== run) return;
    const frameOffset = run.nextFrame;
    const eventOffset = run.nextEvent;
    const frames = run.result.frames.slice(
      frameOffset,
      frameOffset + run.batchSize,
    );
    run.nextFrame += frames.length;
    const lastFrameSecond = frames.at(-1)?.second ?? Number.POSITIVE_INFINITY;
    while (
      run.nextEvent < run.result.events.length &&
      (run.result.events[run.nextEvent]?.second ?? Number.POSITIVE_INFINITY) <=
        lastFrameSecond
    )
      run.nextEvent += 1;
    if (run.nextFrame >= run.result.frames.length)
      run.nextEvent = run.result.events.length;
    const events = run.result.events.slice(eventOffset, run.nextEvent);
    const totalFrames = run.result.frames.length;
    const totalEvents = run.result.events.length;
    const deliveredFrames = run.nextFrame;
    const deliveredEvents = run.nextEvent;
    const frameProgress = totalFrames === 0 ? 1 : deliveredFrames / totalFrames;
    const eventProgress = totalEvents === 0 ? 1 : deliveredEvents / totalEvents;
    scope.postMessage({
      type: "batch",
      identity: run.identity,
      batchIndex: run.batchIndex,
      frameOffset,
      eventOffset,
      frames,
      events,
      deliveredFrames,
      deliveredEvents,
      totalFrames,
      totalEvents,
      progress: Math.min(1, Math.min(frameProgress, eventProgress)),
    });
    run.batchIndex += 1;
    if (run.nextFrame >= totalFrames && run.nextEvent >= totalEvents) {
      finish(run);
      return;
    }
    if (remainPaused) {
      run.state = "paused";
      scope.postMessage({ type: "paused", identity: run.identity });
      return;
    }
    schedule(run);
  };

  const emitRemaining = (run: ActiveRun) => {
    if (run.state !== "paused") {
      rejectCommand(run, "finish", "Pause the run before finishing playback.");
      return;
    }
    run.batchSize = Math.max(1, run.result.frames.length - run.nextFrame);
    emitBatch(run);
  };

  const schedule = (run: ActiveRun) => {
    if (active !== run || run.state !== "running") return;
    clearTimer(run);
    run.timer = scope.setTimeout(
      () => emitBatch(run),
      Math.max(1, Math.round(4 / run.speed)),
    );
  };

  return (command) => {
    if (command.type === "start") {
      if (active) {
        const superseded = active;
        clearTimer(superseded);
        active = null;
        scope.postMessage({
          type: "cancelled",
          identity: superseded.identity,
          reason: "superseded",
        });
      }
      try {
        const scenario = structuredClone(
          command.restore?.scenario ?? command.scenario,
        );
        const architecture = structuredClone(
          command.restore?.architecture ?? command.architecture,
        );
        if (
          scenario.id !== command.identity.scenarioId ||
          architecture.id !== command.identity.architectureId
        )
          throw new Error(
            "Restored simulation inputs do not match the new run identity.",
          );
        const actions = simulationActionScheduleSchema.parse(
          command.restore?.actions ?? command.actions ?? [],
        );
        const result = simulate(scenario, architecture, { actions });
        const nextFrame = command.restore?.cursor.nextFrame ?? 0;
        const nextEvent = command.restore?.cursor.nextEvent ?? 0;
        const batchIndex = command.restore?.cursor.batchIndex ?? 0;
        if (
          !Number.isInteger(nextFrame) ||
          !Number.isInteger(nextEvent) ||
          !Number.isInteger(batchIndex) ||
          nextFrame < 0 ||
          nextFrame > result.frames.length ||
          nextEvent < 0 ||
          nextEvent > result.events.length ||
          batchIndex < 0
        )
          throw new Error("Restored simulation cursor is outside the run.");
        const restoredDeliveredSecond = deliveredSecondFor(result, nextFrame);
        let expectedNextEvent = 0;
        while (
          expectedNextEvent < result.events.length &&
          (result.events[expectedNextEvent]?.second ??
            Number.POSITIVE_INFINITY) <=
            (restoredDeliveredSecond ?? Number.NEGATIVE_INFINITY)
        )
          expectedNextEvent += 1;
        if (nextFrame >= result.frames.length)
          expectedNextEvent = result.events.length;
        if (
          command.restore &&
          (command.restore.version !== 1 ||
            command.restore.restoration !==
              "deterministic-replay-from-second-zero" ||
            command.restore.opaqueRuntimeStateSerialized !== false ||
            command.restore.cursor.deliveredSecond !==
              restoredDeliveredSecond ||
            nextEvent !== expectedNextEvent)
        )
          throw new Error(
            "Restored simulation cursor is inconsistent with delivered output.",
          );
        if (
          command.restore &&
          (fingerprint(deliveredPrefix(result, nextFrame, nextEvent)) !==
            command.restore.prefixFingerprint ||
            fingerprint(result) !== command.restore.resultFingerprint)
        )
          throw new Error(
            "Restored simulation replay does not match its captured fingerprint.",
          );
        const run: ActiveRun = {
          identity: command.identity,
          scenario,
          architecture,
          actions,
          result,
          batchSize: Number.isFinite(command.batchSize)
            ? Math.max(1, Math.floor(command.batchSize))
            : 1,
          speed: boundedSpeed(command.speed),
          state: command.restore ? "paused" : "running",
          nextFrame,
          nextEvent,
          batchIndex,
          snapshotSequence: 0,
          timer: null,
        };
        active = run;
        scope.postMessage({
          type: "started",
          identity: run.identity,
          totalFrames: result.frames.length,
          totalEvents: result.events.length,
          speed: run.speed,
        });
        if (result.frames.length === 0 && result.events.length === 0)
          finish(run);
        else if (run.state === "paused")
          scope.postMessage({ type: "paused", identity: run.identity });
        else schedule(run);
      } catch (error) {
        scope.postMessage({
          type: "error",
          identity: command.identity,
          error:
            error instanceof Error
              ? error.message
              : "The local simulation failed.",
        });
      }
      return;
    }

    const run = active;
    if (!run || !sameIdentity(run.identity, command.identity)) return;
    if (command.type === "cancel") {
      clearTimer(run);
      active = null;
      scope.postMessage({ type: "cancelled", identity: run.identity });
      return;
    }
    if (command.type === "pause") {
      if (run.state !== "paused") {
        run.state = "paused";
        clearTimer(run);
      }
      scope.postMessage({ type: "paused", identity: run.identity });
      return;
    }
    if (command.type === "resume") {
      run.state = "running";
      scope.postMessage({ type: "running", identity: run.identity });
      schedule(run);
      return;
    }
    if (command.type === "step") {
      if (run.state !== "paused") {
        rejectCommand(run, "step", "Pause the run before stepping it.");
        return;
      }
      emitBatch(run, true);
      return;
    }
    if (command.type === "inject-incident") {
      applyAction(run, command.action);
      return;
    }
    if (command.type === "apply-intervention") {
      applyAction(run, command.action);
      return;
    }
    if (command.type === "snapshot") {
      if (run.state !== "paused") {
        rejectCommand(
          run,
          "snapshot",
          "Pause the run before capturing a replay snapshot.",
        );
        return;
      }
      run.snapshotSequence += 1;
      scope.postMessage({
        type: "snapshot-created",
        identity: run.identity,
        snapshot: sessionSnapshot(
          run,
          `${run.identity.runId}-snapshot-${run.snapshotSequence}`,
        ),
      });
      return;
    }
    if (command.type === "fork") {
      if (run.state !== "paused") {
        rejectCommand(
          run,
          "fork",
          "Pause the run before capturing a replay fork.",
        );
        return;
      }
      const forkKey = command.forkKey
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .slice(0, 40);
      if (!forkKey) {
        rejectCommand(run, "fork", "A fork key is required.");
        return;
      }
      run.snapshotSequence += 1;
      scope.postMessage({
        type: "fork-created",
        identity: run.identity,
        forkKey,
        snapshot: sessionSnapshot(
          run,
          `${run.identity.runId}-fork-${forkKey}-${run.snapshotSequence}`,
        ),
      });
      return;
    }
    if (command.type === "finish") {
      emitRemaining(run);
      return;
    }
    run.speed = boundedSpeed(command.speed);
    scope.postMessage({
      type: "speed",
      identity: run.identity,
      speed: run.speed,
    });
    if (run.state === "running") schedule(run);
  };
};

if (
  typeof WorkerGlobalScope !== "undefined" &&
  self instanceof WorkerGlobalScope
) {
  const dispatch = createSimulationWorkerRuntime({
    postMessage: (message) => self.postMessage(message),
    setTimeout: (callback, delay) => self.setTimeout(callback, delay),
    clearTimeout: (timer) => self.clearTimeout(timer),
  });
  self.onmessage = (event: MessageEvent<SimulationWorkerCommand>) =>
    dispatch(event.data);
}
