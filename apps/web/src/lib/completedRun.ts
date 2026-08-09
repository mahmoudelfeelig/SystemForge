import { nodeBehavioralProfileEvidenceSchema } from "@systemforge/contracts";
import type {
  Architecture,
  CausalEvent,
  MetricFrame,
  NodeBehavioralProfileEvidence,
  Scenario,
  SimulationAction,
  SimulationResult,
} from "@systemforge/contracts";
import {
  resolveBehavioralProfileEvidence,
  simulate,
  simulationInputFingerprint,
} from "@systemforge/sim-core";
import type { SimulationRunIdentity } from "./localSimulation";

export const COMPLETED_RUN_MANIFEST_VERSION = 3 as const;

export type CompletedRunActionCommand =
  | "start"
  | "replay-start"
  | "pause"
  | "resume"
  | "step"
  | "inject-incident"
  | "apply-intervention"
  | "snapshot"
  | "fork"
  | "finish"
  | "set-speed"
  | "cancel"
  | "complete";

export interface CompletedRunAction {
  sequence: number;
  command: CompletedRunActionCommand;
  deliveredSecond: number | null;
  value?: number;
  sourceRunId?: string;
  action?: SimulationAction;
  snapshotId?: string;
  forkKey?: string;
}

export interface CompletedRunResultDigest {
  algorithm:
    | "reported-result-digest"
    | "sha256-result-json-v1"
    | "fnv1a64-result-json-v1";
  value: string;
  source: "result" | "browser" | "browser-fallback";
}

export interface DeliveredRunSnapshot {
  requestedSecond: number;
  deliveredSecond: number;
  frameIndex: number;
  selection: "exact" | "nearest-delivered-frame";
  frame: MetricFrame;
  events: CausalEvent[];
  source: "completed-modeled-output";
  recomputed: false;
}

export interface CompletedRunReplayEvidence {
  sourceRunId: string;
  identicalInputs: boolean;
  resultDigestMatched: boolean;
  verified: boolean;
}

export interface CompletedRunManifest {
  manifestVersion: typeof COMPLETED_RUN_MANIFEST_VERSION;
  runId: string;
  engineVersion: string;
  scenario: {
    id: string;
    schemaVersion: number;
    revision: number;
  };
  architecture: {
    id: string;
    schemaVersion: number;
    revision: number;
  };
  seed: number;
  behavioralProfiles: NodeBehavioralProfileEvidence[];
  resultDigest: CompletedRunResultDigest;
  actionLog: CompletedRunAction[];
  simulationActions: SimulationAction[];
  snapshot: DeliveredRunSnapshot;
  replay?: CompletedRunReplayEvidence;
  boundary: {
    output: "deterministic-modeled-run";
    snapshot: "post-run-delivered-frame";
    liveInterventionRecomputed: boolean;
    sessionRestoration: "deterministic-replay-from-second-zero";
    opaqueRuntimeStateSerialized: false;
  };
}

export interface CompletedRunReplaySource {
  manifest: Pick<
    CompletedRunManifest,
    "runId" | "resultDigest" | "simulationActions"
  >;
  scenario: Scenario;
  architecture: Architecture;
}

export interface CompletedRunArtifact extends CompletedRunReplaySource {
  manifest: CompletedRunManifest;
  result: SimulationResult;
}

export interface CompletedRunFork {
  scenario: Scenario;
  architecture: Architecture;
  snapshot: DeliveredRunSnapshot;
  provenance: {
    kind: "post-run-static-input-fork";
    sourceRunId: string;
    sourceScenarioId: string;
    sourceArchitectureId: string;
    sourceResultDigest: CompletedRunResultDigest;
    requestedSecond: number;
    deliveredSecond: number;
    originalRunRecomputed: false;
  };
}

type DigestProvider = Pick<SubtleCrypto, "digest">;

const canonicalJson = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(
        "Completed run evidence cannot contain non-finite values.",
      );
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("Completed run evidence contains an unsupported value.");
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const fnv1a64 = (bytes: Uint8Array): string => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
};

export const appendCompletedRunAction = (
  actionLog: readonly CompletedRunAction[],
  command: CompletedRunActionCommand,
  deliveredSecond: number | null,
  details: {
    value?: number;
    sourceRunId?: string;
    action?: SimulationAction;
    snapshotId?: string;
    forkKey?: string;
  } = {},
): CompletedRunAction[] => [
  ...actionLog,
  {
    sequence: actionLog.length,
    command,
    deliveredSecond:
      deliveredSecond === null || !Number.isFinite(deliveredSecond)
        ? null
        : Math.max(0, Math.floor(deliveredSecond)),
    ...(details.value !== undefined ? { value: details.value } : {}),
    ...(details.sourceRunId ? { sourceRunId: details.sourceRunId } : {}),
    ...(details.action ? { action: structuredClone(details.action) } : {}),
    ...(details.snapshotId ? { snapshotId: details.snapshotId } : {}),
    ...(details.forkKey ? { forkKey: details.forkKey } : {}),
  },
];

export const digestCompletedRunResult = async (
  result: SimulationResult,
  digestProvider: DigestProvider | null | undefined = globalThis.crypto?.subtle,
): Promise<CompletedRunResultDigest> => {
  if (result.digest)
    return {
      algorithm: "reported-result-digest",
      value: result.digest,
      source: "result",
    };
  const digestibleResult = { ...result, digest: undefined };
  const bytes = new TextEncoder().encode(canonicalJson(digestibleResult));
  if (digestProvider) {
    try {
      const digest = await digestProvider.digest("SHA-256", bytes);
      return {
        algorithm: "sha256-result-json-v1",
        value: bytesToHex(new Uint8Array(digest)),
        source: "browser",
      };
    } catch {
      // A deterministic, explicitly labeled fallback keeps local evidence usable.
    }
  }
  return {
    algorithm: "fnv1a64-result-json-v1",
    value: fnv1a64(bytes),
    source: "browser-fallback",
  };
};

export const snapshotCompletedRunAtSecond = (
  result: SimulationResult,
  requestedSecond: number,
): DeliveredRunSnapshot => {
  if (result.frames.length === 0)
    throw new Error(
      "A completed run without delivered frames cannot be snapped.",
    );
  const requested = Number.isFinite(requestedSecond)
    ? requestedSecond
    : result.frames.at(-1)!.second;
  let frameIndex = 0;
  for (let index = 1; index < result.frames.length; index += 1) {
    const candidate = result.frames[index]!;
    const current = result.frames[frameIndex]!;
    const candidateDistance = Math.abs(candidate.second - requested);
    const currentDistance = Math.abs(current.second - requested);
    if (
      candidateDistance < currentDistance ||
      (candidateDistance === currentDistance &&
        candidate.second < current.second)
    )
      frameIndex = index;
  }
  const frame = result.frames[frameIndex]!;
  return {
    requestedSecond: requested,
    deliveredSecond: frame.second,
    frameIndex,
    selection: requested === frame.second ? "exact" : "nearest-delivered-frame",
    frame: structuredClone(frame),
    events: structuredClone(
      result.events.filter((event) => event.second === frame.second),
    ),
    source: "completed-modeled-output",
    recomputed: false,
  };
};

const sameInputs = (
  scenario: Scenario,
  architecture: Architecture,
  simulationActions: readonly SimulationAction[],
  source: CompletedRunReplaySource,
): boolean =>
  canonicalJson(scenario) === canonicalJson(source.scenario) &&
  canonicalJson(architecture) === canonicalJson(source.architecture) &&
  canonicalJson(simulationActions) ===
    canonicalJson(source.manifest.simulationActions);

const sameDigest = (
  left: CompletedRunResultDigest,
  right: CompletedRunResultDigest,
): boolean => left.algorithm === right.algorithm && left.value === right.value;

export const createCompletedRunArtifact = async (input: {
  identity: SimulationRunIdentity;
  scenario: Scenario;
  architecture: Architecture;
  result: SimulationResult;
  actionLog: readonly CompletedRunAction[];
  simulationActions?: readonly SimulationAction[];
  snapshotSecond?: number;
  replayOf?: CompletedRunReplaySource;
  digestProvider?: DigestProvider | null;
}): Promise<CompletedRunArtifact> => {
  if (
    input.identity.scenarioId !== input.scenario.id ||
    input.identity.architectureId !== input.architecture.id
  )
    throw new Error("Completed run identity does not match its input drafts.");
  if (input.result.seed !== input.scenario.seed)
    throw new Error("Completed run seed does not match its scenario input.");
  const parsedProfileEvidence = nodeBehavioralProfileEvidenceSchema
    .array()
    .safeParse(input.result.behavioralProfiles);
  if (!parsedProfileEvidence.success)
    throw new Error("Completed run behavioral-profile evidence is invalid.");
  const expectedProfileEvidence = resolveBehavioralProfileEvidence(
    input.architecture,
  );
  if (
    canonicalJson(parsedProfileEvidence.data) !==
    canonicalJson(expectedProfileEvidence)
  )
    throw new Error(
      "Completed run behavioral-profile evidence does not match its architecture input.",
    );
  const simulationActions: SimulationAction[] = structuredClone([
    ...(input.simulationActions ??
      input.actionLog.flatMap((entry) => (entry.action ? [entry.action] : []))),
  ]);
  const expectedInputFingerprint = simulationInputFingerprint(
    input.scenario,
    input.architecture,
    input.result.engineVersion,
    simulationActions,
  );
  if (input.result.inputFingerprint !== expectedInputFingerprint)
    throw new Error(
      "Completed run result does not match its deterministic simulation inputs.",
    );
  const recomputedResult = simulate(input.scenario, input.architecture, {
    actions: simulationActions,
  });
  if (
    canonicalJson({ ...input.result, digest: undefined }) !==
    canonicalJson({ ...recomputedResult, digest: undefined })
  )
    throw new Error(
      "Completed run output failed deterministic input-result verification.",
    );
  const resultDigest = await digestCompletedRunResult(
    input.result,
    input.digestProvider,
  );
  const snapshot = snapshotCompletedRunAtSecond(
    input.result,
    input.snapshotSecond ?? input.result.frames.at(-1)?.second ?? 0,
  );
  const replay = input.replayOf
    ? {
        sourceRunId: input.replayOf.manifest.runId,
        identicalInputs: sameInputs(
          input.scenario,
          input.architecture,
          simulationActions,
          input.replayOf,
        ),
        resultDigestMatched: sameDigest(
          resultDigest,
          input.replayOf.manifest.resultDigest,
        ),
        verified: false,
      }
    : undefined;
  if (replay)
    replay.verified = replay.identicalInputs && replay.resultDigestMatched;
  return {
    manifest: {
      manifestVersion: COMPLETED_RUN_MANIFEST_VERSION,
      runId: input.identity.runId,
      engineVersion: input.result.engineVersion,
      scenario: {
        id: input.scenario.id,
        schemaVersion: input.scenario.schemaVersion,
        revision: input.identity.scenarioRevision,
      },
      architecture: {
        id: input.architecture.id,
        schemaVersion: input.architecture.schemaVersion,
        revision: input.identity.architectureRevision,
      },
      seed: input.result.seed,
      behavioralProfiles: structuredClone(parsedProfileEvidence.data),
      resultDigest,
      actionLog: input.actionLog.map((entry) => structuredClone(entry)),
      simulationActions,
      snapshot,
      ...(replay ? { replay } : {}),
      boundary: {
        output: "deterministic-modeled-run",
        snapshot: "post-run-delivered-frame",
        liveInterventionRecomputed: simulationActions.length > 0,
        sessionRestoration: "deterministic-replay-from-second-zero",
        opaqueRuntimeStateSerialized: false,
      },
    },
    scenario: structuredClone(input.scenario),
    architecture: structuredClone(input.architecture),
    result: input.result,
  };
};

export const withCompletedRunSnapshot = (
  artifact: CompletedRunArtifact,
  requestedSecond: number,
): CompletedRunArtifact => ({
  ...artifact,
  manifest: {
    ...artifact.manifest,
    snapshot: snapshotCompletedRunAtSecond(artifact.result, requestedSecond),
  },
});

export const completedRunReplayInputs = (
  artifact: CompletedRunReplaySource,
): {
  scenario: Scenario;
  architecture: Architecture;
  actions: SimulationAction[];
} => ({
  scenario: structuredClone(artifact.scenario),
  architecture: structuredClone(artifact.architecture),
  actions: structuredClone(artifact.manifest.simulationActions),
});

const forkedId = (sourceId: string, rawForkKey: string): string => {
  const forkKey =
    rawForkKey.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 24) || "draft";
  const suffix = `-fork-${forkKey}`;
  return `${sourceId.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`;
};

export const forkCompletedRunAtSecond = (
  artifact: CompletedRunArtifact,
  requestedSecond: number,
  forkKey: string,
): CompletedRunFork => {
  const snapshot = snapshotCompletedRunAtSecond(
    artifact.result,
    requestedSecond,
  );
  return {
    scenario: {
      ...structuredClone(artifact.scenario),
      id: forkedId(artifact.scenario.id, forkKey),
    },
    architecture: {
      ...structuredClone(artifact.architecture),
      id: forkedId(artifact.architecture.id, forkKey),
    },
    snapshot,
    provenance: {
      kind: "post-run-static-input-fork",
      sourceRunId: artifact.manifest.runId,
      sourceScenarioId: artifact.scenario.id,
      sourceArchitectureId: artifact.architecture.id,
      sourceResultDigest: artifact.manifest.resultDigest,
      requestedSecond: snapshot.requestedSecond,
      deliveredSecond: snapshot.deliveredSecond,
      originalRunRecomputed: false,
    },
  };
};
