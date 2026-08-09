import {
  architectureSchema,
  candidateScenario,
  nodeBehavioralProfileEvidenceSchema,
  scenarioSchema,
  simulationActionScheduleSchema,
  type Architecture,
  type NodeBehavioralProfileEvidence,
  type Scenario,
  type SimulationAction,
} from "@systemforge/contracts";
import {
  COMPLETED_RUN_MANIFEST_VERSION,
  type CompletedRunArtifact,
  type CompletedRunReplaySource,
  type CompletedRunResultDigest,
} from "./completedRun";
import {
  ENGINE_VERSION,
  resolveBehavioralProfileEvidence,
} from "@systemforge/sim-core";

export const COMPLETED_RUN_REPLAY_BUNDLE_VERSION = 1 as const;
export const MAX_COMPLETED_RUN_REPLAY_BUNDLE_BYTES = 2_000_000;

const REPLAY_BUNDLE_KIND = "systemforge.completed-run-replay" as const;
const REPLAY_DIGEST_ALGORITHMS = ["sha256-canonical-json-v1"] as const;
const RESULT_DIGEST_ALGORITHMS = [
  "reported-result-digest",
  "sha256-result-json-v1",
  "fnv1a64-result-json-v1",
] as const;
const RESULT_DIGEST_SOURCES = [
  "result",
  "browser",
  "browser-fallback",
] as const;

type ReplayDigestAlgorithm = (typeof REPLAY_DIGEST_ALGORITHMS)[number];
type DigestProvider = Pick<SubtleCrypto, "digest">;

export interface CompletedRunReplayDigest {
  algorithm: ReplayDigestAlgorithm;
  value: string;
}

export interface CompletedRunReplayBundle {
  replayBundleVersion: typeof COMPLETED_RUN_REPLAY_BUNDLE_VERSION;
  kind: typeof REPLAY_BUNDLE_KIND;
  privacyScope: "candidate-safe";
  source: {
    runId: string;
    manifestVersion: typeof COMPLETED_RUN_MANIFEST_VERSION;
    engineVersion: string;
    seed: number;
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
    resultDigest: CompletedRunResultDigest;
  };
  inputs: {
    scenario: Scenario;
    architecture: Architecture;
    actionSchedule: SimulationAction[];
  };
  modelEvidence: {
    behavioralProfiles: NodeBehavioralProfileEvidence[];
    output: "deterministic-modeled-run";
    restoration: "deterministic-replay-from-second-zero";
    opaqueRuntimeStateSerialized: false;
  };
  integrity: {
    inputDigest: CompletedRunReplayDigest;
    actionScheduleDigest: CompletedRunReplayDigest;
    payloadDigest: CompletedRunReplayDigest;
  };
}

export type CompletedRunReplayBundleErrorCode =
  | "too-large"
  | "invalid-json"
  | "manifest-only"
  | "unsupported-version"
  | "invalid-shape"
  | "private-content"
  | "integrity-mismatch"
  | "digest-unavailable";

export class CompletedRunReplayBundleError extends Error {
  constructor(
    readonly code: CompletedRunReplayBundleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CompletedRunReplayBundleError";
  }
}

export interface CompletedRunReplayBundleComparison {
  sourceRunId: string;
  comparisonRunId: string;
  inputDigestMatched: boolean;
  actionScheduleMatched: boolean;
  sameDeterministicInputs: boolean;
  runtimeStateCompared: false;
}

export interface CompletedRunReplayCompatibility {
  compatible: boolean;
  engineVersionMatched: boolean;
  behavioralProfilesMatched: boolean;
  currentEngineVersion: string;
  issues: string[];
}

export interface CompletedRunReplayExportAvailability {
  allowed: boolean;
  reason: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const canonicalJson = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new CompletedRunReplayBundleError(
        "invalid-shape",
        "Replay bundles cannot contain non-finite numbers.",
      );
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new CompletedRunReplayBundleError(
    "invalid-shape",
    "Replay bundles contain an unsupported value.",
  );
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const digestValue = async (
  value: unknown,
  digestProvider: DigestProvider | null | undefined,
): Promise<CompletedRunReplayDigest> => {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  if (!digestProvider)
    throw new CompletedRunReplayBundleError(
      "digest-unavailable",
      "This browser cannot verify the replay bundle SHA-256 digest.",
    );
  try {
    return {
      algorithm: "sha256-canonical-json-v1",
      value: bytesToHex(
        new Uint8Array(await digestProvider.digest("SHA-256", bytes)),
      ),
    };
  } catch {
    throw new CompletedRunReplayBundleError(
      "digest-unavailable",
      "This browser could not verify the replay bundle SHA-256 digest.",
    );
  }
};

const sameDigest = (
  left: CompletedRunReplayDigest,
  right: CompletedRunReplayDigest,
): boolean => left.algorithm === right.algorithm && left.value === right.value;

const assertBoundedString = (
  value: unknown,
  label: string,
  maximumLength: number,
): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength
  )
    throw new CompletedRunReplayBundleError(
      "invalid-shape",
      `${label} is missing or outside its supported length.`,
    );
  return value;
};

const assertBoundedInteger = (
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number => {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new CompletedRunReplayBundleError(
      "invalid-shape",
      `${label} is outside its supported range.`,
    );
  return value;
};

const parseReplayDigest = (
  value: unknown,
  label: string,
): CompletedRunReplayDigest => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["algorithm", "value"]) ||
    !REPLAY_DIGEST_ALGORITHMS.includes(value.algorithm as ReplayDigestAlgorithm)
  )
    throw new CompletedRunReplayBundleError(
      "invalid-shape",
      `${label} is not a supported replay digest.`,
    );
  const digest = assertBoundedString(value.value, `${label} value`, 128);
  const expectedLength = 64;
  if (digest.length !== expectedLength || !/^[a-f0-9]+$/u.test(digest))
    throw new CompletedRunReplayBundleError(
      "invalid-shape",
      `${label} has an invalid digest value.`,
    );
  return {
    algorithm: value.algorithm as ReplayDigestAlgorithm,
    value: digest,
  };
};

const parseResultDigest = (value: unknown): CompletedRunResultDigest => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["algorithm", "value", "source"]) ||
    !RESULT_DIGEST_ALGORITHMS.includes(
      value.algorithm as CompletedRunResultDigest["algorithm"],
    ) ||
    !RESULT_DIGEST_SOURCES.includes(
      value.source as CompletedRunResultDigest["source"],
    )
  )
    throw new CompletedRunReplayBundleError(
      "invalid-shape",
      "The source result digest is invalid.",
    );
  return {
    algorithm: value.algorithm as CompletedRunResultDigest["algorithm"],
    value: assertBoundedString(value.value, "Source result digest", 256),
    source: value.source as CompletedRunResultDigest["source"],
  };
};

const parseRevisionIdentity = (
  value: unknown,
  label: "scenario" | "architecture",
): { id: string; schemaVersion: number; revision: number } => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "schemaVersion", "revision"])
  )
    throw new CompletedRunReplayBundleError(
      "invalid-shape",
      `The source ${label} identity is invalid.`,
    );
  return {
    id: assertBoundedString(value.id, `Source ${label} ID`, 80),
    schemaVersion: assertBoundedInteger(
      value.schemaVersion,
      `Source ${label} schema version`,
      1,
      10_000,
    ),
    revision: assertBoundedInteger(
      value.revision,
      `Source ${label} revision`,
      0,
      2_147_483_647,
    ),
  };
};

const assertCandidateSafe = (scenario: Scenario): void => {
  if (
    scenario.requirements.some(
      (requirement) => requirement.visibility === "hidden",
    ) ||
    Boolean(scenario.interview?.interviewerBrief)
  )
    throw new CompletedRunReplayBundleError(
      "private-content",
      "Replay bundles cannot contain hidden requirements or interviewer notes.",
    );
};

export const completedRunReplayExportAvailability = (
  artifact: CompletedRunArtifact,
): CompletedRunReplayExportAvailability => {
  const hasPrivateInterviewerContent =
    Boolean(artifact.scenario.interview?.interviewerBrief) ||
    artifact.scenario.requirements.some(
      (requirement) => requirement.visibility === "hidden",
    );
  return hasPrivateInterviewerContent
    ? {
        allowed: false,
        reason:
          "Private interviewer runs cannot be exported as replay bundles. Open or complete the candidate-safe scenario first.",
      }
    : { allowed: true, reason: null };
};

const normalizeProfileEvidence = (
  value: unknown,
  architecture: Architecture,
): NodeBehavioralProfileEvidence[] => {
  if (!Array.isArray(value) || value.length !== architecture.nodes.length)
    throw new CompletedRunReplayBundleError(
      "invalid-shape",
      "Behavioral profile evidence must contain one record for every architecture node.",
    );
  const evidence = value.map((entry) => {
    const parsed = nodeBehavioralProfileEvidenceSchema.safeParse(entry);
    if (!parsed.success)
      throw new CompletedRunReplayBundleError(
        "invalid-shape",
        "Behavioral profile evidence contains an unsupported record.",
      );
    return parsed.data;
  });
  const byNodeId = new Map(architecture.nodes.map((node) => [node.id, node]));
  const seenNodeIds = new Set<string>();
  for (const entry of evidence) {
    const node = byNodeId.get(entry.nodeId);
    if (!node || node.kind !== entry.nodeKind || seenNodeIds.has(entry.nodeId))
      throw new CompletedRunReplayBundleError(
        "invalid-shape",
        "Behavioral profile evidence does not match the replay architecture.",
      );
    seenNodeIds.add(entry.nodeId);
  }
  return evidence;
};

type ReplayPayload = Omit<CompletedRunReplayBundle, "integrity">;

const replayInputPayload = (bundle: ReplayPayload) => ({
  scenario: bundle.inputs.scenario,
  architecture: bundle.inputs.architecture,
});

const replayActionPayload = (bundle: ReplayPayload) =>
  bundle.inputs.actionSchedule;

const replayPayload = (bundle: ReplayPayload) => bundle;

const normalizedReplayPayload = (
  artifact: CompletedRunArtifact,
): ReplayPayload => {
  const availability = completedRunReplayExportAvailability(artifact);
  if (!availability.allowed)
    throw new CompletedRunReplayBundleError(
      "private-content",
      availability.reason ?? "This completed run contains private content.",
    );
  const scenario = scenarioSchema.parse(
    candidateScenario(structuredClone(artifact.scenario)),
  );
  const architecture = architectureSchema.parse(
    structuredClone(artifact.architecture),
  );
  const actionSchedule = simulationActionScheduleSchema.parse(
    structuredClone(artifact.manifest.simulationActions),
  );
  const behavioralProfiles = normalizeProfileEvidence(
    structuredClone(artifact.manifest.behavioralProfiles),
    architecture,
  );
  assertCandidateSafe(scenario);
  return {
    replayBundleVersion: COMPLETED_RUN_REPLAY_BUNDLE_VERSION,
    kind: REPLAY_BUNDLE_KIND,
    privacyScope: "candidate-safe",
    source: {
      runId: artifact.manifest.runId,
      manifestVersion: artifact.manifest.manifestVersion,
      engineVersion: artifact.manifest.engineVersion,
      seed: artifact.manifest.seed,
      scenario: structuredClone(artifact.manifest.scenario),
      architecture: structuredClone(artifact.manifest.architecture),
      resultDigest: structuredClone(artifact.manifest.resultDigest),
    },
    inputs: { scenario, architecture, actionSchedule },
    modelEvidence: {
      behavioralProfiles,
      output: "deterministic-modeled-run",
      restoration: "deterministic-replay-from-second-zero",
      opaqueRuntimeStateSerialized: false,
    },
  };
};

export const createCompletedRunReplayBundle = async (
  artifact: CompletedRunArtifact,
  digestProvider: DigestProvider | null | undefined = globalThis.crypto?.subtle,
): Promise<CompletedRunReplayBundle> => {
  const payload = normalizedReplayPayload(artifact);
  const [inputDigest, actionScheduleDigest, payloadDigest] = await Promise.all([
    digestValue(replayInputPayload(payload), digestProvider),
    digestValue(replayActionPayload(payload), digestProvider),
    digestValue(replayPayload(payload), digestProvider),
  ]);
  return {
    ...payload,
    integrity: { inputDigest, actionScheduleDigest, payloadDigest },
  };
};

export const buildCompletedRunReplayBundleExport = async (
  artifact: CompletedRunArtifact,
  digestProvider: DigestProvider | null | undefined = globalThis.crypto?.subtle,
): Promise<string> =>
  JSON.stringify(
    await createCompletedRunReplayBundle(artifact, digestProvider),
    null,
    2,
  );

const parseReplayPayload = (value: Record<string, unknown>): ReplayPayload => {
  if (
    !hasExactKeys(value, [
      "replayBundleVersion",
      "kind",
      "privacyScope",
      "source",
      "inputs",
      "modelEvidence",
      "integrity",
    ])
  )
    throw new CompletedRunReplayBundleError(
      "invalid-shape",
      "This file is not a supported SystemForge replay bundle.",
    );
  if (
    value.replayBundleVersion !== COMPLETED_RUN_REPLAY_BUNDLE_VERSION ||
    value.kind !== REPLAY_BUNDLE_KIND
  )
    throw new CompletedRunReplayBundleError(
      "unsupported-version",
      "This replay bundle version is not supported by this SystemForge build.",
    );
  if (value.privacyScope !== "candidate-safe")
    throw new CompletedRunReplayBundleError(
      "private-content",
      "Only candidate-safe replay bundles can be opened.",
    );
  if (
    !isRecord(value.inputs) ||
    !hasExactKeys(value.inputs, ["scenario", "architecture", "actionSchedule"])
  )
    throw new CompletedRunReplayBundleError(
      "invalid-shape",
      "Replay inputs are missing or invalid.",
    );
  const parsedScenario = scenarioSchema.safeParse(value.inputs.scenario);
  const parsedArchitecture = architectureSchema.safeParse(
    value.inputs.architecture,
  );
  const parsedActions = simulationActionScheduleSchema.safeParse(
    value.inputs.actionSchedule,
  );
  if (
    !parsedScenario.success ||
    !parsedArchitecture.success ||
    !parsedActions.success
  )
    throw new CompletedRunReplayBundleError(
      "invalid-shape",
      "Replay scenario, architecture, or action schedule failed validation.",
    );
  assertCandidateSafe(parsedScenario.data);

  if (
    !isRecord(value.source) ||
    !hasExactKeys(value.source, [
      "runId",
      "manifestVersion",
      "engineVersion",
      "seed",
      "scenario",
      "architecture",
      "resultDigest",
    ])
  )
    throw new CompletedRunReplayBundleError(
      "invalid-shape",
      "Replay source evidence is missing or invalid.",
    );
  if (value.source.manifestVersion !== COMPLETED_RUN_MANIFEST_VERSION)
    throw new CompletedRunReplayBundleError(
      "unsupported-version",
      "This completed-run manifest version is not supported by this SystemForge build.",
    );
  const sourceScenario = parseRevisionIdentity(
    value.source.scenario,
    "scenario",
  );
  const sourceArchitecture = parseRevisionIdentity(
    value.source.architecture,
    "architecture",
  );
  const source = {
    runId: assertBoundedString(value.source.runId, "Source run ID", 120),
    manifestVersion: COMPLETED_RUN_MANIFEST_VERSION,
    engineVersion: assertBoundedString(
      value.source.engineVersion,
      "Source engine version",
      40,
    ),
    seed: assertBoundedInteger(
      value.source.seed,
      "Source seed",
      0,
      2_147_483_647,
    ),
    scenario: sourceScenario,
    architecture: sourceArchitecture,
    resultDigest: parseResultDigest(value.source.resultDigest),
  };
  if (
    source.seed !== parsedScenario.data.seed ||
    sourceScenario.id !== parsedScenario.data.id ||
    sourceScenario.schemaVersion !== parsedScenario.data.schemaVersion ||
    sourceArchitecture.id !== parsedArchitecture.data.id ||
    sourceArchitecture.schemaVersion !== parsedArchitecture.data.schemaVersion
  )
    throw new CompletedRunReplayBundleError(
      "invalid-shape",
      "Replay source identity does not match its deterministic inputs.",
    );

  if (
    !isRecord(value.modelEvidence) ||
    !hasExactKeys(value.modelEvidence, [
      "behavioralProfiles",
      "output",
      "restoration",
      "opaqueRuntimeStateSerialized",
    ]) ||
    value.modelEvidence.output !== "deterministic-modeled-run" ||
    value.modelEvidence.restoration !==
      "deterministic-replay-from-second-zero" ||
    value.modelEvidence.opaqueRuntimeStateSerialized !== false
  )
    throw new CompletedRunReplayBundleError(
      "invalid-shape",
      "Replay model evidence has an unsupported boundary.",
    );
  const behavioralProfiles = normalizeProfileEvidence(
    value.modelEvidence.behavioralProfiles,
    parsedArchitecture.data,
  );
  return {
    replayBundleVersion: COMPLETED_RUN_REPLAY_BUNDLE_VERSION,
    kind: REPLAY_BUNDLE_KIND,
    privacyScope: "candidate-safe",
    source,
    inputs: {
      scenario: parsedScenario.data,
      architecture: parsedArchitecture.data,
      actionSchedule: parsedActions.data,
    },
    modelEvidence: {
      behavioralProfiles,
      output: "deterministic-modeled-run",
      restoration: "deterministic-replay-from-second-zero",
      opaqueRuntimeStateSerialized: false,
    },
  };
};

export const parseCompletedRunReplayBundle = async (
  serialized: string,
  digestProvider: DigestProvider | null | undefined = globalThis.crypto?.subtle,
): Promise<CompletedRunReplayBundle> => {
  if (
    new TextEncoder().encode(serialized).byteLength >
    MAX_COMPLETED_RUN_REPLAY_BUNDLE_BYTES
  )
    throw new CompletedRunReplayBundleError(
      "too-large",
      `Replay bundles are limited to ${MAX_COMPLETED_RUN_REPLAY_BUNDLE_BYTES.toLocaleString("en-US")} bytes.`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    throw new CompletedRunReplayBundleError(
      "invalid-json",
      "The selected file is not valid JSON.",
    );
  }
  if (
    isRecord(raw) &&
    raw.manifestExportVersion === 1 &&
    raw.privacyScope === "completed-run-manifest-only"
  )
    throw new CompletedRunReplayBundleError(
      "manifest-only",
      "Completed-run manifest files are evidence only and cannot be replayed. Select a replay bundle containing sanitized inputs.",
    );
  if (!isRecord(raw))
    throw new CompletedRunReplayBundleError(
      "invalid-shape",
      "This file is not a supported SystemForge replay bundle.",
    );
  const payload = parseReplayPayload(raw);
  if (!isRecord(raw.integrity))
    throw new CompletedRunReplayBundleError(
      "invalid-shape",
      "Replay bundle integrity evidence is missing.",
    );
  if (
    !hasExactKeys(raw.integrity, [
      "inputDigest",
      "actionScheduleDigest",
      "payloadDigest",
    ])
  )
    throw new CompletedRunReplayBundleError(
      "invalid-shape",
      "Replay bundle integrity evidence is invalid.",
    );
  const integrity = {
    inputDigest: parseReplayDigest(
      raw.integrity.inputDigest,
      "Replay input digest",
    ),
    actionScheduleDigest: parseReplayDigest(
      raw.integrity.actionScheduleDigest,
      "Replay action-schedule digest",
    ),
    payloadDigest: parseReplayDigest(
      raw.integrity.payloadDigest,
      "Replay payload digest",
    ),
  };
  const rawInputs = raw.inputs as Record<string, unknown>;
  const rawPayload = {
    replayBundleVersion: raw.replayBundleVersion,
    kind: raw.kind,
    privacyScope: raw.privacyScope,
    source: raw.source,
    inputs: raw.inputs,
    modelEvidence: raw.modelEvidence,
  };
  const [inputDigest, actionScheduleDigest, payloadDigest] = await Promise.all([
    digestValue(
      {
        scenario: rawInputs.scenario,
        architecture: rawInputs.architecture,
      },
      digestProvider,
    ),
    digestValue(rawInputs.actionSchedule, digestProvider),
    digestValue(rawPayload, digestProvider),
  ]);
  if (
    !sameDigest(inputDigest, integrity.inputDigest) ||
    !sameDigest(actionScheduleDigest, integrity.actionScheduleDigest) ||
    !sameDigest(payloadDigest, integrity.payloadDigest)
  )
    throw new CompletedRunReplayBundleError(
      "integrity-mismatch",
      "Replay bundle integrity verification failed. The file may be incomplete or modified.",
    );
  return { ...payload, integrity };
};

export const readCompletedRunReplayBundleFile = async (
  file: Pick<File, "size" | "text">,
  digestProvider: DigestProvider | null | undefined = globalThis.crypto?.subtle,
): Promise<CompletedRunReplayBundle> => {
  if (file.size > MAX_COMPLETED_RUN_REPLAY_BUNDLE_BYTES)
    throw new CompletedRunReplayBundleError(
      "too-large",
      `Replay bundles are limited to ${MAX_COMPLETED_RUN_REPLAY_BUNDLE_BYTES.toLocaleString("en-US")} bytes.`,
    );
  return parseCompletedRunReplayBundle(await file.text(), digestProvider);
};

export const downloadCompletedRunReplayBundle = async (
  artifact: CompletedRunArtifact,
): Promise<void> => {
  const serialized = await buildCompletedRunReplayBundleExport(artifact);
  if (
    new TextEncoder().encode(serialized).byteLength >
    MAX_COMPLETED_RUN_REPLAY_BUNDLE_BYTES
  )
    throw new CompletedRunReplayBundleError(
      "too-large",
      "This completed run exceeds the supported replay-bundle size.",
    );
  const blob = new Blob([serialized], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const safeRunId =
    artifact.manifest.runId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) ||
    "completed-run";
  anchor.href = url;
  anchor.download = `systemforge-${safeRunId}-replay.json`;
  anchor.click();
  URL.revokeObjectURL(url);
};

export const assessCompletedRunReplayCompatibility = (
  bundle: CompletedRunReplayBundle,
): CompletedRunReplayCompatibility => {
  const engineVersionMatched = bundle.source.engineVersion === ENGINE_VERSION;
  let behavioralProfilesMatched = false;
  let profileIssue: string | null = null;
  try {
    const currentEvidence = resolveBehavioralProfileEvidence(
      bundle.inputs.architecture,
    );
    behavioralProfilesMatched =
      canonicalJson(currentEvidence) ===
      canonicalJson(bundle.modelEvidence.behavioralProfiles);
    if (!behavioralProfilesMatched)
      profileIssue =
        "The current behavioral-profile registry does not reproduce the source evidence.";
  } catch (error) {
    profileIssue =
      error instanceof Error
        ? `The current behavioral-profile registry rejected these inputs: ${error.message}`
        : "The current behavioral-profile registry rejected these inputs.";
  }
  const issues = [
    ...(engineVersionMatched
      ? []
      : [
          `This bundle requires engine ${bundle.source.engineVersion}; this build runs ${ENGINE_VERSION}.`,
        ]),
    ...(profileIssue ? [profileIssue] : []),
  ];
  return {
    compatible: engineVersionMatched && behavioralProfilesMatched,
    engineVersionMatched,
    behavioralProfilesMatched,
    currentEngineVersion: ENGINE_VERSION,
    issues,
  };
};

export const completedRunReplaySourceFromBundle = (
  bundle: CompletedRunReplayBundle,
): CompletedRunReplaySource => ({
  scenario: structuredClone(bundle.inputs.scenario),
  architecture: structuredClone(bundle.inputs.architecture),
  manifest: {
    runId: bundle.source.runId,
    resultDigest: structuredClone(bundle.source.resultDigest),
    simulationActions: structuredClone(bundle.inputs.actionSchedule),
  },
});

export const compareCompletedRunReplayBundles = (
  source: CompletedRunReplayBundle,
  comparison: CompletedRunReplayBundle,
): CompletedRunReplayBundleComparison => {
  const inputDigestMatched = sameDigest(
    source.integrity.inputDigest,
    comparison.integrity.inputDigest,
  );
  const actionScheduleMatched =
    sameDigest(
      source.integrity.actionScheduleDigest,
      comparison.integrity.actionScheduleDigest,
    ) &&
    canonicalJson(source.inputs.actionSchedule) ===
      canonicalJson(comparison.inputs.actionSchedule);
  return {
    sourceRunId: source.source.runId,
    comparisonRunId: comparison.source.runId,
    inputDigestMatched,
    actionScheduleMatched,
    sameDeterministicInputs: inputDigestMatched && actionScheduleMatched,
    runtimeStateCompared: false,
  };
};
