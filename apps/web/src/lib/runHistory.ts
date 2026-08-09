import {
  candidateScenario,
  type Architecture,
  type Scenario,
  type SimulationResult,
} from "@systemforge/contracts";
import { ENGINE_VERSION } from "@systemforge/sim-core";
import type {
  CompletedRunArtifact,
  CompletedRunResultDigest,
} from "./completedRun";
import {
  completedRunReplayExportAvailability,
  createCompletedRunReplayBundle,
  MAX_COMPLETED_RUN_REPLAY_BUNDLE_BYTES,
  parseCompletedRunReplayBundle,
  type CompletedRunReplayBundle,
} from "./replayBundle";

export const LOCAL_RUN_HISTORY_VERSION = 1 as const;
export const LOCAL_RUN_HISTORY_STORAGE_KEY = "systemforge:run-history:v1";
export const MAX_LOCAL_RUN_HISTORY_ENTRIES = 24;
export const MAX_LOCAL_RUN_HISTORY_BYTES = 20_000_000;
export const MAX_STARRED_RUN_HISTORY_ENTRIES = 6;
export const LOCAL_RUN_HISTORY_RETENTION_DAYS = 30;

const RUN_HISTORY_DATABASE = "systemforge-run-history";
const RUN_HISTORY_STORE = "records";
const RUN_HISTORY_RECORD_KIND = "systemforge.local-run-history" as const;
const RUN_HISTORY_EXPORT_KIND = "systemforge.local-run-history-export" as const;
const RUN_HISTORY_COMPARISON_KIND =
  "systemforge.local-run-history-comparison" as const;

export type LocalRunHistoryStatus = "completed" | "failed" | "cancelled";
export type LocalRunReplayState =
  | "available"
  | "not-completed"
  | "integrity-unavailable"
  | "too-large"
  | "evicted-for-space";

export interface LocalRunHistoryMetrics {
  objectivesPassed: number;
  objectivesTotal: number;
  p95LatencyMs: number;
  availabilityPercent: number;
  errorRatePercent: number;
  monthlyCostEur: number;
  dataLoss: number;
  durabilityPercent: number;
  recoveryTimeSeconds: number;
  operationalComplexity: number;
}

export interface LocalRunHistoryRecord {
  recordVersion: typeof LOCAL_RUN_HISTORY_VERSION;
  kind: typeof RUN_HISTORY_RECORD_KIND;
  privacyScope: "candidate-safe-system-summary-with-local-user-metadata";
  id: string;
  runId: string;
  status: LocalRunHistoryStatus;
  startedAt: string;
  finishedAt: string;
  firstRunAt: string;
  lastRunAt: string;
  repeatCount: number;
  determinismWarning: boolean;
  label: string;
  note: string;
  tags: string[];
  starred: boolean;
  engineVersion: string;
  seed: number;
  scenario: {
    id: string;
    schemaVersion: number;
    revision: number;
    name: string;
    mode: Scenario["mode"];
  };
  architecture: {
    id: string;
    schemaVersion: number;
    revision: number;
    nodeCount: number;
    edgeCount: number;
  };
  profileVersions: Array<{
    nodeId: string;
    profileId: string;
    profileVersion: number;
  }>;
  actionCount: number;
  inputFingerprint: string | null;
  replayInputDigest: string | null;
  replayActionDigest: string | null;
  resultDigest: CompletedRunResultDigest | null;
  objectiveSignatures: string[];
  metrics: LocalRunHistoryMetrics | null;
  replayState: LocalRunReplayState;
  replayBundle: string | null;
  replayBytes: number;
}

export interface LocalRunHistoryComparison {
  compatible: boolean;
  issues: string[];
  sameScenario: boolean;
  sameArchitecture: boolean;
  sameInputs: boolean;
  sameSeed: boolean;
  objectivesComparable: boolean;
  objectivePassRateDeltaPercent: number | null;
  metricDeltas: LocalRunHistoryMetrics | null;
  metricPercentDeltas: LocalRunHistoryMetrics | null;
}

export interface LocalRunHistoryStorageSnapshot {
  records: LocalRunHistoryRecord[];
  usedBytes: number;
  maximumBytes: number;
  issue: string | null;
}

export class LocalRunHistoryStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalRunHistoryStorageError";
  }
}

type DigestProvider = Pick<SubtleCrypto, "digest">;

interface RunHistoryBackend {
  read(): Promise<unknown[]>;
  write(records: readonly LocalRunHistoryRecord[]): Promise<void>;
  clear(): Promise<void>;
}

const textEncoder = new TextEncoder();
const byteLength = (value: string): number =>
  textEncoder.encode(value).byteLength;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const boundedString = (
  value: unknown,
  maximum: number,
  allowEmpty = false,
): string | null => {
  if (typeof value !== "string" || value.length > maximum) return null;
  if (!allowEmpty && value.length === 0) return null;
  return value;
};
const boundedInteger = (
  value: unknown,
  minimum: number,
  maximum: number,
): number | null =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= minimum &&
  value <= maximum
    ? value
    : null;
const isoDate = (value: unknown): string | null => {
  const parsed = boundedString(value, 48);
  return parsed && Number.isFinite(Date.parse(parsed)) ? parsed : null;
};
const clampText = (value: string, maximum: number): string =>
  value.trim().slice(0, maximum);
const containerJson = (records: readonly LocalRunHistoryRecord[]): string =>
  JSON.stringify({ version: LOCAL_RUN_HISTORY_VERSION, records });

const parseResultDigest = (value: unknown): CompletedRunResultDigest | null => {
  if (!isRecord(value)) return null;
  const algorithm = boundedString(value.algorithm, 80);
  const digest = boundedString(value.value, 256);
  const source = boundedString(value.source, 40);
  if (!algorithm || !digest || !source) return null;
  if (
    ![
      "reported-result-digest",
      "sha256-result-json-v1",
      "fnv1a64-result-json-v1",
    ].includes(algorithm) ||
    !["result", "browser", "browser-fallback"].includes(source)
  )
    return null;
  return {
    algorithm: algorithm as CompletedRunResultDigest["algorithm"],
    value: digest,
    source: source as CompletedRunResultDigest["source"],
  };
};

const parseMetrics = (value: unknown): LocalRunHistoryMetrics | null => {
  if (!isRecord(value)) return null;
  const objectivesPassed = boundedInteger(value.objectivesPassed, 0, 10_000);
  const objectivesTotal = boundedInteger(value.objectivesTotal, 0, 10_000);
  const numericKeys = [
    "p95LatencyMs",
    "availabilityPercent",
    "errorRatePercent",
    "monthlyCostEur",
    "dataLoss",
    "durabilityPercent",
    "recoveryTimeSeconds",
    "operationalComplexity",
  ] as const;
  if (
    objectivesPassed === null ||
    objectivesTotal === null ||
    objectivesPassed > objectivesTotal ||
    numericKeys.some((key) => !finite(value[key]))
  )
    return null;
  return {
    objectivesPassed,
    objectivesTotal,
    p95LatencyMs: value.p95LatencyMs as number,
    availabilityPercent: value.availabilityPercent as number,
    errorRatePercent: value.errorRatePercent as number,
    monthlyCostEur: value.monthlyCostEur as number,
    dataLoss: value.dataLoss as number,
    durabilityPercent: value.durabilityPercent as number,
    recoveryTimeSeconds: value.recoveryTimeSeconds as number,
    operationalComplexity: value.operationalComplexity as number,
  };
};

const parseRecord = (value: unknown): LocalRunHistoryRecord | null => {
  if (
    !isRecord(value) ||
    !isRecord(value.scenario) ||
    !isRecord(value.architecture)
  )
    return null;
  const id = boundedString(value.id, 160);
  const runId = boundedString(value.runId, 160);
  const startedAt = isoDate(value.startedAt);
  const finishedAt = isoDate(value.finishedAt);
  const firstRunAt = isoDate(value.firstRunAt);
  const lastRunAt = isoDate(value.lastRunAt);
  const repeatCount = boundedInteger(value.repeatCount, 1, 1_000_000);
  const label = boundedString(value.label, 80, true);
  const note = boundedString(value.note, 500, true);
  const engineVersion = boundedString(value.engineVersion, 40);
  const seed = boundedInteger(value.seed, 0, 2_147_483_647);
  const actionCount = boundedInteger(value.actionCount, 0, 10_000);
  const replayBytes = boundedInteger(
    value.replayBytes,
    0,
    MAX_COMPLETED_RUN_REPLAY_BUNDLE_BYTES,
  );
  const replayState =
    typeof value.replayState === "string" &&
    [
      "available",
      "not-completed",
      "integrity-unavailable",
      "too-large",
      "evicted-for-space",
    ].includes(value.replayState)
      ? (value.replayState as LocalRunReplayState)
      : null;
  const scenarioId = boundedString(value.scenario.id, 120);
  const scenarioName = boundedString(value.scenario.name, 160);
  const scenarioSchemaVersion = boundedInteger(
    value.scenario.schemaVersion,
    1,
    10_000,
  );
  const scenarioRevision = boundedInteger(
    value.scenario.revision,
    0,
    1_000_000,
  );
  const architectureId = boundedString(value.architecture.id, 120);
  const architectureSchemaVersion = boundedInteger(
    value.architecture.schemaVersion,
    1,
    10_000,
  );
  const architectureRevision = boundedInteger(
    value.architecture.revision,
    0,
    1_000_000,
  );
  const nodeCount = boundedInteger(value.architecture.nodeCount, 0, 500);
  const edgeCount = boundedInteger(value.architecture.edgeCount, 0, 2_000);
  if (
    value.recordVersion !== LOCAL_RUN_HISTORY_VERSION ||
    value.kind !== RUN_HISTORY_RECORD_KIND ||
    value.privacyScope !==
      "candidate-safe-system-summary-with-local-user-metadata" ||
    !id ||
    !runId ||
    !startedAt ||
    !finishedAt ||
    !firstRunAt ||
    !lastRunAt ||
    repeatCount === null ||
    typeof value.determinismWarning !== "boolean" ||
    label === null ||
    note === null ||
    typeof value.starred !== "boolean" ||
    !engineVersion ||
    seed === null ||
    actionCount === null ||
    replayBytes === null ||
    !replayState ||
    !["completed", "failed", "cancelled"].includes(String(value.status)) ||
    !scenarioId ||
    !scenarioName ||
    scenarioSchemaVersion === null ||
    scenarioRevision === null ||
    !["guided", "custom", "interview"].includes(String(value.scenario.mode)) ||
    !architectureId ||
    architectureSchemaVersion === null ||
    architectureRevision === null ||
    nodeCount === null ||
    edgeCount === null
  )
    return null;

  const tags = Array.isArray(value.tags)
    ? value.tags.slice(0, 6).flatMap((entry) => {
        const parsed = boundedString(entry, 24);
        return parsed ? [parsed] : [];
      })
    : [];
  const profiles = Array.isArray(value.profileVersions)
    ? value.profileVersions.slice(0, 500).flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const nodeId = boundedString(entry.nodeId, 80);
        const profileId = boundedString(entry.profileId, 120);
        const profileVersion = boundedInteger(entry.profileVersion, 1, 10_000);
        return nodeId && profileId && profileVersion !== null
          ? [{ nodeId, profileId, profileVersion }]
          : [];
      })
    : [];
  const objectiveSignatures = Array.isArray(value.objectiveSignatures)
    ? value.objectiveSignatures.slice(0, 100).flatMap((entry) => {
        const parsed = boundedString(entry, 360);
        return parsed ? [parsed] : [];
      })
    : [];
  const nullableString = (entry: unknown): string | null | undefined =>
    entry === null ? null : (boundedString(entry, 256) ?? undefined);
  const inputFingerprint = nullableString(value.inputFingerprint);
  const replayInputDigest = nullableString(value.replayInputDigest);
  const replayActionDigest = nullableString(value.replayActionDigest);
  const digest =
    value.resultDigest === null ? null : parseResultDigest(value.resultDigest);
  const metrics = value.metrics === null ? null : parseMetrics(value.metrics);
  const replayBundle =
    value.replayBundle === null
      ? null
      : boundedString(
          value.replayBundle,
          MAX_COMPLETED_RUN_REPLAY_BUNDLE_BYTES,
        );
  if (
    inputFingerprint === undefined ||
    replayInputDigest === undefined ||
    replayActionDigest === undefined ||
    (value.resultDigest !== null && !digest) ||
    (value.metrics !== null && !metrics) ||
    (value.replayBundle !== null && !replayBundle) ||
    (replayState === "available" &&
      (!replayBundle || replayBytes !== byteLength(replayBundle))) ||
    (replayState !== "available" && replayBundle !== null)
  )
    return null;

  return {
    recordVersion: LOCAL_RUN_HISTORY_VERSION,
    kind: RUN_HISTORY_RECORD_KIND,
    privacyScope: "candidate-safe-system-summary-with-local-user-metadata",
    id,
    runId,
    status: value.status as LocalRunHistoryStatus,
    startedAt,
    finishedAt,
    firstRunAt,
    lastRunAt,
    repeatCount,
    determinismWarning: value.determinismWarning,
    label,
    note,
    tags,
    starred: value.starred,
    engineVersion,
    seed,
    scenario: {
      id: scenarioId,
      schemaVersion: scenarioSchemaVersion,
      revision: scenarioRevision,
      name: scenarioName,
      mode: value.scenario.mode as Scenario["mode"],
    },
    architecture: {
      id: architectureId,
      schemaVersion: architectureSchemaVersion,
      revision: architectureRevision,
      nodeCount,
      edgeCount,
    },
    profileVersions: profiles,
    actionCount,
    inputFingerprint,
    replayInputDigest,
    replayActionDigest,
    resultDigest: digest,
    objectiveSignatures,
    metrics,
    replayState,
    replayBundle,
    replayBytes,
  };
};

const recordSort = (
  left: LocalRunHistoryRecord,
  right: LocalRunHistoryRecord,
): number =>
  Date.parse(right.lastRunAt) - Date.parse(left.lastRunAt) ||
  left.id.localeCompare(right.id);

const maximum = (values: readonly number[]): number =>
  values.length > 0 ? Math.max(...values) : 0;
const minimum = (values: readonly number[]): number =>
  values.length > 0 ? Math.min(...values) : 0;
const average = (values: readonly number[]): number =>
  values.length > 0
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0;

const summarizeResult = (
  scenario: Scenario,
  result: SimulationResult,
): LocalRunHistoryMetrics => {
  const visibleIds = new Set(
    candidateScenario(scenario).requirements.map(({ id }) => id),
  );
  const requirements = result.requirements.filter(({ requirement }) =>
    visibleIds.has(requirement.id),
  );
  return {
    objectivesPassed: requirements.filter(({ passed }) => passed).length,
    objectivesTotal: requirements.length,
    p95LatencyMs: maximum(result.frames.map((frame) => frame.p95LatencyMs)),
    availabilityPercent: average(
      result.frames.map((frame) => frame.availability),
    ),
    errorRatePercent: maximum(result.frames.map((frame) => frame.errorRate)),
    monthlyCostEur: maximum(result.frames.map((frame) => frame.monthlyCostEur)),
    dataLoss: result.frames.reduce((total, frame) => total + frame.dataLoss, 0),
    durabilityPercent: minimum(
      result.frames.map((frame) => frame.durabilityPercent),
    ),
    recoveryTimeSeconds: maximum(
      result.frames.map((frame) => frame.recoveryTimeSeconds),
    ),
    operationalComplexity: maximum(
      result.frames.map((frame) => frame.operationalComplexity),
    ),
  };
};

const baseRecord = (input: {
  id: string;
  runId: string;
  status: LocalRunHistoryStatus;
  startedAt: string;
  finishedAt: string;
  scenario: Scenario;
  architecture: Architecture;
  scenarioRevision: number;
  architectureRevision: number;
  engineVersion: string;
  seed: number;
  actionCount: number;
}): Omit<
  LocalRunHistoryRecord,
  | "profileVersions"
  | "inputFingerprint"
  | "replayInputDigest"
  | "replayActionDigest"
  | "resultDigest"
  | "objectiveSignatures"
  | "metrics"
  | "replayState"
  | "replayBundle"
  | "replayBytes"
> => {
  const publicScenario = candidateScenario(input.scenario);
  return {
    recordVersion: LOCAL_RUN_HISTORY_VERSION,
    kind: RUN_HISTORY_RECORD_KIND,
    privacyScope: "candidate-safe-system-summary-with-local-user-metadata",
    id: input.id,
    runId: input.runId,
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    firstRunAt: input.finishedAt,
    lastRunAt: input.finishedAt,
    repeatCount: 1,
    determinismWarning: false,
    label: publicScenario.title,
    note: "",
    tags: [],
    starred: false,
    engineVersion: input.engineVersion,
    seed: input.seed,
    scenario: {
      id: publicScenario.id,
      schemaVersion: publicScenario.schemaVersion,
      revision: input.scenarioRevision,
      name: publicScenario.title,
      mode: publicScenario.mode,
    },
    architecture: {
      id: input.architecture.id,
      schemaVersion: input.architecture.schemaVersion,
      revision: input.architectureRevision,
      nodeCount: input.architecture.nodes.length,
      edgeCount: input.architecture.edges.length,
    },
    actionCount: input.actionCount,
  };
};

const containsPrivateInterviewContent = (scenario: Scenario): boolean =>
  Boolean(scenario.interview?.interviewerBrief) ||
  scenario.requirements.some(
    (requirement) => requirement.visibility === "hidden",
  );

export const createCompletedRunHistoryRecord = async (
  artifact: CompletedRunArtifact,
  options: {
    startedAt?: string;
    finishedAt?: string;
    digestProvider?: DigestProvider | null;
  } = {},
): Promise<LocalRunHistoryRecord | null> => {
  if (containsPrivateInterviewContent(artifact.scenario)) return null;
  const finishedAt = options.finishedAt ?? new Date().toISOString();
  const record = baseRecord({
    id: artifact.manifest.runId,
    runId: artifact.manifest.runId,
    status: "completed",
    startedAt: options.startedAt ?? finishedAt,
    finishedAt,
    scenario: artifact.scenario,
    architecture: artifact.architecture,
    scenarioRevision: artifact.manifest.scenario.revision,
    architectureRevision: artifact.manifest.architecture.revision,
    engineVersion: artifact.manifest.engineVersion,
    seed: artifact.manifest.seed,
    actionCount: artifact.manifest.actionLog.length,
  });
  const availability = completedRunReplayExportAvailability(artifact);
  let replayState: LocalRunReplayState = "integrity-unavailable";
  let replayBundle: string | null = null;
  let replayBytes = 0;
  let replayInputDigest: string | null = null;
  let replayActionDigest: string | null = null;
  if (availability.allowed) {
    try {
      const bundle = await createCompletedRunReplayBundle(
        artifact,
        options.digestProvider === undefined
          ? globalThis.crypto?.subtle
          : options.digestProvider,
      );
      replayBundle = JSON.stringify(bundle);
      replayBytes = byteLength(replayBundle);
      if (replayBytes > MAX_COMPLETED_RUN_REPLAY_BUNDLE_BYTES) {
        replayState = "too-large";
        replayBundle = null;
        replayBytes = 0;
      } else {
        replayState = "available";
        replayInputDigest = bundle.integrity.inputDigest.value;
        replayActionDigest = bundle.integrity.actionScheduleDigest.value;
      }
    } catch {
      replayState = "integrity-unavailable";
    }
  }
  return {
    ...record,
    profileVersions: artifact.result.behavioralProfiles.flatMap((entry) =>
      entry.status === "resolved"
        ? [
            {
              nodeId: entry.nodeId,
              profileId: entry.profileId,
              profileVersion: entry.profileVersion,
            },
          ]
        : [],
    ),
    inputFingerprint: artifact.result.inputFingerprint,
    replayInputDigest,
    replayActionDigest,
    resultDigest: structuredClone(artifact.manifest.resultDigest),
    objectiveSignatures: candidateScenario(artifact.scenario)
      .requirements.map(({ id, metric, operator, target, unit }) =>
        JSON.stringify([id, metric, operator, target, unit]),
      )
      .sort(),
    metrics: summarizeResult(artifact.scenario, artifact.result),
    replayState,
    replayBundle,
    replayBytes,
  };
};

export const createTerminalRunHistoryRecord = (input: {
  identity: {
    runId: string;
    scenarioRevision: number;
    architectureRevision: number;
  };
  status: Exclude<LocalRunHistoryStatus, "completed">;
  startedAt: string;
  finishedAt?: string;
  scenario: Scenario;
  architecture: Architecture;
  actionCount: number;
}): LocalRunHistoryRecord | null => {
  if (containsPrivateInterviewContent(input.scenario)) return null;
  return {
    ...baseRecord({
      id: input.identity.runId,
      runId: input.identity.runId,
      status: input.status,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt ?? new Date().toISOString(),
      scenario: input.scenario,
      architecture: input.architecture,
      scenarioRevision: input.identity.scenarioRevision,
      architectureRevision: input.identity.architectureRevision,
      engineVersion: ENGINE_VERSION,
      seed: input.scenario.seed,
      actionCount: input.actionCount,
    }),
    profileVersions: [],
    inputFingerprint: null,
    replayInputDigest: null,
    replayActionDigest: null,
    resultDigest: null,
    objectiveSignatures: [],
    metrics: null,
    replayState: "not-completed",
    replayBundle: null,
    replayBytes: 0,
  };
};

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed."));
  });

let databasePromise: Promise<IDBDatabase> | null = null;
const openDatabase = (): Promise<IDBDatabase> => {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(RUN_HISTORY_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(RUN_HISTORY_STORE))
        request.result.createObjectStore(RUN_HISTORY_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB open failed."));
  });
  return databasePromise;
};

const indexedDbBackend: RunHistoryBackend = {
  async read() {
    const database = await openDatabase();
    const transaction = database.transaction(RUN_HISTORY_STORE, "readonly");
    return requestResult(transaction.objectStore(RUN_HISTORY_STORE).getAll());
  },
  async write(records) {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(RUN_HISTORY_STORE, "readwrite");
      const store = transaction.objectStore(RUN_HISTORY_STORE);
      store.clear();
      for (const record of records) store.put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("IndexedDB write failed."));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("IndexedDB write aborted."));
    });
  },
  async clear() {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(RUN_HISTORY_STORE, "readwrite");
      transaction.objectStore(RUN_HISTORY_STORE).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("IndexedDB clear failed."));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("IndexedDB clear aborted."));
    });
  },
};

const localStorageBackend: RunHistoryBackend = {
  read() {
    const serialized = localStorage.getItem(LOCAL_RUN_HISTORY_STORAGE_KEY);
    if (!serialized) return Promise.resolve([]);
    const parsed = JSON.parse(serialized) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.records))
      throw new Error("Unsupported local run history.");
    return Promise.resolve(parsed.records as unknown[]);
  },
  write(records) {
    localStorage.setItem(LOCAL_RUN_HISTORY_STORAGE_KEY, containerJson(records));
    return Promise.resolve();
  },
  clear() {
    localStorage.removeItem(LOCAL_RUN_HISTORY_STORAGE_KEY);
    return Promise.resolve();
  },
};

let backendOverride: RunHistoryBackend | null = null;
const storageBackend = (): RunHistoryBackend =>
  backendOverride ??
  (typeof indexedDB === "undefined" ? localStorageBackend : indexedDbBackend);

export const setLocalRunHistoryBackendForTests = (
  backend: RunHistoryBackend | null,
): void => {
  backendOverride = backend;
};

const snapshot = (
  records: LocalRunHistoryRecord[],
  issue: string | null = null,
): LocalRunHistoryStorageSnapshot => ({
  records,
  usedBytes: byteLength(containerJson(records)),
  maximumBytes: MAX_LOCAL_RUN_HISTORY_BYTES,
  issue,
});

const fitForStorage = (
  input: readonly LocalRunHistoryRecord[],
  now = Date.now(),
): LocalRunHistoryRecord[] => {
  const cutoff = now - LOCAL_RUN_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const records = [...input]
    .filter(
      (record) => record.starred || Date.parse(record.lastRunAt) >= cutoff,
    )
    .sort(recordSort);
  while (records.length > MAX_LOCAL_RUN_HISTORY_ENTRIES) {
    const removable = records.findLastIndex((record) => !record.starred);
    if (removable < 0)
      throw new LocalRunHistoryStorageError(
        "Run history is full of starred records. Unstar one before saving another run.",
      );
    records.splice(removable, 1);
  }
  while (byteLength(containerJson(records)) > MAX_LOCAL_RUN_HISTORY_BYTES) {
    const replayCandidate = records.findLastIndex(
      (record) => !record.starred && record.replayBundle !== null,
    );
    if (replayCandidate >= 0) {
      records[replayCandidate] = {
        ...records[replayCandidate]!,
        replayState: "evicted-for-space",
        replayBundle: null,
        replayBytes: 0,
      };
      continue;
    }
    const removable = records.findLastIndex((record) => !record.starred);
    if (removable < 0)
      throw new LocalRunHistoryStorageError(
        "Starred run summaries exceed the local history budget. Unstar or delete a record before saving more history.",
      );
    records.splice(removable, 1);
  }
  return records;
};

const readRecords = async (): Promise<{
  records: LocalRunHistoryRecord[];
  invalidCount: number;
}> => {
  const raw = await storageBackend().read();
  const records = raw.flatMap((entry) => {
    const parsed = parseRecord(entry);
    return parsed ? [parsed] : [];
  });
  return { records, invalidCount: raw.length - records.length };
};

let mutationQueue: Promise<void> = Promise.resolve();
const serializeMutation = async <T>(task: () => Promise<T>): Promise<T> => {
  let release!: () => void;
  const previous = mutationQueue;
  mutationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    const locks =
      typeof navigator === "undefined"
        ? undefined
        : (
            navigator as Navigator & {
              locks?: {
                request<U>(
                  name: string,
                  callback: () => Promise<U>,
                ): Promise<U>;
              };
            }
          ).locks;
    return locks
      ? await locks.request(LOCAL_RUN_HISTORY_STORAGE_KEY, task)
      : await task();
  } finally {
    release();
  }
};

const persistRecords = async (
  records: readonly LocalRunHistoryRecord[],
): Promise<LocalRunHistoryStorageSnapshot> => {
  const fitted = fitForStorage(records);
  try {
    await storageBackend().write(fitted);
  } catch {
    throw new LocalRunHistoryStorageError(
      "The browser could not save the local Run history. Export or delete records before retrying.",
    );
  }
  return snapshot(fitted);
};

export const loadLocalRunHistory =
  async (): Promise<LocalRunHistoryStorageSnapshot> =>
    serializeMutation(async () => {
      let loaded: Awaited<ReturnType<typeof readRecords>>;
      try {
        loaded = await readRecords();
      } catch {
        return snapshot(
          [],
          "The browser could not read local Run history. No saved records were changed.",
        );
      }
      let fitted: LocalRunHistoryRecord[];
      try {
        fitted = fitForStorage(loaded.records);
      } catch {
        return snapshot(
          [],
          "Saved Run history exceeded its supported bounds. No saved records were changed.",
        );
      }
      const needsCleanup =
        loaded.invalidCount > 0 || fitted.length !== loaded.records.length;
      if (needsCleanup) {
        try {
          await storageBackend().write(fitted);
        } catch {
          return snapshot(
            fitted,
            "Invalid or expired records were ignored, but browser cleanup could not be saved.",
          );
        }
      }
      return snapshot(
        fitted,
        loaded.invalidCount > 0
          ? "One or more invalid local run records were ignored."
          : null,
      );
    });

const sameReplayInputs = (
  left: LocalRunHistoryRecord,
  right: LocalRunHistoryRecord,
): boolean =>
  left.status === "completed" &&
  right.status === "completed" &&
  left.engineVersion === right.engineVersion &&
  left.replayInputDigest !== null &&
  left.replayInputDigest === right.replayInputDigest &&
  left.replayActionDigest !== null &&
  left.replayActionDigest === right.replayActionDigest;

export const addLocalRunHistoryRecord = async (
  record: LocalRunHistoryRecord,
): Promise<LocalRunHistoryStorageSnapshot> =>
  serializeMutation(async () => {
    const current = (await readRecords()).records;
    const duplicateIndex = current.findIndex(
      (candidate) =>
        candidate.runId === record.runId ||
        (sameReplayInputs(candidate, record) &&
          candidate.resultDigest?.value === record.resultDigest?.value),
    );
    if (duplicateIndex >= 0) {
      const previous = current[duplicateIndex]!;
      current.splice(duplicateIndex, 1);
      record = {
        ...record,
        id: previous.id,
        firstRunAt: previous.firstRunAt,
        lastRunAt: record.finishedAt,
        repeatCount: previous.repeatCount + 1,
        label: previous.label,
        note: previous.note,
        tags: previous.tags,
        starred: previous.starred,
        determinismWarning: previous.determinismWarning,
      };
    } else {
      const conflictingIndexes = current.flatMap((candidate, index) =>
        sameReplayInputs(candidate, record) &&
        candidate.resultDigest?.value !== record.resultDigest?.value
          ? [index]
          : [],
      );
      if (conflictingIndexes.length > 0) {
        record = { ...record, determinismWarning: true };
        for (const index of conflictingIndexes)
          current[index] = { ...current[index]!, determinismWarning: true };
      }
    }
    return persistRecords([record, ...current]);
  });

export const updateLocalRunHistoryRecord = async (
  id: string,
  patch: {
    label?: string;
    note?: string;
    tags?: readonly string[];
    starred?: boolean;
  },
): Promise<LocalRunHistoryStorageSnapshot> =>
  serializeMutation(async () => {
    const current = (await readRecords()).records;
    const record = current.find((candidate) => candidate.id === id);
    if (!record) return snapshot(fitForStorage(current));
    const nextStarred = patch.starred ?? record.starred;
    if (
      nextStarred &&
      !record.starred &&
      current.filter((candidate) => candidate.starred).length >=
        MAX_STARRED_RUN_HISTORY_ENTRIES
    )
      throw new LocalRunHistoryStorageError(
        `At most ${MAX_STARRED_RUN_HISTORY_ENTRIES} run baselines can be starred.`,
      );
    return persistRecords(
      current.map((candidate) =>
        candidate.id === id
          ? {
              ...candidate,
              label:
                patch.label === undefined
                  ? candidate.label
                  : clampText(patch.label, 80) || candidate.scenario.name,
              note:
                patch.note === undefined
                  ? candidate.note
                  : clampText(patch.note, 500),
              tags:
                patch.tags === undefined
                  ? candidate.tags
                  : Array.from(
                      new Set(
                        patch.tags
                          .map((tag) => clampText(tag, 24))
                          .filter(Boolean),
                      ),
                    ).slice(0, 6),
              starred: nextStarred,
            }
          : candidate,
      ),
    );
  });

export const removeLocalRunHistoryRecord = async (
  id: string,
): Promise<LocalRunHistoryStorageSnapshot> =>
  serializeMutation(async () =>
    persistRecords(
      (await readRecords()).records.filter((record) => record.id !== id),
    ),
  );

export const clearLocalRunHistory =
  async (): Promise<LocalRunHistoryStorageSnapshot> =>
    serializeMutation(async () => {
      await storageBackend().clear();
      return snapshot([]);
    });

const metricKeys = [
  "objectivesPassed",
  "objectivesTotal",
  "p95LatencyMs",
  "availabilityPercent",
  "errorRatePercent",
  "monthlyCostEur",
  "dataLoss",
  "durabilityPercent",
  "recoveryTimeSeconds",
  "operationalComplexity",
] as const;

const compareMetrics = (
  source: LocalRunHistoryMetrics,
  comparison: LocalRunHistoryMetrics,
): { deltas: LocalRunHistoryMetrics; percentages: LocalRunHistoryMetrics } => {
  const deltas = {} as LocalRunHistoryMetrics;
  const percentages = {} as LocalRunHistoryMetrics;
  for (const key of metricKeys) {
    deltas[key] = comparison[key] - source[key];
    percentages[key] =
      source[key] === 0
        ? comparison[key] === 0
          ? 0
          : Number.NaN
        : (deltas[key] / Math.abs(source[key])) * 100;
  }
  return { deltas, percentages };
};

export const compareLocalRunHistory = (
  source: LocalRunHistoryRecord,
  comparison: LocalRunHistoryRecord,
): LocalRunHistoryComparison => {
  const issues = [
    ...(source.status === "completed" && comparison.status === "completed"
      ? []
      : ["Only completed runs have comparable modeled metrics."]),
    ...(source.metrics && comparison.metrics
      ? []
      : ["One or both run summaries do not contain modeled metrics."]),
    ...(source.engineVersion === comparison.engineVersion
      ? []
      : [
          `Engine versions differ (${source.engineVersion} and ${comparison.engineVersion}).`,
        ]),
  ];
  const compatible = issues.length === 0;
  const compared =
    compatible && source.metrics && comparison.metrics
      ? compareMetrics(source.metrics, comparison.metrics)
      : null;
  const objectivesComparable =
    source.objectiveSignatures.length > 0 &&
    source.objectiveSignatures.length ===
      comparison.objectiveSignatures.length &&
    source.objectiveSignatures.every(
      (signature, index) => signature === comparison.objectiveSignatures[index],
    );
  const sourcePassRate = source.metrics
    ? source.metrics.objectivesTotal === 0
      ? 0
      : (source.metrics.objectivesPassed / source.metrics.objectivesTotal) * 100
    : null;
  const comparisonPassRate = comparison.metrics
    ? comparison.metrics.objectivesTotal === 0
      ? 0
      : (comparison.metrics.objectivesPassed /
          comparison.metrics.objectivesTotal) *
        100
    : null;
  return {
    compatible,
    issues,
    sameScenario: source.scenario.id === comparison.scenario.id,
    sameArchitecture:
      source.architecture.id === comparison.architecture.id &&
      source.architecture.revision === comparison.architecture.revision,
    sameInputs:
      source.replayInputDigest !== null &&
      source.replayInputDigest === comparison.replayInputDigest &&
      source.replayActionDigest !== null &&
      source.replayActionDigest === comparison.replayActionDigest,
    sameSeed: source.seed === comparison.seed,
    objectivesComparable,
    objectivePassRateDeltaPercent:
      objectivesComparable &&
      sourcePassRate !== null &&
      comparisonPassRate !== null
        ? comparisonPassRate - sourcePassRate
        : null,
    metricDeltas: compared?.deltas ?? null,
    metricPercentDeltas: compared?.percentages ?? null,
  };
};

export const verifyLocalRunHistoryReplay = async (
  record: LocalRunHistoryRecord,
  digestProvider: DigestProvider | null | undefined = globalThis.crypto?.subtle,
): Promise<CompletedRunReplayBundle> => {
  if (record.replayState !== "available" || !record.replayBundle)
    throw new Error(
      "This run does not retain a replayable candidate-safe bundle.",
    );
  return parseCompletedRunReplayBundle(record.replayBundle, digestProvider);
};

const downloadText = (contents: string, fileName: string, type: string) => {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
};
const safeFilePart = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "run";
const candidateSafeExportRecord = (record: LocalRunHistoryRecord) => ({
  ...record,
  privacyScope: "candidate-safe-export" as const,
  label: record.scenario.name,
  note: "",
  tags: [],
  replayBundle: null,
});

export const downloadLocalRunHistoryRecord = async (
  record: LocalRunHistoryRecord,
): Promise<void> => {
  if (record.replayState === "available" && record.replayBundle) {
    const bundle = await verifyLocalRunHistoryReplay(record);
    downloadText(
      JSON.stringify(bundle, null, 2),
      `systemforge-${safeFilePart(record.runId)}-replay.json`,
      "application/json;charset=utf-8",
    );
    return;
  }
  downloadText(
    JSON.stringify(
      {
        exportVersion: 1,
        kind: RUN_HISTORY_EXPORT_KIND,
        privacyScope: "candidate-safe-export",
        record: candidateSafeExportRecord(record),
      },
      null,
      2,
    ),
    `systemforge-${safeFilePart(record.runId)}-summary.json`,
    "application/json;charset=utf-8",
  );
};

const formatNumber = (value: number, digits = 3): string =>
  value.toLocaleString("en-US", { maximumFractionDigits: digits });

export const downloadLocalRunHistoryComparison = (
  source: LocalRunHistoryRecord,
  comparison: LocalRunHistoryRecord,
  format: "json" | "markdown",
): void => {
  const result = compareLocalRunHistory(source, comparison);
  const baseName = `systemforge-${safeFilePart(source.runId)}-vs-${safeFilePart(comparison.runId)}`;
  if (format === "json") {
    downloadText(
      JSON.stringify(
        {
          exportVersion: 1,
          kind: RUN_HISTORY_COMPARISON_KIND,
          privacyScope: "candidate-safe-export",
          boundary:
            "Modeled summaries only. No production telemetry or opaque runtime state.",
          source: candidateSafeExportRecord(source),
          comparison: candidateSafeExportRecord(comparison),
          result,
        },
        null,
        2,
      ),
      `${baseName}.json`,
      "application/json;charset=utf-8",
    );
    return;
  }
  const metricLines = result.metricDeltas
    ? metricKeys.map(
        (key) =>
          `| ${key} | ${formatNumber(source.metrics![key])} | ${formatNumber(comparison.metrics![key])} | ${formatNumber(result.metricDeltas![key])} |`,
      )
    : [];
  downloadText(
    [
      "# SystemForge run comparison",
      "",
      `- Source: ${source.runId}`,
      `- Comparison: ${comparison.runId}`,
      `- Engine: ${source.engineVersion} / ${comparison.engineVersion}`,
      `- Comparable: ${result.compatible ? "yes" : "no"}`,
      `- Same deterministic inputs: ${result.sameInputs ? "yes" : "no"}`,
      "- Boundary: modeled summaries only; no production telemetry or opaque runtime state",
      "",
      ...(result.issues.length > 0
        ? [
            "## Comparison limits",
            "",
            ...result.issues.map((issue) => `- ${issue}`),
            "",
          ]
        : []),
      ...(metricLines.length > 0
        ? [
            "## Metric deltas",
            "",
            "| Metric | Source | Comparison | Delta |",
            "| --- | ---: | ---: | ---: |",
            ...metricLines,
            "",
          ]
        : []),
    ].join("\n"),
    `${baseName}.md`,
    "text/markdown;charset=utf-8",
  );
};
