import {
  architectureDraftSchema,
  candidateScenario,
  scenarioSchema,
  type Architecture,
  type CausalEvent,
  type MetricFrame,
  type NodeIntervention,
  type Requirement,
  type Scenario,
  type SimulationAction,
  type SimulationResult,
} from "@systemforge/contracts";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  ENGINE_VERSION,
  type SolveArchitectureOptions,
  type SolveArchitectureResult,
} from "@systemforge/sim-core";
import { create } from "zustand";
import {
  checkApi,
  fetchCanonicalRun,
  fetchSharedScenario,
  recordSharedScenarioRun,
  setSharedScenarioReveal,
  submitCanonicalRun,
  updateInterviewCollaboration as updateCanonicalInterviewCollaboration,
  type ApiAvailability,
  type CanonicalRunStatus,
  type InterviewCollaboration,
  type InterviewCollaborationPatch,
} from "../lib/api";
import {
  appendCompletedRunAction,
  completedRunReplayInputs,
  createCompletedRunArtifact,
  forkCompletedRunAtSecond,
  withCompletedRunSnapshot,
  type CompletedRunAction,
  type CompletedRunArtifact,
  type CompletedRunFork,
  type CompletedRunReplaySource,
} from "../lib/completedRun";
import {
  SimulationRunCancelledError,
  startLocalSimulation,
  type LocalSimulationSession,
  type SimulationRunIdentity,
  type SimulationRunSessionState,
  type SimulationSessionSnapshot,
  type SimulationWorkerMessage,
} from "../lib/localSimulation";
import { decodeLocalShareInWorker } from "../lib/localShareDecoder";
import { consumeSensitiveHashParameter } from "../lib/sensitiveHash";
import {
  assessCompletedRunReplayCompatibility,
  completedRunReplaySourceFromBundle,
  type CompletedRunReplayBundle,
} from "../lib/replayBundle";
import {
  addLocalRunHistoryRecord,
  clearLocalRunHistory,
  createCompletedRunHistoryRecord,
  createTerminalRunHistoryRecord,
  loadLocalRunHistory,
  LocalRunHistoryStorageError,
  MAX_LOCAL_RUN_HISTORY_BYTES,
  removeLocalRunHistoryRecord,
  updateLocalRunHistoryRecord,
  type LocalRunHistoryRecord,
} from "../lib/runHistory";
import { solveArchitectureWithFallback } from "../lib/solverGateway";

export type WorkspaceMode = "build" | "run" | "investigate";

export interface ArchitectureSnapshot {
  id: string;
  label: string;
  createdAt: string;
  architecture: Architecture;
}

export interface LocalRunSessionSnapshot {
  identity: SimulationRunIdentity;
  state: SimulationRunSessionState;
  speed: number;
  progress: number;
  deliveredFrames: number;
  deliveredEvents: number;
  totalFrames: number;
  totalEvents: number;
}

export interface TransientArchitectureUpdate {
  baseArchitecture: Architecture;
  updateCount: number;
}

export interface LabState {
  scenario: Scenario;
  architecture: Architecture;
  scenarioRevision: number;
  architectureRevision: number;
  architectureUndo: Architecture[];
  architectureRedo: Architecture[];
  architectureSnapshots: ArchitectureSnapshot[];
  result: SimulationResult | null;
  solverResult: SolveArchitectureResult | null;
  selectedNodeId: string | null;
  selectedEventId: string | null;
  workspaceMode: WorkspaceMode;
  runState: "idle" | "running" | "complete" | "error";
  localRunSession: LocalRunSessionSnapshot | null;
  localRunFrames: MetricFrame[];
  localRunEvents: CausalEvent[];
  localRunActions: SimulationAction[];
  localRunActionLog: CompletedRunAction[];
  localRunSnapshot: SimulationSessionSnapshot | null;
  localRunForkSnapshot: SimulationSessionSnapshot | null;
  completedRunArtifact: CompletedRunArtifact | null;
  completedRunFork: CompletedRunFork | null;
  runHistory: LocalRunHistoryRecord[];
  runHistoryUsedBytes: number;
  runHistoryMaximumBytes: number;
  runHistoryIssue: string | null;
  transientArchitectureUpdate: TransientArchitectureUpdate | null;
  solverState: "idle" | "running" | "complete" | "error";
  solverExecution: "canonical" | "local" | null;
  apiAvailability: ApiAvailability;
  role: "participant" | "interviewer";
  notice: string | null;
  canonicalRunId: string | null;
  canonicalRunStatus: CanonicalRunStatus["status"] | "idle";
  canonicalRunDigest: string | null;
  sharedScenarioId: string | null;
  sharedHostToken: string | null;
  revealState: "hidden" | "revealed";
  collaboration: InterviewCollaboration;
  hydrate: () => Promise<void>;
  loadSharedScenario: (
    scenario: Scenario,
    architecture: Architecture,
    role: "participant" | "interviewer",
    session?: {
      id: string;
      hostToken?: string;
      revealState: "hidden" | "revealed";
      collaboration?: InterviewCollaboration;
    },
  ) => void;
  setScenario: (scenario: Scenario) => void;
  setArchitecture: (architecture: Architecture) => void;
  setArchitectureTransient: (architecture: Architecture) => void;
  commitArchitectureTransient: () => void;
  cancelArchitectureTransient: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  undoArchitecture: () => void;
  redoArchitecture: () => void;
  saveArchitectureSnapshot: (label: string) => void;
  restoreArchitectureSnapshot: (id: string) => void;
  removeArchitectureSnapshot: (id: string) => void;
  setSelectedNodeId: (id: string | null) => void;
  setSelectedEventId: (id: string | null) => void;
  setWorkspaceMode: (mode: WorkspaceMode) => void;
  updateRequirement: (requirement: Requirement) => void;
  removeRequirement: (id: string) => void;
  refreshSharedScenario: () => Promise<void>;
  setInterviewReveal: (revealed: boolean) => Promise<void>;
  updateInterviewCollaboration: (
    patch: InterviewCollaborationPatch,
  ) => Promise<void>;
  checkService: () => Promise<void>;
  runLocal: () => Promise<void>;
  cancelLocalRun: () => void;
  pauseLocalRun: () => void;
  resumeLocalRun: () => void;
  stepLocalRun: () => void;
  applyLocalIntervention: (
    nodeId: string,
    intervention: NodeIntervention,
  ) => void;
  injectLocalNodeOutage: (nodeId: string) => void;
  snapshotLocalRun: () => void;
  forkLocalRunSession: () => void;
  openLocalRunFork: () => Promise<void>;
  finishLocalRun: () => void;
  setLocalRunSpeed: (speed: number) => void;
  setCompletedRunSnapshotSecond: (second: number) => void;
  updateRunHistoryRecord: (
    id: string,
    patch: {
      label?: string;
      note?: string;
      tags?: readonly string[];
      starred?: boolean;
    },
  ) => Promise<void>;
  removeRunHistoryRecord: (id: string) => Promise<void>;
  clearRunHistory: () => Promise<void>;
  replayCompletedRun: () => Promise<void>;
  queueImportedReplay: (bundle: CompletedRunReplayBundle) => string;
  consumeQueuedImportedReplay: (intentId: string) => Promise<void>;
  replayImportedBundle: (bundle: CompletedRunReplayBundle) => Promise<void>;
  forkCompletedRun: (second: number) => void;
  solveAlternatives: (options?: SolveArchitectureOptions) => Promise<void>;
  submitCanonical: () => Promise<void>;
  dismissNotice: () => void;
}

const cloneDefaults = () => ({
  scenario: structuredClone(DEFAULT_SCENARIO),
  architecture: structuredClone(DEFAULT_ARCHITECTURE),
});

interface StoredSession {
  id: string;
  hostToken?: string;
  role: "participant" | "interviewer";
  revealState: "hidden" | "revealed";
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let solverRequestSequence = 0;
let localRunSequence = 0;
let completedRunForkSequence = 0;
let canonicalSubmissionSequence = 0;
let hydrationSequence = 0;
let sharedRefreshSequence = 0;
let sharedMutationEpoch = 0;
let queuedSharedMutationCount = 0;
let activeLocalSimulation: LocalSimulationSession | null = null;
let activeSharedRefreshController: AbortController | null = null;
let activeSharedMutationController: AbortController | null = null;
let sharedMutationTail: Promise<void> = Promise.resolve();
let activeHydrationPromise: Promise<void> | null = null;
let pendingReplaySource: CompletedRunReplaySource | null = null;
let importedReplayIntentSequence = 0;
const IMPORTED_REPLAY_INTENT_TTL_MS = 60_000;
let pendingImportedReplay: {
  intentId: string;
  queuedAt: number;
  bundle: CompletedRunReplayBundle;
} | null = null;
let pendingLocalRunFork: {
  snapshot: SimulationSessionSnapshot;
  frames: MetricFrame[];
  events: CausalEvent[];
} | null = null;

const cancelActiveLocalSimulation = () => {
  const active = activeLocalSimulation;
  activeLocalSimulation = null;
  active?.cancel();
};

const cancelSharedScenarioRefresh = () => {
  sharedRefreshSequence += 1;
  activeSharedRefreshController?.abort();
  activeSharedRefreshController = null;
};

const cancelSharedScenarioOperations = () => {
  cancelSharedScenarioRefresh();
  sharedMutationEpoch += 1;
  queuedSharedMutationCount = 0;
  activeSharedMutationController?.abort();
  activeSharedMutationController = null;
  sharedMutationTail = Promise.resolve();
};

const queueSharedScenarioMutation = (
  operation: (signal: AbortSignal, epoch: number) => Promise<void>,
): Promise<void> => {
  const epoch = sharedMutationEpoch;
  queuedSharedMutationCount += 1;
  const queued = sharedMutationTail
    .catch(() => undefined)
    .then(async () => {
      if (epoch !== sharedMutationEpoch) return;
      const controller = new AbortController();
      activeSharedMutationController = controller;
      try {
        await operation(controller.signal, epoch);
      } finally {
        if (activeSharedMutationController === controller)
          activeSharedMutationController = null;
      }
    });
  sharedMutationTail = queued.catch(() => undefined);
  return queued.finally(() => {
    if (epoch === sharedMutationEpoch)
      queuedSharedMutationCount = Math.max(0, queuedSharedMutationCount - 1);
  });
};

const invalidatedLocalRun = (
  state: LabState,
  scenarioChanged: boolean,
  architectureChanged: boolean,
) => {
  if (scenarioChanged || architectureChanged) canonicalSubmissionSequence += 1;
  return {
    scenarioRevision: state.scenarioRevision + (scenarioChanged ? 1 : 0),
    architectureRevision:
      state.architectureRevision + (architectureChanged ? 1 : 0),
    result: null,
    runState: "idle" as const,
    localRunSession: null,
    localRunFrames: [] as MetricFrame[],
    localRunEvents: [] as CausalEvent[],
    localRunActions: [] as SimulationAction[],
    localRunActionLog: [] as CompletedRunAction[],
    localRunSnapshot: null as SimulationSessionSnapshot | null,
    localRunForkSnapshot: null as SimulationSessionSnapshot | null,
    canonicalRunId: null,
    canonicalRunStatus: "idle" as const,
    canonicalRunDigest: null,
  };
};

const deliveredSecond = (state: LabState): number | null =>
  state.localRunFrames.at(-1)?.second ?? null;

const currentLocalRunMatches = (
  state: LabState,
  identity: SimulationRunIdentity,
): boolean =>
  state.localRunSession?.identity.runId === identity.runId &&
  state.localRunSession.identity.scenarioRevision ===
    identity.scenarioRevision &&
  state.localRunSession.identity.architectureRevision ===
    identity.architectureRevision &&
  state.localRunSession.identity.scenarioId === identity.scenarioId &&
  state.localRunSession.identity.architectureId === identity.architectureId &&
  state.scenarioRevision === identity.scenarioRevision &&
  state.architectureRevision === identity.architectureRevision &&
  state.scenario.id === identity.scenarioId &&
  state.architecture.id === identity.architectureId;

const speedFromMessage = (
  message: SimulationWorkerMessage | undefined,
  fallback: number,
): number =>
  message?.type === "started" || message?.type === "speed"
    ? message.speed
    : fallback;

const HISTORY_LIMIT = 40;
const SNAPSHOT_STORAGE_KEY = "systemforge:architecture-snapshots";
const DRAFT_STORAGE_KEY = "systemforge:draft";
const PRIVATE_DRAFT_STORAGE_KEY = "systemforge:interviewer-draft";
const emptyCollaboration = (): InterviewCollaboration => ({
  candidateNotes: "",
  candidateCursor: "Preparing workspace",
  startedAt: null,
  updatedAt: new Date(0).toISOString(),
});

const persistDraft = (
  scenario: Scenario,
  architecture: Architecture,
  role: "participant" | "interviewer",
) => {
  localStorage.setItem(
    DRAFT_STORAGE_KEY,
    JSON.stringify({ scenario: candidateScenario(scenario), architecture }),
  );
  if (role === "interviewer" && scenario.mode === "interview")
    sessionStorage.setItem(
      PRIVATE_DRAFT_STORAGE_KEY,
      JSON.stringify({ scenario, architecture }),
    );
  else sessionStorage.removeItem(PRIVATE_DRAFT_STORAGE_KEY);
};

const parseStoredDraft = (
  value: string | null,
): { scenario: Scenario; architecture: Architecture } | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      scenario: scenarioSchema.parse(parsed.scenario),
      architecture: parsed.architecture
        ? architectureDraftSchema.parse(parsed.architecture)
        : structuredClone(DEFAULT_ARCHITECTURE),
    };
  } catch {
    return null;
  }
};

const parseArchitectureSnapshots = (
  value: string | null,
): ArchitectureSnapshot[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 24).flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const candidate = entry as Record<string, unknown>;
      if (
        typeof candidate.id !== "string" ||
        typeof candidate.label !== "string" ||
        typeof candidate.createdAt !== "string"
      )
        return [];
      const architecture = architectureDraftSchema.safeParse(
        candidate.architecture,
      );
      return architecture.success
        ? [
            {
              id: candidate.id,
              label: candidate.label.slice(0, 80),
              createdAt: candidate.createdAt,
              architecture: architecture.data,
            },
          ]
        : [];
    });
  } catch {
    return [];
  }
};

const persistSnapshots = (snapshots: ArchitectureSnapshot[]) =>
  localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshots));

const parseStoredSession = (
  value: string | null,
): StoredSession | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.id !== "string" ||
      !UUID_PATTERN.test(parsed.id)
    )
      return undefined;
    if (
      "hostToken" in parsed &&
      (typeof parsed.hostToken !== "string" ||
        !UUID_PATTERN.test(parsed.hostToken))
    )
      return undefined;
    const hostToken =
      typeof parsed.hostToken === "string" ? parsed.hostToken : undefined;
    const role = hostToken
      ? ("interviewer" as const)
      : ("participant" as const);
    return {
      id: parsed.id,
      ...(hostToken ? { hostToken } : {}),
      role,
      revealState: parsed.revealState === "revealed" ? "revealed" : "hidden",
    };
  } catch {
    return undefined;
  }
};

export const useLabStore = create<LabState>((set, get) => ({
  ...cloneDefaults(),
  scenarioRevision: 0,
  architectureRevision: 0,
  architectureUndo: [],
  architectureRedo: [],
  architectureSnapshots: [],
  result: null,
  solverResult: null,
  selectedNodeId: "api",
  selectedEventId: null,
  workspaceMode: "build",
  runState: "idle",
  localRunSession: null,
  localRunFrames: [],
  localRunEvents: [],
  localRunActions: [],
  localRunActionLog: [],
  localRunSnapshot: null,
  localRunForkSnapshot: null,
  completedRunArtifact: null,
  completedRunFork: null,
  runHistory: [],
  runHistoryUsedBytes: 0,
  runHistoryMaximumBytes: MAX_LOCAL_RUN_HISTORY_BYTES,
  runHistoryIssue: null,
  transientArchitectureUpdate: null,
  solverState: "idle",
  solverExecution: null,
  apiAvailability: "checking",
  role: "participant",
  notice: null,
  canonicalRunId: null,
  canonicalRunStatus: "idle",
  canonicalRunDigest: null,
  sharedScenarioId: null,
  sharedHostToken: null,
  revealState: "hidden",
  collaboration: emptyCollaboration(),
  hydrate: () => {
    if (activeHydrationPromise) return activeHydrationPromise;
    const hydration = (async () => {
      const currentHydration = ++hydrationSequence;
      cancelActiveLocalSimulation();
      cancelSharedScenarioOperations();
      pendingReplaySource = null;
      solverRequestSequence += 1;
      set((state) => ({
        ...invalidatedLocalRun(state, true, true),
        scenario: candidateScenario(state.scenario),
        selectedEventId: null,
        workspaceMode: "build",
        completedRunArtifact: null,
        completedRunFork: null,
        transientArchitectureUpdate: null,
        solverResult: null,
        solverState: "idle",
        solverExecution: null,
        canonicalRunId: null,
        canonicalRunStatus: "idle",
        canonicalRunDigest: null,
        role: "participant",
        sharedScenarioId: null,
        sharedHostToken: null,
        revealState: "hidden",
        collaboration: emptyCollaboration(),
      }));
      const architectureSnapshots = parseArchitectureSnapshots(
        localStorage.getItem(SNAPSHOT_STORAGE_KEY),
      );
      const sessionValue = sessionStorage.getItem("systemforge:session");
      const session = parseStoredSession(sessionValue);
      if (sessionValue && !session)
        sessionStorage.removeItem("systemforge:session");
      const shared = consumeSensitiveHashParameter("share");
      const runHistoryPromise = loadLocalRunHistory();
      const applyRunHistory = (
        runHistory: Awaited<ReturnType<typeof loadLocalRunHistory>>,
      ) =>
        set({
          architectureSnapshots,
          runHistory: runHistory.records,
          runHistoryUsedBytes: runHistory.usedBytes,
          runHistoryMaximumBytes: runHistory.maximumBytes,
          runHistoryIssue: runHistory.issue,
        });
      if (shared !== null) {
        sessionStorage.removeItem("systemforge:session");
        sessionStorage.removeItem(PRIVATE_DRAFT_STORAGE_KEY);
        set({
          notice: "Checking the local share payload in a bounded worker…",
        });
        const decodedPromise = decodeLocalShareInWorker(shared);
        const [runHistory, decoded] = await Promise.all([
          runHistoryPromise,
          decodedPromise,
        ]);
        applyRunHistory(runHistory);
        if (currentHydration !== hydrationSequence) return;
        if (decoded) {
          const scenario =
            decoded.role === "interviewer"
              ? decoded.scenario
              : candidateScenario(decoded.scenario);
          const architecture =
            decoded.architecture ?? structuredClone(DEFAULT_ARCHITECTURE);
          persistDraft(scenario, architecture, decoded.role);
          set({
            scenario,
            architecture,
            role: decoded.role,
            notice: "Shared scenario loaded locally. No server was required.",
            sharedScenarioId: null,
            sharedHostToken: null,
            revealState: "hidden",
            collaboration: emptyCollaboration(),
          });
          return;
        }
        const scenario = candidateScenario(get().scenario);
        const architecture = get().architecture;
        persistDraft(scenario, architecture, "participant");
        set({
          scenario,
          architecture,
          role: "participant",
          notice:
            "This local share link is invalid or uses an unsupported schema version.",
          sharedScenarioId: null,
          sharedHostToken: null,
          revealState: "hidden",
          collaboration: emptyCollaboration(),
        });
        return;
      }

      applyRunHistory(await runHistoryPromise);

      const privateDraft = parseStoredDraft(
        sessionStorage.getItem(PRIVATE_DRAFT_STORAGE_KEY),
      );
      if (
        privateDraft?.scenario.mode === "interview" &&
        (!session || session.role === "interviewer")
      ) {
        persistDraft(
          privateDraft.scenario,
          privateDraft.architecture,
          "interviewer",
        );
        set({
          scenario: privateDraft.scenario,
          architecture: privateDraft.architecture,
          role: "interviewer",
          sharedScenarioId: session?.id ?? null,
          sharedHostToken: session?.hostToken ?? null,
          revealState: session?.revealState ?? "hidden",
          collaboration: emptyCollaboration(),
        });
        return;
      }
      if (privateDraft) sessionStorage.removeItem(PRIVATE_DRAFT_STORAGE_KEY);

      const draft = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (draft) {
        const parsed = parseStoredDraft(draft);
        if (parsed) {
          const role = session?.role ?? "participant";
          const revealState = session?.revealState ?? "hidden";
          const scenario =
            role === "interviewer"
              ? parsed.scenario
              : candidateScenario(parsed.scenario);
          persistDraft(scenario, parsed.architecture, role);
          set({
            scenario,
            architecture: parsed.architecture,
            role,
            sharedScenarioId: session?.id ?? null,
            sharedHostToken: session?.hostToken ?? null,
            revealState,
            collaboration: emptyCollaboration(),
          });
        } else {
          localStorage.removeItem(DRAFT_STORAGE_KEY);
          sessionStorage.removeItem(PRIVATE_DRAFT_STORAGE_KEY);
          sessionStorage.removeItem("systemforge:session");
          set({
            ...cloneDefaults(),
            role: "participant",
            sharedScenarioId: null,
            sharedHostToken: null,
            revealState: "hidden",
            collaboration: emptyCollaboration(),
            notice:
              "The saved draft was invalid or from an unsupported version, so SystemForge restored a safe local workspace.",
          });
        }
        return;
      }
      sessionStorage.removeItem("systemforge:session");
      set({
        ...cloneDefaults(),
        role: "participant",
        sharedScenarioId: null,
        sharedHostToken: null,
        revealState: "hidden",
        collaboration: emptyCollaboration(),
      });
    })();
    activeHydrationPromise = hydration;
    const clearHydration = () => {
      if (activeHydrationPromise === hydration) activeHydrationPromise = null;
    };
    void hydration.then(clearHydration, clearHydration);
    return hydration;
  },
  loadSharedScenario: (scenario, architecture, role, session) => {
    hydrationSequence += 1;
    cancelActiveLocalSimulation();
    cancelSharedScenarioOperations();
    pendingReplaySource = null;
    solverRequestSequence += 1;
    const confirmedHostToken =
      role === "interviewer" ? session?.hostToken : undefined;
    persistDraft(scenario, architecture, role);
    set((state) => ({
      ...invalidatedLocalRun(state, true, true),
      scenario,
      architecture,
      role,
      solverResult: null,
      solverState: "idle",
      solverExecution: null,
      notice:
        scenario.mode !== "interview"
          ? "Scenario loaded in the Lab."
          : role === "interviewer"
            ? "Interview scenario loaded with private evaluation criteria."
            : session?.revealState === "revealed"
              ? "Interview scenario loaded with the evaluation criteria revealed."
              : "Interview scenario loaded. Private interviewer criteria remain hidden.",
      canonicalRunId: null,
      canonicalRunStatus: "idle",
      canonicalRunDigest: null,
      sharedScenarioId: session?.id ?? null,
      sharedHostToken: confirmedHostToken ?? null,
      revealState: session?.revealState ?? "hidden",
      collaboration: session?.collaboration ?? emptyCollaboration(),
      completedRunArtifact: null,
      completedRunFork: null,
      transientArchitectureUpdate: null,
    }));
    if (session) {
      sessionStorage.setItem(
        "systemforge:session",
        JSON.stringify({
          id: session.id,
          ...(confirmedHostToken ? { hostToken: confirmedHostToken } : {}),
          role,
          revealState: session.revealState,
        }),
      );
    } else {
      sessionStorage.removeItem("systemforge:session");
    }
  },
  setScenario: (scenario) => {
    cancelActiveLocalSimulation();
    solverRequestSequence += 1;
    set((state) => ({
      ...invalidatedLocalRun(state, true, false),
      scenario,
      solverResult: null,
      solverState: "idle",
      solverExecution: null,
      canonicalRunId: null,
      canonicalRunStatus: "idle",
      canonicalRunDigest: null,
    }));
    persistDraft(scenario, get().architecture, get().role);
  },
  setArchitecture: (architecture) => {
    cancelActiveLocalSimulation();
    solverRequestSequence += 1;
    const current = get().architecture;
    const historyBase =
      get().transientArchitectureUpdate?.baseArchitecture ?? current;
    set((state) => ({
      ...invalidatedLocalRun(state, false, true),
      architecture,
      architectureUndo: [
        ...get().architectureUndo,
        structuredClone(historyBase),
      ].slice(-HISTORY_LIMIT),
      architectureRedo: [],
      transientArchitectureUpdate: null,
      solverResult: null,
      solverState: "idle",
      solverExecution: null,
      canonicalRunId: null,
      canonicalRunStatus: "idle",
      canonicalRunDigest: null,
    }));
    persistDraft(get().scenario, architecture, get().role);
  },
  setArchitectureTransient: (architecture) => {
    const current = get();
    const transient = current.transientArchitectureUpdate;
    cancelActiveLocalSimulation();
    solverRequestSequence += 1;
    set((state) => ({
      ...invalidatedLocalRun(state, false, true),
      architecture,
      transientArchitectureUpdate: {
        baseArchitecture: structuredClone(
          transient?.baseArchitecture ?? current.architecture,
        ),
        updateCount: (transient?.updateCount ?? 0) + 1,
      },
      solverResult: null,
      solverState: "idle",
      solverExecution: null,
      canonicalRunId: null,
      canonicalRunStatus: "idle",
      canonicalRunDigest: null,
    }));
  },
  commitArchitectureTransient: () => {
    const transient = get().transientArchitectureUpdate;
    if (!transient) return;
    const architectureUndo = [
      ...get().architectureUndo,
      structuredClone(transient.baseArchitecture),
    ].slice(-HISTORY_LIMIT);
    set({
      architectureUndo,
      architectureRedo: [],
      transientArchitectureUpdate: null,
    });
    persistDraft(get().scenario, get().architecture, get().role);
  },
  cancelArchitectureTransient: () => {
    const transient = get().transientArchitectureUpdate;
    if (!transient) return;
    cancelActiveLocalSimulation();
    solverRequestSequence += 1;
    const architecture = structuredClone(transient.baseArchitecture);
    set((state) => ({
      ...invalidatedLocalRun(state, false, true),
      architecture,
      transientArchitectureUpdate: null,
      solverResult: null,
      solverState: "idle",
      solverExecution: null,
      notice: "Discarded the transient architecture updates.",
    }));
    persistDraft(get().scenario, architecture, get().role);
  },
  canUndo: () => get().architectureUndo.length > 0,
  canRedo: () => get().architectureRedo.length > 0,
  undoArchitecture: () => {
    if (get().transientArchitectureUpdate) {
      get().cancelArchitectureTransient();
      return;
    }
    const undo = get().architectureUndo;
    const previous = undo.at(-1);
    if (!previous) return;
    cancelActiveLocalSimulation();
    solverRequestSequence += 1;
    const current = get().architecture;
    set((state) => ({
      ...invalidatedLocalRun(state, false, true),
      architecture: structuredClone(previous),
      architectureUndo: undo.slice(0, -1),
      architectureRedo: [
        structuredClone(current),
        ...get().architectureRedo,
      ].slice(0, HISTORY_LIMIT),
      transientArchitectureUpdate: null,
      solverResult: null,
      solverState: "idle",
      solverExecution: null,
      notice: "Architecture change undone.",
    }));
    persistDraft(get().scenario, previous, get().role);
  },
  redoArchitecture: () => {
    if (get().transientArchitectureUpdate) {
      get().cancelArchitectureTransient();
      return;
    }
    const redo = get().architectureRedo;
    const next = redo[0];
    if (!next) return;
    cancelActiveLocalSimulation();
    solverRequestSequence += 1;
    const current = get().architecture;
    set((state) => ({
      ...invalidatedLocalRun(state, false, true),
      architecture: structuredClone(next),
      architectureUndo: [
        ...get().architectureUndo,
        structuredClone(current),
      ].slice(-HISTORY_LIMIT),
      architectureRedo: redo.slice(1),
      transientArchitectureUpdate: null,
      solverResult: null,
      solverState: "idle",
      solverExecution: null,
      notice: "Architecture change restored.",
    }));
    persistDraft(get().scenario, next, get().role);
  },
  saveArchitectureSnapshot: (rawLabel) => {
    const label = rawLabel.trim().slice(0, 80);
    if (!label) return;
    const snapshot: ArchitectureSnapshot = {
      id: crypto.randomUUID(),
      label,
      createdAt: new Date().toISOString(),
      architecture: structuredClone(get().architecture),
    };
    const architectureSnapshots = [
      snapshot,
      ...get().architectureSnapshots,
    ].slice(0, 24);
    set({
      architectureSnapshots,
      notice: `Saved architecture snapshot “${label}”.`,
    });
    persistSnapshots(architectureSnapshots);
  },
  restoreArchitectureSnapshot: (id) => {
    const snapshot = get().architectureSnapshots.find(
      (candidate) => candidate.id === id,
    );
    if (!snapshot) return;
    get().setArchitecture(structuredClone(snapshot.architecture));
    set({ notice: `Restored snapshot “${snapshot.label}”.` });
  },
  removeArchitectureSnapshot: (id) => {
    const architectureSnapshots = get().architectureSnapshots.filter(
      (snapshot) => snapshot.id !== id,
    );
    set({ architectureSnapshots });
    persistSnapshots(architectureSnapshots);
  },
  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
  setSelectedEventId: (selectedEventId) =>
    set({
      selectedEventId,
      workspaceMode: selectedEventId ? "investigate" : get().workspaceMode,
    }),
  setWorkspaceMode: (workspaceMode) => set({ workspaceMode }),
  updateRequirement: (requirement) => {
    cancelActiveLocalSimulation();
    solverRequestSequence += 1;
    const scenario = get().scenario;
    const requirements = scenario.requirements.some(
      (current) => current.id === requirement.id,
    )
      ? scenario.requirements.map((current) =>
          current.id === requirement.id ? requirement : current,
        )
      : [...scenario.requirements, requirement];
    const next = { ...scenario, requirements };
    set((state) => ({
      ...invalidatedLocalRun(state, true, false),
      scenario: next,
      solverResult: null,
      solverState: "idle",
      solverExecution: null,
    }));
    persistDraft(next, get().architecture, get().role);
  },
  removeRequirement: (id) => {
    cancelActiveLocalSimulation();
    solverRequestSequence += 1;
    const scenario = get().scenario;
    const next = {
      ...scenario,
      requirements: scenario.requirements.filter(
        (requirement) => requirement.id !== id,
      ),
    };
    set((state) => ({
      ...invalidatedLocalRun(state, true, false),
      scenario: next,
      solverResult: null,
      solverState: "idle",
      solverExecution: null,
    }));
    persistDraft(next, get().architecture, get().role);
  },
  refreshSharedScenario: async () => {
    const id = get().sharedScenarioId;
    if (!id) return;
    if (queuedSharedMutationCount > 0) return;
    const hostToken = get().sharedHostToken;
    activeSharedRefreshController?.abort();
    const controller = new AbortController();
    const refreshSequence = ++sharedRefreshSequence;
    activeSharedRefreshController = controller;
    try {
      const shared = await fetchSharedScenario(
        id,
        hostToken ?? undefined,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        refreshSequence !== sharedRefreshSequence ||
        get().sharedScenarioId !== id ||
        get().sharedHostToken !== hostToken
      )
        return;
      const derived = get().scenario.requirements.filter(
        (requirement) =>
          requirement.visibility === "derived" &&
          requirement.owner === "candidate",
      );
      const knownIds = new Set(
        shared.scenario.requirements.map(({ id }) => id),
      );
      const scenario =
        shared.role === "participant"
          ? {
              ...shared.scenario,
              requirements: [
                ...shared.scenario.requirements,
                ...derived.filter(
                  (requirement) => !knownIds.has(requirement.id),
                ),
              ],
            }
          : shared.scenario;
      const scenarioChanged =
        JSON.stringify(get().scenario) !== JSON.stringify(scenario);
      if (scenarioChanged) {
        cancelActiveLocalSimulation();
        solverRequestSequence += 1;
      }
      set((state) => ({
        ...(scenarioChanged ? invalidatedLocalRun(state, true, false) : {}),
        scenario,
        role: shared.role,
        revealState: shared.revealState,
        collaboration: shared.collaboration,
        solverResult: null,
        solverState: "idle",
        solverExecution: null,
      }));
      persistDraft(scenario, get().architecture, shared.role);
      sessionStorage.setItem(
        "systemforge:session",
        JSON.stringify({
          id,
          ...(hostToken ? { hostToken } : {}),
          role: shared.role,
          revealState: shared.revealState,
        }),
      );
    } catch {
      if (controller.signal.aborted) return;
      // Server-backed session refresh is best-effort; local interview work remains usable.
    } finally {
      if (activeSharedRefreshController === controller)
        activeSharedRefreshController = null;
    }
  },
  setInterviewReveal: (revealed) => {
    const id = get().sharedScenarioId;
    const hostToken = get().sharedHostToken;
    if (!id || !hostToken) {
      set({
        notice:
          "Controlled reveal requires an interviewer server-backed link. Local interview links keep private criteria isolated.",
      });
      return Promise.resolve();
    }
    cancelSharedScenarioRefresh();
    return queueSharedScenarioMutation(async (signal, epoch) => {
      if (
        epoch !== sharedMutationEpoch ||
        get().sharedScenarioId !== id ||
        get().sharedHostToken !== hostToken
      )
        return;
      try {
        const shared = await setSharedScenarioReveal(
          id,
          hostToken,
          revealed,
          signal,
        );
        if (
          signal.aborted ||
          epoch !== sharedMutationEpoch ||
          get().sharedScenarioId !== id ||
          get().sharedHostToken !== hostToken
        )
          return;
        set({
          revealState: shared.revealState,
          collaboration: shared.collaboration,
          notice: revealed
            ? "Candidate criteria revealed for this server-backed interview session."
            : "Candidate criteria concealed for this server-backed interview session.",
        });
      } catch (error) {
        if (
          signal.aborted ||
          epoch !== sharedMutationEpoch ||
          get().sharedScenarioId !== id ||
          get().sharedHostToken !== hostToken
        )
          return;
        set({
          notice:
            error instanceof Error
              ? error.message
              : "The interview reveal state could not be updated.",
        });
      }
    });
  },
  updateInterviewCollaboration: (patch) => {
    const id = get().sharedScenarioId;
    const hostToken = get().sharedHostToken;
    if (!id) {
      set({
        notice:
          "Publish this interview to open its shared journal, cursor, and clock.",
      });
      return Promise.resolve();
    }
    cancelSharedScenarioRefresh();
    return queueSharedScenarioMutation(async (signal, epoch) => {
      if (
        epoch !== sharedMutationEpoch ||
        get().sharedScenarioId !== id ||
        get().sharedHostToken !== hostToken
      )
        return;
      try {
        const shared = await updateCanonicalInterviewCollaboration(
          id,
          patch,
          hostToken ?? undefined,
          signal,
        );
        if (
          signal.aborted ||
          epoch !== sharedMutationEpoch ||
          get().sharedScenarioId !== id ||
          get().sharedHostToken !== hostToken
        )
          return;
        set({
          collaboration: shared.collaboration,
          notice: "Interview session state synchronized.",
        });
      } catch (error) {
        if (
          signal.aborted ||
          epoch !== sharedMutationEpoch ||
          get().sharedScenarioId !== id ||
          get().sharedHostToken !== hostToken
        )
          return;
        set({
          notice:
            error instanceof Error
              ? error.message
              : "The interview session state could not be synchronized.",
        });
      }
    });
  },
  checkService: async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2_500);
    const apiAvailability = await checkApi(controller.signal);
    window.clearTimeout(timeout);
    set({ apiAvailability });
  },
  runLocal: async () => {
    cancelActiveLocalSimulation();
    const replayFork = pendingLocalRunFork;
    pendingLocalRunFork = null;
    const replaySource = replayFork ? null : pendingReplaySource;
    pendingReplaySource = null;
    const snapshot = get();
    const runStartedAt = new Date().toISOString();
    const identity: SimulationRunIdentity = {
      runId: `lab-${Date.now().toString(36)}-${++localRunSequence}`,
      scenarioRevision: snapshot.scenarioRevision,
      architectureRevision: snapshot.architectureRevision,
      scenarioId: snapshot.scenario.id,
      architectureId: snapshot.architecture.id,
    };
    const initialSession: LocalRunSessionSnapshot = {
      identity,
      state: "starting",
      speed: 1,
      progress: replayFork
        ? replayFork.snapshot.cursor.nextFrame /
          Math.max(1, replayFork.snapshot.scenario.workload.durationSeconds + 1)
        : 0,
      deliveredFrames: replayFork?.snapshot.cursor.nextFrame ?? 0,
      deliveredEvents: replayFork?.snapshot.cursor.nextEvent ?? 0,
      totalFrames: replayFork
        ? Math.max(
            replayFork.snapshot.cursor.nextFrame,
            replayFork.snapshot.scenario.workload.durationSeconds + 1,
          )
        : 0,
      totalEvents: replayFork?.snapshot.cursor.nextEvent ?? 0,
    };
    const replayActions = structuredClone(
      replayFork?.snapshot.actions ??
        replaySource?.manifest.simulationActions ??
        [],
    );
    const replaySourceRunId =
      replayFork?.snapshot.sourceRunId ?? replaySource?.manifest.runId;
    let initialActionLog = appendCompletedRunAction(
      [],
      replaySourceRunId ? "replay-start" : "start",
      replayFork?.snapshot.cursor.deliveredSecond ?? null,
      {
        value: 1,
        ...(replaySourceRunId ? { sourceRunId: replaySourceRunId } : {}),
      },
    );
    for (const action of replayActions)
      initialActionLog = appendCompletedRunAction(
        initialActionLog,
        action.type,
        null,
        { action },
      );
    set({
      result: null,
      runState: "running",
      workspaceMode: "run",
      notice: replayFork ? "Opening captured fork from t+0…" : null,
      localRunSession: initialSession,
      localRunFrames: structuredClone(replayFork?.frames ?? []),
      localRunEvents: structuredClone(replayFork?.events ?? []),
      localRunActions: replayActions,
      localRunActionLog: initialActionLog,
      localRunSnapshot: null,
      localRunForkSnapshot: null,
    });
    let replayForkReady = false;
    try {
      const session = startLocalSimulation(
        snapshot.scenario,
        snapshot.architecture,
        {
          identity,
          ...(replayFork
            ? { restore: replayFork.snapshot }
            : replayActions.length > 0
              ? { actions: replayActions }
              : {}),
          onBatch: (message) => {
            set((state) => {
              if (!currentLocalRunMatches(state, identity)) return {};
              const frames = state.localRunFrames.slice();
              const events = state.localRunEvents.slice();
              frames.splice(
                message.frameOffset,
                message.frames.length,
                ...message.frames,
              );
              events.splice(
                message.eventOffset,
                message.events.length,
                ...message.events,
              );
              return {
                localRunFrames: frames,
                localRunEvents: events,
                localRunSession: {
                  ...state.localRunSession!,
                  progress: message.progress,
                  deliveredFrames: message.deliveredFrames,
                  deliveredEvents: message.deliveredEvents,
                  totalFrames: message.totalFrames,
                  totalEvents: message.totalEvents,
                },
              };
            });
          },
          onStateChange: (sessionState, message) => {
            set((state) => {
              if (!currentLocalRunMatches(state, identity)) return {};
              const current = state.localRunSession!;
              if (message?.type === "action-applied")
                return {
                  localRunActions: [
                    ...state.localRunActions,
                    structuredClone(message.action),
                  ],
                  localRunActionLog: appendCompletedRunAction(
                    state.localRunActionLog,
                    message.action.type,
                    message.deliveredSecond,
                    { action: message.action },
                  ),
                  localRunSession: {
                    ...current,
                    totalFrames: message.totalFrames,
                    totalEvents: message.totalEvents,
                  },
                  notice: `Scheduled ${message.action.type === "inject-incident" ? message.action.incident.label : message.action.intervention.kind} for modeled second ${message.action.atSecond}. Delivered output through second ${message.deliveredSecond ?? "none"} remains byte-identical.`,
                };
              if (message?.type === "snapshot-created")
                return {
                  localRunSnapshot: message.snapshot,
                  localRunActionLog: appendCompletedRunAction(
                    state.localRunActionLog,
                    "snapshot",
                    message.snapshot.cursor.deliveredSecond,
                    { snapshotId: message.snapshot.snapshotId },
                  ),
                  notice: `Snapshot captured at t+${message.snapshot.cursor.deliveredSecond ?? 0}s.`,
                };
              if (message?.type === "fork-created")
                return {
                  localRunForkSnapshot: message.snapshot,
                  localRunActionLog: appendCompletedRunAction(
                    state.localRunActionLog,
                    "fork",
                    message.snapshot.cursor.deliveredSecond,
                    {
                      snapshotId: message.snapshot.snapshotId,
                      forkKey: message.forkKey,
                    },
                  ),
                  notice: `Captured replay fork ${message.forkKey} at modeled second ${message.snapshot.cursor.deliveredSecond ?? "before delivery"}. It reproduces state by replaying from second 0.`,
                };
              if (message?.type === "command-rejected")
                return { notice: message.reason };
              const started = message?.type === "started" ? message : null;
              const forkBecameReady =
                replayFork !== null &&
                message?.type === "paused" &&
                !replayForkReady;
              if (forkBecameReady) replayForkReady = true;
              const effectiveSessionState =
                replayFork !== null &&
                message?.type === "started" &&
                !replayForkReady
                  ? "starting"
                  : sessionState;
              return {
                runState:
                  sessionState === "error"
                    ? "error"
                    : sessionState === "cancelled"
                      ? "idle"
                      : sessionState === "complete"
                        ? "complete"
                        : "running",
                localRunSession: {
                  ...current,
                  state: effectiveSessionState,
                  speed: speedFromMessage(message, current.speed),
                  progress: sessionState === "complete" ? 1 : current.progress,
                  totalFrames: started?.totalFrames ?? current.totalFrames,
                  totalEvents: started?.totalEvents ?? current.totalEvents,
                },
                ...(forkBecameReady
                  ? {
                      notice: `Fork opened at t+${replayFork.snapshot.cursor.deliveredSecond ?? 0}s. Recomputed from t+0.`,
                    }
                  : {}),
              };
            });
          },
        },
      );
      activeLocalSimulation = session;
      const result = await session.result;
      if (!currentLocalRunMatches(get(), identity)) return;
      const completionState = get();
      const snapshotSecond =
        deliveredSecond(completionState) ?? result.frames.at(-1)?.second ?? 0;
      const completedActionLog = appendCompletedRunAction(
        completionState.localRunActionLog,
        "complete",
        snapshotSecond,
      );
      set({
        result,
        runState: "complete",
        workspaceMode: "investigate",
        localRunActionLog: completedActionLog,
      });
      try {
        const artifact = await createCompletedRunArtifact({
          identity,
          scenario: snapshot.scenario,
          architecture: snapshot.architecture,
          result,
          actionLog: completedActionLog,
          simulationActions: completionState.localRunActions,
          snapshotSecond,
          ...(replaySource ? { replayOf: replaySource } : {}),
        });
        if (!currentLocalRunMatches(get(), identity)) return;
        set({ completedRunArtifact: artifact });
        const historyRecord = await createCompletedRunHistoryRecord(artifact, {
          startedAt: runStartedAt,
        });
        if (!historyRecord) return;
        const history = await addLocalRunHistoryRecord(historyRecord);
        if (!currentLocalRunMatches(get(), identity)) return;
        set({
          runHistory: history.records,
          runHistoryUsedBytes: history.usedBytes,
          runHistoryMaximumBytes: history.maximumBytes,
          runHistoryIssue: history.issue,
        });
      } catch {
        if (!currentLocalRunMatches(get(), identity)) return;
        set((state) => ({
          notice: state.completedRunArtifact
            ? "The run completed and its evidence is available, but the browser could not add it to local Run history."
            : "The run completed, but its local evidence manifest could not be created.",
        }));
      }
    } catch (error) {
      if (!currentLocalRunMatches(get(), identity)) return;
      try {
        const historyRecord = createTerminalRunHistoryRecord({
          identity,
          status:
            error instanceof SimulationRunCancelledError
              ? "cancelled"
              : "failed",
          startedAt: runStartedAt,
          scenario: snapshot.scenario,
          architecture: snapshot.architecture,
          actionCount: get().localRunActionLog.length,
        });
        if (historyRecord) {
          const history = await addLocalRunHistoryRecord(historyRecord);
          set({
            runHistory: history.records,
            runHistoryUsedBytes: history.usedBytes,
            runHistoryMaximumBytes: history.maximumBytes,
            runHistoryIssue: history.issue,
          });
        }
      } catch {
        set({
          runHistoryIssue:
            "The terminal run state could not be added to local Run history.",
        });
      }
      if (error instanceof SimulationRunCancelledError) {
        set((state) => ({
          runState: "idle",
          localRunSession: state.localRunSession
            ? { ...state.localRunSession, state: "cancelled" }
            : null,
        }));
      } else
        set({
          runState: "error",
          ...(replayFork
            ? {
                localRunFrames: [],
                localRunEvents: [],
                localRunActions: [],
              }
            : {}),
          notice:
            error instanceof Error
              ? error.message
              : "The local simulation failed.",
        });
    } finally {
      if (activeLocalSimulation?.identity.runId === identity.runId)
        activeLocalSimulation = null;
    }
  },
  cancelLocalRun: () => {
    const active = activeLocalSimulation;
    if (!active) return;
    const state = get();
    if (currentLocalRunMatches(state, active.identity))
      set({
        localRunActionLog: appendCompletedRunAction(
          state.localRunActionLog,
          "cancel",
          deliveredSecond(state),
        ),
      });
    active.cancel();
    if (activeLocalSimulation === active) activeLocalSimulation = null;
  },
  pauseLocalRun: () => {
    const active = activeLocalSimulation;
    if (
      active &&
      currentLocalRunMatches(get(), active.identity) &&
      get().localRunSession?.state === "running"
    ) {
      const state = get();
      set({
        localRunActionLog: appendCompletedRunAction(
          state.localRunActionLog,
          "pause",
          deliveredSecond(state),
        ),
      });
      active.pause();
    }
  },
  resumeLocalRun: () => {
    const active = activeLocalSimulation;
    if (
      active &&
      currentLocalRunMatches(get(), active.identity) &&
      get().localRunSession?.state === "paused"
    ) {
      const state = get();
      set({
        localRunActionLog: appendCompletedRunAction(
          state.localRunActionLog,
          "resume",
          deliveredSecond(state),
        ),
      });
      active.resume();
    }
  },
  stepLocalRun: () => {
    const active = activeLocalSimulation;
    if (
      active &&
      currentLocalRunMatches(get(), active.identity) &&
      get().localRunSession?.state === "paused"
    ) {
      const state = get();
      set({
        localRunActionLog: appendCompletedRunAction(
          state.localRunActionLog,
          "step",
          deliveredSecond(state),
        ),
      });
      active.step();
    }
  },
  applyLocalIntervention: (nodeId, intervention) => {
    const active = activeLocalSimulation;
    const state = get();
    if (
      !active ||
      !currentLocalRunMatches(state, active.identity) ||
      state.localRunSession?.state !== "paused"
    ) {
      set({
        notice: "Pause an active local run before applying an intervention.",
      });
      return;
    }
    if (!state.architecture.nodes.some((node) => node.id === nodeId)) {
      set({ notice: "Select a node that exists in the active architecture." });
      return;
    }
    const atSecond = (deliveredSecond(state) ?? 0) + 1;
    if (atSecond > state.scenario.workload.durationSeconds) {
      set({ notice: "No future modeled second remains for an intervention." });
      return;
    }
    const suffix = `intervention-${state.localRunActions.length + 1}`;
    const action: Extract<SimulationAction, { type: "apply-intervention" }> = {
      type: "apply-intervention",
      id: `${active.identity.runId.slice(0, Math.max(1, 79 - suffix.length))}-${suffix}`,
      atSecond,
      nodeId,
      intervention,
    };
    active.applyIntervention(action);
  },
  injectLocalNodeOutage: (nodeId) => {
    const active = activeLocalSimulation;
    const state = get();
    if (
      !active ||
      !currentLocalRunMatches(state, active.identity) ||
      state.localRunSession?.state !== "paused"
    ) {
      set({
        notice:
          "Pause an active local run before failing one modeled instance.",
      });
      return;
    }
    const node = state.architecture.nodes.find(
      (candidate) => candidate.id === nodeId,
    );
    if (!node) {
      set({ notice: "Select a node that exists in the active architecture." });
      return;
    }
    const atSecond = (deliveredSecond(state) ?? 0) + 1;
    if (atSecond > state.scenario.workload.durationSeconds) {
      set({
        notice: "No future modeled second remains for an instance failure.",
      });
      return;
    }
    const suffix = `outage-${state.localRunActions.length + 1}`;
    const actionId = `${active.identity.runId.slice(0, Math.max(1, 79 - suffix.length))}-${suffix}`;
    const durationSeconds = Math.max(
      1,
      Math.min(30, state.scenario.workload.durationSeconds - atSecond + 1),
    );
    const action: Extract<SimulationAction, { type: "inject-incident" }> = {
      type: "inject-incident",
      id: actionId,
      atSecond,
      incident: {
        id: `${actionId.slice(0, 70)}-event`,
        kind: "node-failure",
        magnitude: 1,
        label: `${node.name} instance failure`,
        targetId: nodeId,
        durationSeconds,
      },
    };
    active.injectIncident(action);
  },
  snapshotLocalRun: () => {
    const active = activeLocalSimulation;
    if (
      active &&
      currentLocalRunMatches(get(), active.identity) &&
      get().localRunSession?.state === "paused"
    )
      active.snapshot();
    else
      set({
        notice: "Pause an active local run before capturing a replay snapshot.",
      });
  },
  forkLocalRunSession: () => {
    const active = activeLocalSimulation;
    const state = get();
    if (
      active &&
      currentLocalRunMatches(state, active.identity) &&
      state.localRunSession?.state === "paused"
    )
      active.fork(`branch-${state.localRunActionLog.length + 1}`);
    else
      set({
        notice: "Pause an active local run before capturing a replay fork.",
      });
  },
  openLocalRunFork: async () => {
    const state = get();
    const snapshot = state.localRunForkSnapshot;
    if (!snapshot) {
      set({
        notice: "Capture a paused local replay fork before opening a branch.",
      });
      return;
    }
    const { cursor } = snapshot;
    const cursorIsValid =
      Number.isInteger(cursor.nextFrame) &&
      Number.isInteger(cursor.nextEvent) &&
      Number.isInteger(cursor.batchIndex) &&
      cursor.nextFrame >= 0 &&
      cursor.nextEvent >= 0 &&
      cursor.batchIndex >= 0;
    const inputsMatch =
      state.scenario.id === snapshot.scenario.id &&
      state.architecture.id === snapshot.architecture.id;
    const sourceMatches =
      state.localRunSession?.identity.runId === snapshot.sourceRunId;
    const restorationBoundaryIsValid =
      snapshot.version === 1 &&
      snapshot.restoration === "deterministic-replay-from-second-zero" &&
      snapshot.opaqueRuntimeStateSerialized === false;
    if (
      !cursorIsValid ||
      !inputsMatch ||
      !sourceMatches ||
      !restorationBoundaryIsValid
    ) {
      set({
        notice:
          "This captured fork no longer matches the active local run and cannot be opened safely.",
      });
      return;
    }
    const frames = state.localRunFrames.slice(0, cursor.nextFrame);
    const events = state.localRunEvents.slice(0, cursor.nextEvent);
    if (
      frames.length !== cursor.nextFrame ||
      events.length !== cursor.nextEvent ||
      (frames.at(-1)?.second ?? null) !== cursor.deliveredSecond
    ) {
      set({
        notice:
          "The delivered prefix for this captured fork is no longer available, so the branch was not opened.",
      });
      return;
    }
    pendingReplaySource = null;
    pendingLocalRunFork = {
      snapshot: structuredClone(snapshot),
      frames: structuredClone(frames),
      events: structuredClone(events),
    };
    await get().runLocal();
  },
  finishLocalRun: () => {
    const active = activeLocalSimulation;
    const state = get();
    if (
      active &&
      currentLocalRunMatches(state, active.identity) &&
      state.localRunSession?.state === "paused"
    ) {
      set({
        localRunActionLog: appendCompletedRunAction(
          state.localRunActionLog,
          "finish",
          deliveredSecond(state),
        ),
      });
      active.finish();
    } else
      set({ notice: "Pause an active local run before finishing playback." });
  },
  setLocalRunSpeed: (speed) => {
    const active = activeLocalSimulation;
    if (active && currentLocalRunMatches(get(), active.identity)) {
      const boundedSpeed = Number.isFinite(speed)
        ? Math.min(16, Math.max(0.25, speed))
        : 1;
      const state = get();
      set({
        localRunActionLog: appendCompletedRunAction(
          state.localRunActionLog,
          "set-speed",
          deliveredSecond(state),
          { value: boundedSpeed },
        ),
      });
      active.setSpeed(boundedSpeed);
    }
  },
  setCompletedRunSnapshotSecond: (second) => {
    const artifact = get().completedRunArtifact;
    if (!artifact) return;
    const completedRunArtifact = withCompletedRunSnapshot(artifact, second);
    set({
      completedRunArtifact,
      notice: `Selected modeled second ${completedRunArtifact.manifest.snapshot.deliveredSecond} from the completed run. No simulation state was recomputed.`,
    });
  },
  updateRunHistoryRecord: async (id, patch) => {
    try {
      const history = await updateLocalRunHistoryRecord(id, patch);
      set({
        runHistory: history.records,
        runHistoryUsedBytes: history.usedBytes,
        runHistoryMaximumBytes: history.maximumBytes,
        runHistoryIssue: history.issue,
      });
    } catch (error) {
      set({
        runHistoryIssue:
          error instanceof LocalRunHistoryStorageError
            ? error.message
            : "The local run record could not be updated.",
      });
    }
  },
  removeRunHistoryRecord: async (id) => {
    try {
      const history = await removeLocalRunHistoryRecord(id);
      set({
        runHistory: history.records,
        runHistoryUsedBytes: history.usedBytes,
        runHistoryMaximumBytes: history.maximumBytes,
        runHistoryIssue: history.issue,
      });
    } catch (error) {
      set({
        runHistoryIssue:
          error instanceof LocalRunHistoryStorageError
            ? error.message
            : "The local run record could not be deleted.",
      });
    }
  },
  clearRunHistory: async () => {
    try {
      const history = await clearLocalRunHistory();
      set({
        runHistory: history.records,
        runHistoryUsedBytes: history.usedBytes,
        runHistoryMaximumBytes: history.maximumBytes,
        runHistoryIssue: null,
      });
    } catch {
      set({
        runHistoryIssue: "The browser could not clear the local Run history.",
      });
    }
  },
  replayCompletedRun: async () => {
    const source = get().completedRunArtifact;
    if (!source) {
      set({ notice: "Complete a local run before replaying it." });
      return;
    }
    const inputs = completedRunReplayInputs(source);
    cancelActiveLocalSimulation();
    solverRequestSequence += 1;
    const currentArchitecture = get().architecture;
    set((state) => ({
      ...invalidatedLocalRun(state, true, true),
      scenario: inputs.scenario,
      architecture: inputs.architecture,
      architectureUndo: [
        ...state.architectureUndo,
        structuredClone(currentArchitecture),
      ].slice(-HISTORY_LIMIT),
      architectureRedo: [],
      transientArchitectureUpdate: null,
      completedRunFork: null,
      solverResult: null,
      solverState: "idle",
      solverExecution: null,
      canonicalRunId: null,
      canonicalRunStatus: "idle",
      canonicalRunDigest: null,
      notice:
        "Restored the completed run inputs for deterministic replay. This does not alter the original run.",
    }));
    persistDraft(inputs.scenario, inputs.architecture, get().role);
    pendingReplaySource = source;
    await get().runLocal();
  },
  queueImportedReplay: (bundle) => {
    const intentId = `imported-replay-${Date.now().toString(36)}-${++importedReplayIntentSequence}`;
    pendingImportedReplay = {
      intentId,
      queuedAt: Date.now(),
      bundle: structuredClone(bundle),
    };
    return intentId;
  },
  consumeQueuedImportedReplay: async (intentId) => {
    const pending = pendingImportedReplay;
    if (!pending || pending.intentId !== intentId) return;
    pendingImportedReplay = null;
    if (Date.now() - pending.queuedAt > IMPORTED_REPLAY_INTENT_TTL_MS) {
      set({
        notice:
          "The replay transfer expired. Return to Replay and verify the bundle again.",
      });
      return;
    }
    await get().replayImportedBundle(pending.bundle);
  },
  replayImportedBundle: async (bundle) => {
    const compatibility = assessCompletedRunReplayCompatibility(bundle);
    if (!compatibility.compatible) {
      set({
        notice: `Replay was not started. ${compatibility.issues.join(" ")}`,
      });
      return;
    }
    hydrationSequence += 1;
    cancelActiveLocalSimulation();
    cancelSharedScenarioOperations();
    solverRequestSequence += 1;
    const source = completedRunReplaySourceFromBundle(bundle);
    const inputs = completedRunReplayInputs(source);
    const scenario = candidateScenario(inputs.scenario);
    const currentArchitecture = get().architecture;
    set((state) => ({
      ...invalidatedLocalRun(state, true, true),
      scenario,
      architecture: inputs.architecture,
      architectureUndo: [
        ...state.architectureUndo,
        structuredClone(currentArchitecture),
      ].slice(-HISTORY_LIMIT),
      architectureRedo: [],
      transientArchitectureUpdate: null,
      completedRunArtifact: null,
      completedRunFork: null,
      solverResult: null,
      solverState: "idle",
      solverExecution: null,
      selectedEventId: null,
      canonicalRunId: null,
      canonicalRunStatus: "idle",
      canonicalRunDigest: null,
      role: "participant",
      sharedScenarioId: null,
      sharedHostToken: null,
      revealState: "hidden",
      collaboration: emptyCollaboration(),
      notice:
        "Verified and loaded a candidate-safe replay bundle. Recomputing from modeled second 0.",
    }));
    persistDraft(scenario, inputs.architecture, "participant");
    sessionStorage.removeItem("systemforge:session");
    pendingReplaySource = source;
    await get().runLocal();
  },
  forkCompletedRun: (second) => {
    const artifact = get().completedRunArtifact;
    if (!artifact) {
      set({ notice: "Complete a local run before creating a fork." });
      return;
    }
    const fork = forkCompletedRunAtSecond(
      artifact,
      second,
      `${++completedRunForkSequence}`,
    );
    cancelActiveLocalSimulation();
    pendingReplaySource = null;
    solverRequestSequence += 1;
    const currentArchitecture = get().architecture;
    set((state) => ({
      ...invalidatedLocalRun(state, true, true),
      scenario: fork.scenario,
      architecture: fork.architecture,
      architectureUndo: [
        ...state.architectureUndo,
        structuredClone(currentArchitecture),
      ].slice(-HISTORY_LIMIT),
      architectureRedo: [],
      transientArchitectureUpdate: null,
      completedRunFork: fork,
      solverResult: null,
      solverState: "idle",
      solverExecution: null,
      canonicalRunId: null,
      canonicalRunStatus: "idle",
      canonicalRunDigest: null,
      sharedScenarioId: null,
      sharedHostToken: null,
      revealState: "hidden",
      notice: `Forked the static run inputs at modeled second ${fork.snapshot.deliveredSecond}. The original run was not recomputed.`,
    }));
    persistDraft(fork.scenario, fork.architecture, get().role);
    sessionStorage.removeItem("systemforge:session");
  },
  solveAlternatives: async (options = {}) => {
    const requestSequence = ++solverRequestSequence;
    const scenario = get().scenario;
    const architecture = get().architecture;
    set({
      solverState: "running",
      solverResult: null,
      solverExecution: null,
      notice: null,
    });
    const includeHiddenRequirements = get().role === "interviewer";
    try {
      const solved = await solveArchitectureWithFallback(
        scenario,
        architecture,
        { ...options, includeHiddenRequirements },
        get().apiAvailability === "online" && !includeHiddenRequirements,
      );
      if (
        requestSequence !== solverRequestSequence ||
        get().scenario !== scenario ||
        get().architecture !== architecture
      )
        return;
      set({
        solverResult: solved.result,
        solverState: "complete",
        solverExecution: solved.execution,
        notice: solved.fallbackReason
          ? `The server solver was unavailable, so this comparison ran locally. ${solved.fallbackReason}`
          : null,
      });
    } catch (error) {
      if (
        requestSequence !== solverRequestSequence ||
        get().scenario !== scenario ||
        get().architecture !== architecture
      )
        return;
      set({
        solverState: "error",
        solverExecution: null,
        notice:
          error instanceof Error
            ? error.message
            : "The architecture solver failed.",
      });
    }
  },
  submitCanonical: async () => {
    const submissionSequence = ++canonicalSubmissionSequence;
    if (get().apiAvailability !== "online") {
      set({
        notice:
          "Server run submission is unavailable. Your architecture still runs locally in this browser.",
      });
      return;
    }
    const submitted = get();
    const submittedScenario = submitted.scenario;
    const submittedArchitecture = submitted.architecture;
    const submissionInputsAreCurrent = (): boolean => {
      const current = get();
      return (
        submissionSequence === canonicalSubmissionSequence &&
        current.scenarioRevision === submitted.scenarioRevision &&
        current.architectureRevision === submitted.architectureRevision &&
        current.scenario.id === submittedScenario.id &&
        current.architecture.id === submittedArchitecture.id
      );
    };
    const revealContext =
      submitted.sharedScenarioId &&
      submitted.role === "participant" &&
      submittedScenario.mode === "interview"
        ? {
            sharedScenarioId: submitted.sharedScenarioId,
            scenarioId: submittedScenario.id,
            scenarioRevision: submitted.scenarioRevision,
          }
        : null;
    const revealContextIsCurrent = (): boolean => {
      if (!revealContext) return false;
      const current = get();
      return (
        submissionSequence === canonicalSubmissionSequence &&
        current.sharedScenarioId === revealContext.sharedScenarioId &&
        current.role === "participant" &&
        current.scenario.mode === "interview" &&
        current.scenario.id === revealContext.scenarioId &&
        current.scenarioRevision === revealContext.scenarioRevision
      );
    };
    try {
      const receipt = await submitCanonicalRun({
        scenario: submittedScenario,
        architecture: submittedArchitecture,
        clientEngineVersion: ENGINE_VERSION,
        ...(revealContext
          ? { sharedScenarioId: revealContext.sharedScenarioId }
          : {}),
      });
      if (!submissionInputsAreCurrent()) return;
      set({
        canonicalRunId: receipt.id,
        canonicalRunStatus: "queued",
        canonicalRunDigest: null,
        notice: `Server run ${receipt.id.slice(0, 8)} queued. Local work remains available while it runs.`,
      });
      for (let attempt = 0; attempt < 75; attempt += 1) {
        const run = await fetchCanonicalRun(receipt.id);
        if (
          !submissionInputsAreCurrent() ||
          get().canonicalRunId !== receipt.id
        )
          return;
        set({ canonicalRunStatus: run.status });
        if (run.status === "completed") {
          const completedNotice = `Server run ${receipt.id.slice(0, 8)} completed with engine ${run.result?.engineVersion ?? "unknown"}.`;
          set({
            canonicalRunDigest: run.digest ?? run.result?.digest ?? null,
            notice: completedNotice,
          });
          if (!revealContextIsCurrent()) return;
          try {
            const shared = await recordSharedScenarioRun(
              revealContext!.sharedScenarioId,
              receipt.id,
            );
            if (
              !revealContextIsCurrent() ||
              get().canonicalRunId !== receipt.id
            )
              return;
            const derived = get().scenario.requirements.filter(
              (requirement) =>
                requirement.visibility === "derived" &&
                requirement.owner === "candidate",
            );
            const knownIds = new Set(
              shared.scenario.requirements.map(({ id }) => id),
            );
            const scenario = {
              ...shared.scenario,
              requirements: [
                ...shared.scenario.requirements,
                ...derived.filter(
                  (requirement) => !knownIds.has(requirement.id),
                ),
              ],
            };
            set({
              scenario,
              revealState: shared.revealState,
              solverResult: null,
              solverState: "idle",
              solverExecution: null,
              notice:
                shared.revealState === "revealed"
                  ? `${completedNotice} Server-verified interview criteria are now revealed.`
                  : completedNotice,
            });
            persistDraft(scenario, get().architecture, "participant");
            sessionStorage.setItem(
              "systemforge:session",
              JSON.stringify({
                id: revealContext!.sharedScenarioId,
                role: "participant",
                revealState: shared.revealState,
              }),
            );
          } catch {
            if (revealContextIsCurrent() && get().canonicalRunId === receipt.id)
              set({
                notice: `${completedNotice} The server-backed interview reveal could not be synchronized.`,
              });
          }
          return;
        }
        if (run.status === "failed") {
          set({
            notice: `Server run ${receipt.id.slice(0, 8)} failed: ${run.failureMessage ?? run.failureCode ?? "unknown worker failure"}. Local simulation remains available.`,
          });
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
      if (submissionInputsAreCurrent() && get().canonicalRunId === receipt.id)
        set({
          notice: `Server run ${receipt.id.slice(0, 8)} is still queued. You can keep working locally and check it again later.`,
        });
    } catch (error) {
      if (!submissionInputsAreCurrent()) return;
      const code =
        typeof error === "object" && error && "code" in error
          ? String(error.code)
          : null;
      const retry =
        typeof error === "object" && error && "retryAfterSeconds" in error
          ? Number(error.retryAfterSeconds)
          : null;
      set({
        apiAvailability: retry ? "busy" : "offline",
        canonicalRunStatus:
          get().canonicalRunStatus === "queued" ||
          get().canonicalRunStatus === "running"
            ? get().canonicalRunStatus
            : "idle",
        notice:
          code === "engine_version_mismatch"
            ? "This browser uses an older simulation engine. Refresh the application before retrying server submission; the current architecture still runs locally."
            : retry
              ? `Server run capacity is busy. Try again in about ${retry} seconds; local simulation remains available.`
              : "The service could not accept this run. Local simulation remains available.",
      });
    }
  },
  dismissNotice: () => set({ notice: null }),
}));
