import {
  estimateSimulationOutputMetricCells,
  estimateSimulationResultBytes,
  MAX_SIMULATION_ESTIMATED_RESULT_BYTES,
  MAX_SIMULATION_OUTPUT_METRIC_CELLS,
  type Architecture,
  type Scenario,
} from "@systemforge/contracts";
import {
  DEFAULT_ROBUSTNESS_WORK_UNIT_BUDGET,
  estimateRobustnessWorkUnits,
  MAX_ROBUSTNESS_SEEDS,
  type RobustnessResult,
} from "@systemforge/sim-core";

export const ROBUSTNESS_ANALYSIS_WALL_CLOCK_LIMIT_MS = 12_000;

export interface RobustnessAnalysisIdentity {
  requestId: string;
  scenarioRevision: number;
  architectureRevision: number;
  scenarioId: string;
  architectureId: string;
}

export interface RobustnessAnalysisProgress {
  completedSeeds: number;
  totalSeeds: number;
  progress: number;
}

export type RobustnessWorkerCommand =
  | {
      type: "start";
      identity: RobustnessAnalysisIdentity;
      scenario: Scenario;
      architecture: Architecture;
      seedCount: number;
      seedStride: number;
      workUnitBudget: number;
      maxWallClockMs: number;
    }
  | { type: "cancel"; identity: RobustnessAnalysisIdentity };

export type RobustnessWorkerMessage =
  | {
      type: "started";
      identity: RobustnessAnalysisIdentity;
      totalSeeds: number;
      workUnits: number;
    }
  | ({
      type: "progress";
      identity: RobustnessAnalysisIdentity;
    } & RobustnessAnalysisProgress)
  | {
      type: "complete";
      identity: RobustnessAnalysisIdentity;
      result: RobustnessResult;
    }
  | {
      type: "cancelled";
      identity: RobustnessAnalysisIdentity;
    }
  | {
      type: "error";
      identity: RobustnessAnalysisIdentity;
      error: string;
    };

export type RobustnessAnalysisSessionState =
  "running" | "complete" | "cancelled" | "error";

export interface RobustnessAnalysisSession {
  readonly identity: RobustnessAnalysisIdentity;
  readonly state: RobustnessAnalysisSessionState;
  readonly result: Promise<RobustnessResult>;
  cancel: () => void;
}

export interface StartRobustnessAnalysisOptions {
  identity: RobustnessAnalysisIdentity;
  seedCount?: number;
  seedStride?: number;
  workUnitBudget?: number;
  maxWallClockMs?: number;
  onProgress?: (progress: RobustnessAnalysisProgress) => void;
  onStateChange?: (state: RobustnessAnalysisSessionState) => void;
}

export class RobustnessAnalysisCancelledError extends Error {
  readonly code = "robustness_analysis_cancelled";
  readonly identity: RobustnessAnalysisIdentity;

  constructor(identity: RobustnessAnalysisIdentity) {
    super(`Robustness analysis ${identity.requestId} was cancelled.`);
    this.name = "RobustnessAnalysisCancelledError";
    this.identity = identity;
  }
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

const rejectedSession = (
  identity: RobustnessAnalysisIdentity,
  error: Error,
): RobustnessAnalysisSession => ({
  identity,
  state: "error",
  result: Promise.reject(error),
  cancel: () => undefined,
});

export function startRobustnessAnalysis(
  scenario: Scenario,
  architecture: Architecture,
  options: StartRobustnessAnalysisOptions,
): RobustnessAnalysisSession {
  const { identity } = options;
  if (
    identity.scenarioId !== scenario.id ||
    identity.architectureId !== architecture.id
  )
    return rejectedSession(
      identity,
      new Error("Robustness analysis identity does not match its inputs."),
    );

  const seedCount = options.seedCount ?? 9;
  const seedStride = options.seedStride ?? 7_919;
  if (
    !Number.isInteger(seedCount) ||
    seedCount < 2 ||
    seedCount > MAX_ROBUSTNESS_SEEDS
  )
    return rejectedSession(
      identity,
      new Error(
        `seedCount must be an integer between 2 and ${MAX_ROBUSTNESS_SEEDS}.`,
      ),
    );
  if (!Number.isInteger(seedStride) || seedStride < 1)
    return rejectedSession(
      identity,
      new Error("seedStride must be a positive integer."),
    );

  const requestedWorkUnitBudget =
    options.workUnitBudget ?? DEFAULT_ROBUSTNESS_WORK_UNIT_BUDGET;
  if (!Number.isFinite(requestedWorkUnitBudget) || requestedWorkUnitBudget < 1)
    return rejectedSession(
      identity,
      new Error("workUnitBudget must be positive."),
    );
  const workUnitBudget = Math.min(
    requestedWorkUnitBudget,
    DEFAULT_ROBUSTNESS_WORK_UNIT_BUDGET,
  );
  const workUnits = estimateRobustnessWorkUnits(
    scenario,
    architecture,
    seedCount,
  );
  if (workUnits > workUnitBudget)
    return rejectedSession(
      identity,
      new Error(
        `Robustness analysis requires ${Math.round(workUnits).toLocaleString("en-US")} work units, above the ${Math.round(workUnitBudget).toLocaleString("en-US")} browser budget.`,
      ),
    );
  const outputMetricCells = estimateSimulationOutputMetricCells(
    scenario,
    architecture,
  );
  if (outputMetricCells > MAX_SIMULATION_OUTPUT_METRIC_CELLS)
    return rejectedSession(
      identity,
      new Error(
        `Each robustness seed would emit ${outputMetricCells.toLocaleString("en-US")} frame-metric cells, above the ${MAX_SIMULATION_OUTPUT_METRIC_CELLS.toLocaleString("en-US")} browser result-size limit.`,
      ),
    );
  const estimatedResultBytes = estimateSimulationResultBytes(
    scenario,
    architecture,
  );
  if (estimatedResultBytes > MAX_SIMULATION_ESTIMATED_RESULT_BYTES)
    return rejectedSession(
      identity,
      new Error(
        `Each robustness seed's estimated ${estimatedResultBytes.toLocaleString("en-US")}-byte result exceeds the ${MAX_SIMULATION_ESTIMATED_RESULT_BYTES.toLocaleString("en-US")}-byte browser retention limit.`,
      ),
    );

  const requestedWallClockMs =
    options.maxWallClockMs ?? ROBUSTNESS_ANALYSIS_WALL_CLOCK_LIMIT_MS;
  if (!Number.isFinite(requestedWallClockMs) || requestedWallClockMs < 1)
    return rejectedSession(
      identity,
      new Error("maxWallClockMs must be positive."),
    );
  const maxWallClockMs = Math.min(
    requestedWallClockMs,
    ROBUSTNESS_ANALYSIS_WALL_CLOCK_LIMIT_MS,
  );

  let worker: Worker;
  try {
    worker = new Worker(
      new URL("../workers/robustness.worker.ts", import.meta.url),
      { type: "module" },
    );
  } catch {
    return rejectedSession(
      identity,
      new Error("The browser could not start the robustness worker."),
    );
  }

  let state: RobustnessAnalysisSessionState = "running";
  let settled = false;
  let resolveResult!: (result: RobustnessResult) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<RobustnessResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const timeout = globalThis.setTimeout(() => {
    fail(
      new Error("Robustness analysis exceeded its wall-clock safety limit."),
      "error",
    );
  }, maxWallClockMs);

  function fail(
    error: Error,
    nextState: Extract<RobustnessAnalysisSessionState, "cancelled" | "error">,
  ) {
    if (settled) return;
    settled = true;
    state = nextState;
    globalThis.clearTimeout(timeout);
    worker.terminate();
    options.onStateChange?.(nextState);
    rejectResult(error);
  }

  worker.onmessage = (event: MessageEvent<RobustnessWorkerMessage>) => {
    const message = event.data;
    if (settled || !sameIdentity(message.identity, identity)) return;
    if (message.type === "progress") {
      options.onProgress?.({
        completedSeeds: message.completedSeeds,
        totalSeeds: message.totalSeeds,
        progress: message.progress,
      });
      return;
    }
    if (message.type === "cancelled") {
      fail(new RobustnessAnalysisCancelledError(identity), "cancelled");
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
    fail(new Error("The robustness worker failed."), "error");
  };

  worker.postMessage({
    type: "start",
    identity,
    scenario,
    architecture,
    seedCount,
    seedStride,
    workUnitBudget,
    maxWallClockMs,
  } satisfies RobustnessWorkerCommand);

  return {
    identity,
    get state() {
      return state;
    },
    result,
    cancel: () => {
      if (settled) return;
      worker.postMessage({ type: "cancel", identity });
      fail(new RobustnessAnalysisCancelledError(identity), "cancelled");
    },
  };
}
