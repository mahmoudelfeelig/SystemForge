import type { MetricFrame, SimulationResult } from "@systemforge/contracts";
import { digestCompletedRunResult } from "./completedRun";
import {
  assessCompletedRunReplayCompatibility,
  type CompletedRunReplayBundle,
} from "./replayBundle";

export const REPLAY_COMPARISON_VERSION = 1 as const;
export const REPLAY_COMPARISON_WORK_UNIT_BUDGET = 2_000_000;
export const REPLAY_COMPARISON_WALL_CLOCK_LIMIT_MS = 20_000;

export interface ReplayComparisonMetricDelta {
  source: number;
  comparison: number;
  delta: number;
  aggregation:
    | "maximum-aligned-frame"
    | "minimum-aligned-frame"
    | "completed-run-objective-pass-rate";
}

export interface SynchronizedReplayComparisonResult {
  comparisonVersion: typeof REPLAY_COMPARISON_VERSION;
  source: {
    runId: string;
    sourceResultDigest: CompletedRunReplayBundle["source"]["resultDigest"];
    recomputedResultDigest: CompletedRunReplayBundle["source"]["resultDigest"];
    resultDigestMatched: boolean;
    passedObjectives: number;
    totalObjectives: number;
  };
  comparison: {
    runId: string;
    sourceResultDigest: CompletedRunReplayBundle["source"]["resultDigest"];
    recomputedResultDigest: CompletedRunReplayBundle["source"]["resultDigest"];
    resultDigestMatched: boolean;
    passedObjectives: number;
    totalObjectives: number;
  };
  timeline: {
    alignedFrameCount: number;
    firstModeledSecond: number;
    lastModeledSecond: number;
  };
  metrics: {
    objectivePassRatePercentage: ReplayComparisonMetricDelta;
    p95LatencyMs: ReplayComparisonMetricDelta;
    errorRatePercentagePoints: ReplayComparisonMetricDelta;
    availabilityPercentagePoints: ReplayComparisonMetricDelta;
    monthlyCostEur: ReplayComparisonMetricDelta;
  };
  verified: boolean;
  workUnits: number;
  boundary: {
    execution: "two-fresh-deterministic-recomputations";
    alignment: "modeled-second";
    opaqueRuntimeStateRestored: false;
    productionTelemetryCompared: false;
  };
}

export interface ReplayComparisonProgress {
  completedBranches: number;
  totalBranches: 2;
  progress: number;
}

export type ReplayComparisonWorkerCommand =
  | {
      type: "start";
      requestId: string;
      source: CompletedRunReplayBundle;
      comparison: CompletedRunReplayBundle;
      workUnitBudget: number;
      maxWallClockMs: number;
    }
  | { type: "cancel"; requestId: string };

export type ReplayComparisonWorkerMessage =
  | {
      type: "started";
      requestId: string;
      workUnits: number;
    }
  | ({
      type: "progress";
      requestId: string;
    } & ReplayComparisonProgress)
  | {
      type: "complete";
      requestId: string;
      result: SynchronizedReplayComparisonResult;
    }
  | { type: "cancelled"; requestId: string }
  | { type: "error"; requestId: string; error: string };

export type ReplayComparisonSessionState =
  "running" | "complete" | "cancelled" | "error";

export interface ReplayComparisonSession {
  readonly requestId: string;
  readonly state: ReplayComparisonSessionState;
  readonly result: Promise<SynchronizedReplayComparisonResult>;
  cancel: () => void;
}

export interface StartReplayComparisonOptions {
  requestId: string;
  workUnitBudget?: number;
  maxWallClockMs?: number;
  onProgress?: (progress: ReplayComparisonProgress) => void;
  onStateChange?: (state: ReplayComparisonSessionState) => void;
}

export class ReplayComparisonCancelledError extends Error {
  readonly code = "replay_comparison_cancelled";

  constructor(readonly requestId: string) {
    super(`Replay comparison ${requestId} was cancelled.`);
    this.name = "ReplayComparisonCancelledError";
  }
}

const rounded = (value: number, digits = 6): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const maximum = (values: number[]): number =>
  values.length === 0 ? 0 : Math.max(...values);

const minimum = (values: number[]): number =>
  values.length === 0 ? 0 : Math.min(...values);

const metricDelta = (
  source: number,
  comparison: number,
  aggregation: ReplayComparisonMetricDelta["aggregation"],
): ReplayComparisonMetricDelta => ({
  source: rounded(source),
  comparison: rounded(comparison),
  delta: rounded(comparison - source),
  aggregation,
});

const sameResultDigest = (
  left: CompletedRunReplayBundle["source"]["resultDigest"],
  right: CompletedRunReplayBundle["source"]["resultDigest"],
): boolean => left.algorithm === right.algorithm && left.value === right.value;

const recomputedDigestForSource = (
  result: SimulationResult,
  sourceDigest: CompletedRunReplayBundle["source"]["resultDigest"],
) =>
  digestCompletedRunResult(
    result,
    sourceDigest.algorithm === "fnv1a64-result-json-v1"
      ? null
      : globalThis.crypto?.subtle,
  );

const alignedFrames = (
  source: SimulationResult,
  comparison: SimulationResult,
): Array<{ source: MetricFrame; comparison: MetricFrame }> => {
  const comparisonBySecond = new Map(
    comparison.frames.map((frame) => [frame.second, frame]),
  );
  return source.frames.flatMap((frame) => {
    const comparisonFrame = comparisonBySecond.get(frame.second);
    return comparisonFrame
      ? [{ source: frame, comparison: comparisonFrame }]
      : [];
  });
};

const objectivePassRatePercentage = (result: SimulationResult): number =>
  result.score.total === 0
    ? 100
    : (result.score.passed / result.score.total) * 100;

export const estimateReplayComparisonWorkUnits = (
  bundle: CompletedRunReplayBundle,
): number => {
  const scenario = bundle.inputs.scenario;
  const architecture = bundle.inputs.architecture;
  const perSecond =
    1 +
    architecture.nodes.length +
    architecture.edges.length +
    (scenario.workload.requestMix?.length ?? 1) +
    scenario.incidents.length +
    (scenario.stochasticIncidents?.rules.length ?? 0) +
    bundle.inputs.actionSchedule.length;
  return scenario.workload.durationSeconds * perSecond;
};

export const summarizeSynchronizedReplayComparison = async (
  sourceBundle: CompletedRunReplayBundle,
  sourceResult: SimulationResult,
  comparisonBundle: CompletedRunReplayBundle,
  comparisonResult: SimulationResult,
  workUnits = estimateReplayComparisonWorkUnits(sourceBundle) +
    estimateReplayComparisonWorkUnits(comparisonBundle),
): Promise<SynchronizedReplayComparisonResult> => {
  const frames = alignedFrames(sourceResult, comparisonResult);
  if (frames.length === 0)
    throw new Error(
      "The replay branches did not produce any matching modeled seconds.",
    );
  const [sourceResultDigest, comparisonResultDigest] = await Promise.all([
    recomputedDigestForSource(sourceResult, sourceBundle.source.resultDigest),
    recomputedDigestForSource(
      comparisonResult,
      comparisonBundle.source.resultDigest,
    ),
  ]);
  const sourceP95 = maximum(frames.map((entry) => entry.source.p95LatencyMs));
  const comparisonP95 = maximum(
    frames.map((entry) => entry.comparison.p95LatencyMs),
  );
  const sourceErrorRate = maximum(
    frames.map((entry) => entry.source.errorRate),
  );
  const comparisonErrorRate = maximum(
    frames.map((entry) => entry.comparison.errorRate),
  );
  const sourceAvailability = minimum(
    frames.map((entry) => entry.source.availability),
  );
  const comparisonAvailability = minimum(
    frames.map((entry) => entry.comparison.availability),
  );
  const sourceCost = maximum(
    frames.map((entry) => entry.source.monthlyCostEur),
  );
  const comparisonCost = maximum(
    frames.map((entry) => entry.comparison.monthlyCostEur),
  );
  const sourceDigestMatched = sameResultDigest(
    sourceBundle.source.resultDigest,
    sourceResultDigest,
  );
  const comparisonDigestMatched = sameResultDigest(
    comparisonBundle.source.resultDigest,
    comparisonResultDigest,
  );
  return {
    comparisonVersion: REPLAY_COMPARISON_VERSION,
    source: {
      runId: sourceBundle.source.runId,
      sourceResultDigest: structuredClone(sourceBundle.source.resultDigest),
      recomputedResultDigest: sourceResultDigest,
      resultDigestMatched: sourceDigestMatched,
      passedObjectives: sourceResult.score.passed,
      totalObjectives: sourceResult.score.total,
    },
    comparison: {
      runId: comparisonBundle.source.runId,
      sourceResultDigest: structuredClone(comparisonBundle.source.resultDigest),
      recomputedResultDigest: comparisonResultDigest,
      resultDigestMatched: comparisonDigestMatched,
      passedObjectives: comparisonResult.score.passed,
      totalObjectives: comparisonResult.score.total,
    },
    timeline: {
      alignedFrameCount: frames.length,
      firstModeledSecond: frames[0]!.source.second,
      lastModeledSecond: frames.at(-1)!.source.second,
    },
    metrics: {
      objectivePassRatePercentage: metricDelta(
        objectivePassRatePercentage(sourceResult),
        objectivePassRatePercentage(comparisonResult),
        "completed-run-objective-pass-rate",
      ),
      p95LatencyMs: metricDelta(
        sourceP95,
        comparisonP95,
        "maximum-aligned-frame",
      ),
      errorRatePercentagePoints: metricDelta(
        sourceErrorRate,
        comparisonErrorRate,
        "maximum-aligned-frame",
      ),
      availabilityPercentagePoints: metricDelta(
        sourceAvailability,
        comparisonAvailability,
        "minimum-aligned-frame",
      ),
      monthlyCostEur: metricDelta(
        sourceCost,
        comparisonCost,
        "maximum-aligned-frame",
      ),
    },
    verified: sourceDigestMatched && comparisonDigestMatched,
    workUnits,
    boundary: {
      execution: "two-fresh-deterministic-recomputations",
      alignment: "modeled-second",
      opaqueRuntimeStateRestored: false,
      productionTelemetryCompared: false,
    },
  };
};

const rejectedSession = (
  requestId: string,
  error: Error,
): ReplayComparisonSession => ({
  requestId,
  state: "error",
  result: Promise.reject(error),
  cancel: () => undefined,
});

export const startSynchronizedReplayComparison = (
  source: CompletedRunReplayBundle,
  comparison: CompletedRunReplayBundle,
  options: StartReplayComparisonOptions,
): ReplayComparisonSession => {
  const sourceCompatibility = assessCompletedRunReplayCompatibility(source);
  const comparisonCompatibility =
    assessCompletedRunReplayCompatibility(comparison);
  if (!sourceCompatibility.compatible || !comparisonCompatibility.compatible)
    return rejectedSession(
      options.requestId,
      new Error(
        [...sourceCompatibility.issues, ...comparisonCompatibility.issues].join(
          " ",
        ) || "A replay branch is not compatible with this build.",
      ),
    );
  const requestedBudget =
    options.workUnitBudget ?? REPLAY_COMPARISON_WORK_UNIT_BUDGET;
  if (!Number.isFinite(requestedBudget) || requestedBudget < 1)
    return rejectedSession(
      options.requestId,
      new Error("Replay comparison workUnitBudget must be positive."),
    );
  const workUnitBudget = Math.min(
    requestedBudget,
    REPLAY_COMPARISON_WORK_UNIT_BUDGET,
  );
  const workUnits =
    estimateReplayComparisonWorkUnits(source) +
    estimateReplayComparisonWorkUnits(comparison);
  if (workUnits > workUnitBudget)
    return rejectedSession(
      options.requestId,
      new Error(
        `Replay comparison requires ${Math.round(workUnits).toLocaleString("en-US")} work units, above the ${Math.round(workUnitBudget).toLocaleString("en-US")} browser budget.`,
      ),
    );
  const requestedWallClockMs =
    options.maxWallClockMs ?? REPLAY_COMPARISON_WALL_CLOCK_LIMIT_MS;
  if (!Number.isFinite(requestedWallClockMs) || requestedWallClockMs < 1)
    return rejectedSession(
      options.requestId,
      new Error("Replay comparison maxWallClockMs must be positive."),
    );
  const maxWallClockMs = Math.min(
    requestedWallClockMs,
    REPLAY_COMPARISON_WALL_CLOCK_LIMIT_MS,
  );

  let worker: Worker;
  try {
    worker = new Worker(
      new URL("../workers/replayComparison.worker.ts", import.meta.url),
      { type: "module" },
    );
  } catch {
    return rejectedSession(
      options.requestId,
      new Error("The browser could not start the replay-comparison worker."),
    );
  }
  let state: ReplayComparisonSessionState = "running";
  let settled = false;
  let resolveResult!: (result: SynchronizedReplayComparisonResult) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<SynchronizedReplayComparisonResult>(
    (resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    },
  );
  const timeout = globalThis.setTimeout(() => {
    fail(
      new Error("Replay comparison exceeded its wall-clock safety limit."),
      "error",
    );
  }, maxWallClockMs);

  function fail(
    error: Error,
    nextState: Extract<ReplayComparisonSessionState, "cancelled" | "error">,
  ) {
    if (settled) return;
    settled = true;
    state = nextState;
    globalThis.clearTimeout(timeout);
    worker.terminate();
    options.onStateChange?.(nextState);
    rejectResult(error);
  }

  worker.onmessage = (event: MessageEvent<ReplayComparisonWorkerMessage>) => {
    const message = event.data;
    if (settled || message.requestId !== options.requestId) return;
    if (message.type === "progress") {
      options.onProgress?.({
        completedBranches: message.completedBranches,
        totalBranches: 2,
        progress: message.progress,
      });
      return;
    }
    if (message.type === "cancelled") {
      fail(new ReplayComparisonCancelledError(options.requestId), "cancelled");
      return;
    }
    if (message.type === "error") {
      fail(new Error(message.error), "error");
      return;
    }
    if (message.type === "complete") {
      settled = true;
      state = "complete";
      globalThis.clearTimeout(timeout);
      worker.terminate();
      options.onStateChange?.("complete");
      resolveResult(message.result);
    }
  };
  worker.onerror = () => {
    fail(new Error("The replay-comparison worker failed."), "error");
  };
  worker.postMessage({
    type: "start",
    requestId: options.requestId,
    source,
    comparison,
    workUnitBudget,
    maxWallClockMs,
  } satisfies ReplayComparisonWorkerCommand);

  return {
    requestId: options.requestId,
    get state() {
      return state;
    },
    result,
    cancel: () => {
      if (settled) return;
      worker.postMessage({ type: "cancel", requestId: options.requestId });
      fail(new ReplayComparisonCancelledError(options.requestId), "cancelled");
    },
  };
};
