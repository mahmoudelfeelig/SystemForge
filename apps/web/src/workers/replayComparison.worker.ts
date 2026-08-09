/// <reference lib="webworker" />

import type { SimulationResult } from "@systemforge/contracts";
import { simulate } from "@systemforge/sim-core";
import {
  estimateReplayComparisonWorkUnits,
  REPLAY_COMPARISON_WALL_CLOCK_LIMIT_MS,
  REPLAY_COMPARISON_WORK_UNIT_BUDGET,
  summarizeSynchronizedReplayComparison,
  type ReplayComparisonWorkerCommand,
  type ReplayComparisonWorkerMessage,
} from "../lib/replayComparison";
import { assessCompletedRunReplayCompatibility } from "../lib/replayBundle";

declare const self: DedicatedWorkerGlobalScope;

export interface ReplayComparisonWorkerRuntimeScope {
  postMessage: (message: ReplayComparisonWorkerMessage) => void;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (timer: number) => void;
  now: () => number;
}

export const createReplayComparisonWorkerRuntime = (
  scope: ReplayComparisonWorkerRuntimeScope,
): ((command: ReplayComparisonWorkerCommand) => void) => {
  type ActiveComparison = {
    request: Extract<ReplayComparisonWorkerCommand, { type: "start" }>;
    startedAt: number;
    timer: number | null;
    sourceResult: SimulationResult | null;
  };

  let active: ActiveComparison | null = null;

  const clearTimer = (comparison: ActiveComparison) => {
    if (comparison.timer !== null) scope.clearTimeout(comparison.timer);
    comparison.timer = null;
  };

  const finishWithError = (comparison: ActiveComparison, error: unknown) => {
    if (active === comparison) {
      clearTimer(comparison);
      active = null;
    }
    scope.postMessage({
      type: "error",
      requestId: comparison.request.requestId,
      error:
        error instanceof Error
          ? error.message
          : "Replay comparison failed without a result.",
    });
  };

  const exceededWallClock = (comparison: ActiveComparison): boolean =>
    scope.now() - comparison.startedAt >= comparison.request.maxWallClockMs;

  const scheduleComparisonBranch = (comparison: ActiveComparison) => {
    comparison.timer = scope.setTimeout(() => {
      comparison.timer = null;
      if (active !== comparison) return;
      if (exceededWallClock(comparison)) {
        finishWithError(
          comparison,
          new Error("Replay comparison exceeded its wall-clock safety limit."),
        );
        return;
      }
      try {
        const comparisonResult = simulate(
          structuredClone(comparison.request.comparison.inputs.scenario),
          structuredClone(comparison.request.comparison.inputs.architecture),
          {
            actions: structuredClone(
              comparison.request.comparison.inputs.actionSchedule,
            ),
          },
        );
        if (exceededWallClock(comparison)) {
          finishWithError(
            comparison,
            new Error(
              "Replay comparison exceeded its wall-clock safety limit.",
            ),
          );
          return;
        }
        scope.postMessage({
          type: "progress",
          requestId: comparison.request.requestId,
          completedBranches: 2,
          totalBranches: 2,
          progress: 1,
        });
        void summarizeSynchronizedReplayComparison(
          comparison.request.source,
          comparison.sourceResult!,
          comparison.request.comparison,
          comparisonResult,
          estimateReplayComparisonWorkUnits(comparison.request.source) +
            estimateReplayComparisonWorkUnits(comparison.request.comparison),
        ).then(
          (result) => {
            if (active !== comparison) return;
            active = null;
            scope.postMessage({
              type: "complete",
              requestId: comparison.request.requestId,
              result,
            });
          },
          (error: unknown) => finishWithError(comparison, error),
        );
      } catch (error) {
        finishWithError(comparison, error);
      }
    }, 0);
  };

  return (command) => {
    if (command.type === "cancel") {
      if (active?.request.requestId !== command.requestId) return;
      clearTimer(active);
      active = null;
      scope.postMessage({ type: "cancelled", requestId: command.requestId });
      return;
    }

    if (active) {
      const replaced = active;
      clearTimer(replaced);
      active = null;
      scope.postMessage({
        type: "cancelled",
        requestId: replaced.request.requestId,
      });
    }
    const sourceCompatibility = assessCompletedRunReplayCompatibility(
      command.source,
    );
    const comparisonCompatibility = assessCompletedRunReplayCompatibility(
      command.comparison,
    );
    if (
      !sourceCompatibility.compatible ||
      !comparisonCompatibility.compatible
    ) {
      scope.postMessage({
        type: "error",
        requestId: command.requestId,
        error:
          [
            ...sourceCompatibility.issues,
            ...comparisonCompatibility.issues,
          ].join(" ") || "A replay branch is not compatible with this build.",
      });
      return;
    }
    const workUnitBudget = Math.min(
      command.workUnitBudget,
      REPLAY_COMPARISON_WORK_UNIT_BUDGET,
    );
    const workUnits =
      estimateReplayComparisonWorkUnits(command.source) +
      estimateReplayComparisonWorkUnits(command.comparison);
    if (
      !Number.isFinite(command.workUnitBudget) ||
      command.workUnitBudget < 1 ||
      workUnits > workUnitBudget
    ) {
      scope.postMessage({
        type: "error",
        requestId: command.requestId,
        error: `Replay comparison requires ${Math.round(workUnits).toLocaleString("en-US")} work units, above the browser budget.`,
      });
      return;
    }
    const maxWallClockMs = Math.min(
      command.maxWallClockMs,
      REPLAY_COMPARISON_WALL_CLOCK_LIMIT_MS,
    );
    if (!Number.isFinite(maxWallClockMs) || maxWallClockMs < 1) {
      scope.postMessage({
        type: "error",
        requestId: command.requestId,
        error: "Replay comparison maxWallClockMs must be positive.",
      });
      return;
    }
    const comparison: ActiveComparison = {
      request: { ...command, workUnitBudget, maxWallClockMs },
      startedAt: scope.now(),
      timer: null,
      sourceResult: null,
    };
    active = comparison;
    scope.postMessage({
      type: "started",
      requestId: command.requestId,
      workUnits,
    });
    scope.postMessage({
      type: "progress",
      requestId: command.requestId,
      completedBranches: 0,
      totalBranches: 2,
      progress: 0,
    });
    comparison.timer = scope.setTimeout(() => {
      comparison.timer = null;
      if (active !== comparison) return;
      try {
        comparison.sourceResult = simulate(
          structuredClone(command.source.inputs.scenario),
          structuredClone(command.source.inputs.architecture),
          {
            actions: structuredClone(command.source.inputs.actionSchedule),
          },
        );
        if (exceededWallClock(comparison)) {
          finishWithError(
            comparison,
            new Error(
              "Replay comparison exceeded its wall-clock safety limit.",
            ),
          );
          return;
        }
        scope.postMessage({
          type: "progress",
          requestId: command.requestId,
          completedBranches: 1,
          totalBranches: 2,
          progress: 0.5,
        });
        scheduleComparisonBranch(comparison);
      } catch (error) {
        finishWithError(comparison, error);
      }
    }, 0);
  };
};

const dispatch = createReplayComparisonWorkerRuntime({
  postMessage: (message) => self.postMessage(message),
  setTimeout: (callback, delay) => self.setTimeout(callback, delay),
  clearTimeout: (timer) => self.clearTimeout(timer),
  now: () => performance.now(),
});

self.onmessage = (event: MessageEvent<ReplayComparisonWorkerCommand>) => {
  dispatch(event.data);
};
