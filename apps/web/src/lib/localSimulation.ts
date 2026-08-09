import {
  analyzeTopologyExecutionBounds,
  estimateSimulationExecutionWorkUnits,
  estimateSimulationOutputMetricCells,
  estimateSimulationResultBytes,
  MAX_TOPOLOGY_FANOUT_AMPLIFICATION,
  MAX_SIMULATION_OUTPUT_METRIC_CELLS,
  MAX_SIMULATION_ESTIMATED_RESULT_BYTES,
  type Architecture,
  type CausalEvent,
  type MetricFrame,
  type Scenario,
  type SimulationAction,
  type SimulationResult,
} from "@systemforge/contracts";

export const LOCAL_SIMULATION_WORK_UNIT_LIMIT = 120_000;

export interface SimulationRunIdentity {
  runId: string;
  scenarioRevision: number;
  architectureRevision: number;
  scenarioId: string;
  architectureId: string;
}

export interface SimulationSessionSnapshot {
  version: 1;
  snapshotId: string;
  sourceRunId: string;
  scenario: Scenario;
  architecture: Architecture;
  actions: SimulationAction[];
  cursor: {
    nextFrame: number;
    nextEvent: number;
    batchIndex: number;
    deliveredSecond: number | null;
  };
  prefixFingerprint: string;
  resultFingerprint: string;
  restoration: "deterministic-replay-from-second-zero";
  opaqueRuntimeStateSerialized: false;
}

export type SimulationRunSessionState =
  | "starting"
  | "running"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "complete"
  | "error";

export type SimulationWorkerCommand =
  | {
      type: "start";
      identity: SimulationRunIdentity;
      scenario: Scenario;
      architecture: Architecture;
      actions?: SimulationAction[];
      restore?: SimulationSessionSnapshot;
      batchSize: number;
      speed: number;
    }
  | { type: "cancel"; identity: SimulationRunIdentity }
  | { type: "pause"; identity: SimulationRunIdentity }
  | { type: "resume"; identity: SimulationRunIdentity }
  | { type: "step"; identity: SimulationRunIdentity }
  | {
      type: "inject-incident";
      identity: SimulationRunIdentity;
      action: Extract<SimulationAction, { type: "inject-incident" }>;
    }
  | {
      type: "apply-intervention";
      identity: SimulationRunIdentity;
      action: Extract<SimulationAction, { type: "apply-intervention" }>;
    }
  | { type: "snapshot"; identity: SimulationRunIdentity }
  | {
      type: "fork";
      identity: SimulationRunIdentity;
      forkKey: string;
    }
  | { type: "finish"; identity: SimulationRunIdentity }
  | {
      type: "set-speed";
      identity: SimulationRunIdentity;
      speed: number;
    };

export type SimulationWorkerMessage =
  | {
      type: "started";
      identity: SimulationRunIdentity;
      totalFrames: number;
      totalEvents: number;
      speed: number;
    }
  | {
      type: "batch";
      identity: SimulationRunIdentity;
      batchIndex: number;
      frameOffset: number;
      eventOffset: number;
      frames: MetricFrame[];
      events: CausalEvent[];
      deliveredFrames: number;
      deliveredEvents: number;
      totalFrames: number;
      totalEvents: number;
      progress: number;
    }
  | { type: "paused"; identity: SimulationRunIdentity }
  | { type: "running"; identity: SimulationRunIdentity }
  | {
      type: "speed";
      identity: SimulationRunIdentity;
      speed: number;
    }
  | {
      type: "action-applied";
      identity: SimulationRunIdentity;
      action: SimulationAction;
      deliveredSecond: number | null;
      totalFrames: number;
      totalEvents: number;
    }
  | {
      type: "snapshot-created";
      identity: SimulationRunIdentity;
      snapshot: SimulationSessionSnapshot;
    }
  | {
      type: "fork-created";
      identity: SimulationRunIdentity;
      snapshot: SimulationSessionSnapshot;
      forkKey: string;
    }
  | {
      type: "command-rejected";
      identity: SimulationRunIdentity;
      command: SimulationWorkerCommand["type"];
      reason: string;
    }
  | {
      type: "cancelled";
      identity: SimulationRunIdentity;
      reason?: string;
    }
  | {
      type: "complete";
      identity: SimulationRunIdentity;
      result: SimulationResult;
    }
  | {
      type: "error";
      identity: SimulationRunIdentity;
      error: string;
    };

export interface StartLocalSimulationOptions {
  identity?: SimulationRunIdentity;
  batchSize?: number;
  speed?: number;
  timeoutMs?: number;
  actions?: SimulationAction[];
  restore?: SimulationSessionSnapshot;
  onBatch?: (
    message: Extract<SimulationWorkerMessage, { type: "batch" }>,
  ) => void;
  onStateChange?: (
    state: SimulationRunSessionState,
    message?: SimulationWorkerMessage,
  ) => void;
}

export interface LocalSimulationSession {
  readonly identity: SimulationRunIdentity;
  readonly state: SimulationRunSessionState;
  readonly result: Promise<SimulationResult>;
  cancel: () => void;
  pause: () => void;
  resume: () => void;
  step: () => void;
  injectIncident: (
    action: Extract<SimulationAction, { type: "inject-incident" }>,
  ) => void;
  applyIntervention: (
    action: Extract<SimulationAction, { type: "apply-intervention" }>,
  ) => void;
  snapshot: () => void;
  fork: (forkKey: string) => void;
  finish: () => void;
  setSpeed: (speed: number) => void;
}

export class SimulationRunCancelledError extends Error {
  readonly code = "local_simulation_cancelled";
  readonly identity: SimulationRunIdentity;

  constructor(identity: SimulationRunIdentity) {
    super(`Local simulation ${identity.runId} was cancelled.`);
    this.name = "SimulationRunCancelledError";
    this.identity = identity;
  }
}

export const localSimulationWorkUnits = (
  scenario: Scenario,
  architecture: Architecture,
  actionCount = 0,
): number =>
  estimateSimulationExecutionWorkUnits(scenario, architecture, actionCount);

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

let fallbackRunSequence = 0;

const defaultIdentity = (
  scenario: Scenario,
  architecture: Architecture,
): SimulationRunIdentity => ({
  runId: `local-${Date.now().toString(36)}-${++fallbackRunSequence}`,
  scenarioRevision: 0,
  architectureRevision: 0,
  scenarioId: scenario.id,
  architectureId: architecture.id,
});

const rejectedSession = (
  identity: SimulationRunIdentity,
  error: Error,
): LocalSimulationSession => {
  const result = Promise.reject<SimulationResult>(error);
  return {
    identity,
    state: "error",
    result,
    cancel: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    step: () => undefined,
    injectIncident: () => undefined,
    applyIntervention: () => undefined,
    snapshot: () => undefined,
    fork: () => undefined,
    finish: () => undefined,
    setSpeed: () => undefined,
  };
};

export function startLocalSimulation(
  scenario: Scenario,
  architecture: Architecture,
  options: StartLocalSimulationOptions = {},
): LocalSimulationSession {
  const admittedScenario = options.restore?.scenario ?? scenario;
  const admittedArchitecture = options.restore?.architecture ?? architecture;
  const identity =
    options.identity ?? defaultIdentity(admittedScenario, admittedArchitecture);
  const workUnits = localSimulationWorkUnits(
    admittedScenario,
    admittedArchitecture,
    options.restore?.actions.length ?? options.actions?.length ?? 0,
  );
  if (workUnits > LOCAL_SIMULATION_WORK_UNIT_LIMIT)
    return rejectedSession(
      identity,
      new Error(
        `This model exceeds the browser-local safety budget of ${LOCAL_SIMULATION_WORK_UNIT_LIMIT.toLocaleString("en-US")} work units. Reduce the duration or topology size before running it.`,
      ),
    );
  const outputMetricCells = estimateSimulationOutputMetricCells(
    admittedScenario,
    admittedArchitecture,
  );
  if (outputMetricCells > MAX_SIMULATION_OUTPUT_METRIC_CELLS)
    return rejectedSession(
      identity,
      new Error(
        `This model would emit ${outputMetricCells.toLocaleString("en-US")} frame-metric cells, above the browser-local ${MAX_SIMULATION_OUTPUT_METRIC_CELLS.toLocaleString("en-US")} result-size limit. Reduce the duration or topology size before running it.`,
      ),
    );
  const estimatedResultBytes = estimateSimulationResultBytes(
    admittedScenario,
    admittedArchitecture,
  );
  if (estimatedResultBytes > MAX_SIMULATION_ESTIMATED_RESULT_BYTES)
    return rejectedSession(
      identity,
      new Error(
        `This model's estimated ${estimatedResultBytes.toLocaleString("en-US")}-byte result exceeds the browser-local ${MAX_SIMULATION_ESTIMATED_RESULT_BYTES.toLocaleString("en-US")}-byte retention limit. Reduce the duration or topology size before running it.`,
      ),
    );
  const topologyBounds = analyzeTopologyExecutionBounds(admittedArchitecture);
  if (topologyBounds.reachableCycleNodeIds.length > 0)
    return rejectedSession(
      identity,
      new Error(
        `This model contains a reachable cycle through ${topologyBounds.reachableCycleNodeIds.join(", ")}. Remove feedback links before running it locally.`,
      ),
    );
  if (
    !Number.isFinite(topologyBounds.fanoutAmplification) ||
    topologyBounds.fanoutAmplification > MAX_TOPOLOGY_FANOUT_AMPLIFICATION
  )
    return rejectedSession(
      identity,
      new Error(
        `This model's synchronous fan-out exceeds the browser-local amplification limit of ${MAX_TOPOLOGY_FANOUT_AMPLIFICATION.toLocaleString("en-US")}. Partition the route or add explicit traffic shares before running it locally.`,
      ),
    );

  let worker: Worker;
  try {
    worker = new Worker(
      new URL("../workers/simulation.worker.ts", import.meta.url),
      { type: "module" },
    );
  } catch {
    return rejectedSession(
      identity,
      new Error("The browser could not start the local simulation worker."),
    );
  }
  const speed = boundedSpeed(options.speed ?? 1);
  const defaultBatchSize = Math.ceil(
    (admittedScenario.workload.durationSeconds + 1) / 180,
  );
  const requestedBatchSize = options.batchSize ?? defaultBatchSize;
  const batchSize = Math.max(
    1,
    Math.floor(
      Number.isFinite(requestedBatchSize)
        ? requestedBatchSize
        : defaultBatchSize,
    ),
  );
  const timeoutMs = options.timeoutMs ?? 15_000;
  let state: SimulationRunSessionState = "starting";
  let settled = false;
  let actionRecomputePending = false;
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  let resolveResult!: (result: SimulationResult) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<SimulationResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const setState = (
    next: SimulationRunSessionState,
    message?: SimulationWorkerMessage,
  ) => {
    state = next;
    options.onStateChange?.(next, message);
  };
  const clearSafetyTimeout = () => {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
    timeout = undefined;
  };
  const fail = (error: Error, next: "cancelled" | "error") => {
    if (settled) return;
    settled = true;
    clearSafetyTimeout();
    worker.terminate();
    setState(next);
    rejectResult(error);
  };
  const armSafetyTimeout = () => {
    clearSafetyTimeout();
    timeout = globalThis.setTimeout(() => {
      fail(
        new Error("The local simulation exceeded its safety time limit."),
        "error",
      );
    }, timeoutMs);
  };
  const send = (command: SimulationWorkerCommand) => {
    if (!settled) worker.postMessage(command);
  };

  worker.onmessage = (event: MessageEvent<SimulationWorkerMessage>) => {
    const message = event.data;
    if (!sameIdentity(message.identity, identity) || settled) return;
    if (message.type === "batch") {
      options.onBatch?.(message);
      return;
    }
    if (message.type === "started" || message.type === "running") {
      armSafetyTimeout();
      setState("running", message);
      return;
    }
    if (message.type === "paused") {
      actionRecomputePending = false;
      clearSafetyTimeout();
      setState("paused", message);
      return;
    }
    if (message.type === "speed") {
      options.onStateChange?.(state, message);
      return;
    }
    if (
      message.type === "action-applied" ||
      message.type === "snapshot-created" ||
      message.type === "fork-created" ||
      message.type === "command-rejected"
    ) {
      if (
        message.type === "action-applied" ||
        (message.type === "command-rejected" &&
          (message.command === "inject-incident" ||
            message.command === "apply-intervention"))
      ) {
        actionRecomputePending = false;
        if (state === "paused") clearSafetyTimeout();
      }
      options.onStateChange?.(state, message);
      return;
    }
    if (message.type === "cancelled") {
      fail(new SimulationRunCancelledError(identity), "cancelled");
      return;
    }
    if (message.type === "error") {
      fail(new Error(message.error), "error");
      return;
    }
    if (message.type === "complete") {
      settled = true;
      clearSafetyTimeout();
      worker.terminate();
      setState("complete", message);
      resolveResult(message.result);
    }
  };
  worker.onerror = () => {
    fail(
      new Error("The browser could not start the local simulation worker."),
      "error",
    );
  };

  armSafetyTimeout();
  send({
    type: "start",
    identity,
    scenario,
    architecture,
    ...(options.actions ? { actions: options.actions } : {}),
    ...(options.restore ? { restore: options.restore } : {}),
    batchSize,
    speed,
  });

  return {
    identity,
    get state() {
      return state;
    },
    result,
    cancel: () => {
      if (settled) return;
      setState("cancelling");
      worker.postMessage({ type: "cancel", identity });
      fail(new SimulationRunCancelledError(identity), "cancelled");
    },
    pause: () => send({ type: "pause", identity }),
    resume: () => send({ type: "resume", identity }),
    step: () => send({ type: "step", identity }),
    injectIncident: (action) => {
      if (actionRecomputePending || settled) return;
      actionRecomputePending = true;
      armSafetyTimeout();
      send({ type: "inject-incident", identity, action });
    },
    applyIntervention: (action) => {
      if (actionRecomputePending || settled) return;
      actionRecomputePending = true;
      armSafetyTimeout();
      send({ type: "apply-intervention", identity, action });
    },
    snapshot: () => send({ type: "snapshot", identity }),
    fork: (forkKey) => send({ type: "fork", identity, forkKey }),
    finish: () => send({ type: "finish", identity }),
    setSpeed: (nextSpeed) =>
      send({ type: "set-speed", identity, speed: boundedSpeed(nextSpeed) }),
  };
}

export function runLocalSimulation(
  scenario: Scenario,
  architecture: Architecture,
): Promise<SimulationResult> {
  return startLocalSimulation(scenario, architecture).result;
}
