/// <reference lib="webworker" />

import {
  aggregateRobustnessSamples,
  DEFAULT_ROBUSTNESS_WORK_UNIT_BUDGET,
  estimateRobustnessWorkUnits,
  MAX_ROBUSTNESS_SEEDS,
  robustnessSeedSample,
  simulate,
  type RobustnessSeedSample,
} from "@systemforge/sim-core";
import {
  ROBUSTNESS_ANALYSIS_WALL_CLOCK_LIMIT_MS,
  type RobustnessAnalysisIdentity,
  type RobustnessWorkerCommand,
  type RobustnessWorkerMessage,
} from "../lib/robustnessAnalysis";

declare const self: DedicatedWorkerGlobalScope;

export interface RobustnessWorkerRuntimeScope {
  postMessage: (message: RobustnessWorkerMessage) => void;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (timer: number) => void;
  now: () => number;
}

const sameIdentity = (
  left: RobustnessAnalysisIdentity,
  right: RobustnessAnalysisIdentity,
): boolean =>
  left.requestId === right.requestId &&
  left.scenarioRevision === right.scenarioRevision &&
  left.architectureRevision === right.architectureRevision &&
  left.scenarioId === right.scenarioId &&
  left.architectureId === right.architectureId;

export const createRobustnessWorkerRuntime = (
  scope: RobustnessWorkerRuntimeScope,
): ((command: RobustnessWorkerCommand) => void) => {
  type ActiveAnalysis = {
    identity: RobustnessAnalysisIdentity;
    scenario: Extract<RobustnessWorkerCommand, { type: "start" }>["scenario"];
    architecture: Extract<
      RobustnessWorkerCommand,
      { type: "start" }
    >["architecture"];
    seeds: number[];
    samples: RobustnessSeedSample[];
    workUnits: number;
    maxWallClockMs: number;
    startedAt: number;
    nextSeedIndex: number;
    timer: number | null;
  };

  let active: ActiveAnalysis | null = null;

  const clearTimer = (analysis: ActiveAnalysis) => {
    if (analysis.timer !== null) scope.clearTimeout(analysis.timer);
    analysis.timer = null;
  };

  const finishWithError = (
    identity: RobustnessAnalysisIdentity,
    error: unknown,
  ) => {
    const analysis = active;
    if (analysis && sameIdentity(analysis.identity, identity)) {
      clearTimer(analysis);
      active = null;
    }
    scope.postMessage({
      type: "error",
      identity,
      error:
        error instanceof Error
          ? error.message
          : "Robustness analysis failed without a result.",
    });
  };

  const runNextSeed = (analysis: ActiveAnalysis) => {
    clearTimer(analysis);
    if (active !== analysis) return;
    if (scope.now() - analysis.startedAt >= analysis.maxWallClockMs) {
      finishWithError(
        analysis.identity,
        new Error("Robustness analysis exceeded its wall-clock safety limit."),
      );
      return;
    }

    try {
      const seed = analysis.seeds[analysis.nextSeedIndex]!;
      analysis.samples.push(
        robustnessSeedSample(
          simulate(
            { ...structuredClone(analysis.scenario), seed },
            structuredClone(analysis.architecture),
            { includeTraces: false },
          ),
        ),
      );
      analysis.nextSeedIndex += 1;

      if (scope.now() - analysis.startedAt > analysis.maxWallClockMs) {
        finishWithError(
          analysis.identity,
          new Error(
            "Robustness analysis exceeded its wall-clock safety limit.",
          ),
        );
        return;
      }

      const totalSeeds = analysis.seeds.length;
      scope.postMessage({
        type: "progress",
        identity: analysis.identity,
        completedSeeds: analysis.nextSeedIndex,
        totalSeeds,
        progress: analysis.nextSeedIndex / totalSeeds,
      });

      if (analysis.nextSeedIndex >= totalSeeds) {
        active = null;
        scope.postMessage({
          type: "complete",
          identity: analysis.identity,
          result: aggregateRobustnessSamples(
            analysis.seeds,
            analysis.samples,
            analysis.workUnits,
          ),
        });
        return;
      }
      analysis.timer = scope.setTimeout(() => runNextSeed(analysis), 0);
    } catch (error) {
      finishWithError(analysis.identity, error);
    }
  };

  return (command) => {
    if (command.type === "cancel") {
      const analysis = active;
      if (!analysis || !sameIdentity(analysis.identity, command.identity))
        return;
      clearTimer(analysis);
      active = null;
      scope.postMessage({ type: "cancelled", identity: analysis.identity });
      return;
    }

    if (active) {
      const superseded = active;
      clearTimer(superseded);
      active = null;
      scope.postMessage({
        type: "cancelled",
        identity: superseded.identity,
      });
    }

    try {
      if (
        command.identity.scenarioId !== command.scenario.id ||
        command.identity.architectureId !== command.architecture.id
      )
        throw new Error(
          "Robustness analysis identity does not match its inputs.",
        );
      if (
        !Number.isInteger(command.seedCount) ||
        command.seedCount < 2 ||
        command.seedCount > MAX_ROBUSTNESS_SEEDS
      )
        throw new Error(
          `seedCount must be an integer between 2 and ${MAX_ROBUSTNESS_SEEDS}.`,
        );
      if (!Number.isInteger(command.seedStride) || command.seedStride < 1)
        throw new Error("seedStride must be a positive integer.");
      if (
        !Number.isFinite(command.workUnitBudget) ||
        command.workUnitBudget < 1
      )
        throw new Error("workUnitBudget must be positive.");
      if (
        !Number.isFinite(command.maxWallClockMs) ||
        command.maxWallClockMs < 1
      )
        throw new Error("maxWallClockMs must be positive.");

      const workUnitBudget = Math.min(
        command.workUnitBudget,
        DEFAULT_ROBUSTNESS_WORK_UNIT_BUDGET,
      );
      const workUnits = estimateRobustnessWorkUnits(
        command.scenario,
        command.architecture,
        command.seedCount,
      );
      if (workUnits > workUnitBudget)
        throw new Error(
          `Robustness analysis requires ${Math.round(workUnits).toLocaleString("en-US")} work units, above the ${Math.round(workUnitBudget).toLocaleString("en-US")} browser budget.`,
        );

      const seeds = Array.from(
        { length: command.seedCount },
        (_, index) =>
          (command.scenario.seed + index * command.seedStride) % 2_147_483_648,
      );
      const analysis: ActiveAnalysis = {
        identity: command.identity,
        scenario: command.scenario,
        architecture: command.architecture,
        seeds,
        samples: [],
        workUnits,
        maxWallClockMs: Math.min(
          command.maxWallClockMs,
          ROBUSTNESS_ANALYSIS_WALL_CLOCK_LIMIT_MS,
        ),
        startedAt: scope.now(),
        nextSeedIndex: 0,
        timer: null,
      };
      active = analysis;
      scope.postMessage({
        type: "started",
        identity: analysis.identity,
        totalSeeds: seeds.length,
        workUnits,
      });
      scope.postMessage({
        type: "progress",
        identity: analysis.identity,
        completedSeeds: 0,
        totalSeeds: seeds.length,
        progress: 0,
      });
      analysis.timer = scope.setTimeout(() => runNextSeed(analysis), 0);
    } catch (error) {
      finishWithError(command.identity, error);
    }
  };
};

if (
  typeof WorkerGlobalScope !== "undefined" &&
  self instanceof WorkerGlobalScope
) {
  const dispatch = createRobustnessWorkerRuntime({
    postMessage: (message) => self.postMessage(message),
    setTimeout: (callback, delay) => self.setTimeout(callback, delay),
    clearTimeout: (timer) => self.clearTimeout(timer),
    now: () => performance.now(),
  });
  self.onmessage = (event: MessageEvent<RobustnessWorkerCommand>) =>
    dispatch(event.data);
}
