import {
  architectureSchema,
  candidateScenario,
  scenarioSchema,
  type Architecture,
  type Requirement,
  type Scenario,
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
import { runLocalSimulation } from "../lib/localSimulation";
import { decodeLocalShare } from "../lib/share";
import { solveArchitectureWithFallback } from "../lib/solverGateway";

export type WorkspaceMode = "build" | "run" | "investigate";

export interface ArchitectureSnapshot {
  id: string;
  label: string;
  createdAt: string;
  architecture: Architecture;
}

interface LabState {
  scenario: Scenario;
  architecture: Architecture;
  architectureUndo: Architecture[];
  architectureRedo: Architecture[];
  architectureSnapshots: ArchitectureSnapshot[];
  result: SimulationResult | null;
  solverResult: SolveArchitectureResult | null;
  selectedNodeId: string | null;
  selectedEventId: string | null;
  workspaceMode: WorkspaceMode;
  runState: "idle" | "running" | "complete" | "error";
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
  hydrate: () => void;
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

const HISTORY_LIMIT = 40;
const SNAPSHOT_STORAGE_KEY = "systemforge:architecture-snapshots";
const emptyCollaboration = (): InterviewCollaboration => ({
  candidateNotes: "",
  candidateCursor: "Preparing workspace",
  startedAt: null,
  updatedAt: new Date(0).toISOString(),
});

const persistDraft = (scenario: Scenario, architecture: Architecture) =>
  localStorage.setItem(
    "systemforge:draft",
    JSON.stringify({ scenario, architecture }),
  );

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
      const architecture = architectureSchema.safeParse(candidate.architecture);
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
    const hostToken =
      typeof parsed.hostToken === "string" &&
      UUID_PATTERN.test(parsed.hostToken)
        ? parsed.hostToken
        : undefined;
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
  architectureUndo: [],
  architectureRedo: [],
  architectureSnapshots: [],
  result: null,
  solverResult: null,
  selectedNodeId: "api",
  selectedEventId: null,
  workspaceMode: "build",
  runState: "idle",
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
    const architectureSnapshots = parseArchitectureSnapshots(
      localStorage.getItem(SNAPSHOT_STORAGE_KEY),
    );
    set({ architectureSnapshots });
    const sessionValue = sessionStorage.getItem("systemforge:session");
    const session = parseStoredSession(sessionValue);
    if (sessionValue && !session)
      sessionStorage.removeItem("systemforge:session");
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const shared = hash.get("share");
    if (shared) {
      sessionStorage.removeItem("systemforge:session");
      const decoded = decodeLocalShare(shared);
      if (decoded) {
        const scenario =
          decoded.role === "interviewer"
            ? decoded.scenario
            : candidateScenario(decoded.scenario);
        set({
          scenario,
          architecture:
            decoded.architecture ?? structuredClone(DEFAULT_ARCHITECTURE),
          role: decoded.role,
          notice: "Shared scenario loaded locally. No server was required.",
          sharedScenarioId: null,
          sharedHostToken: null,
          revealState: "hidden",
          collaboration: emptyCollaboration(),
        });
        return;
      }
      set({
        notice:
          "This local share link is invalid or uses an unsupported schema version.",
      });
      return;
    }
    if (
      !session &&
      get().role === "interviewer" &&
      get().scenario.mode === "interview"
    )
      return;
    const draft = localStorage.getItem("systemforge:draft");
    if (draft) {
      try {
        const parsed = JSON.parse(draft) as Record<string, unknown>;
        const parsedScenario = scenarioSchema.parse(parsed.scenario);
        const architecture = parsed.architecture
          ? architectureSchema.parse(parsed.architecture)
          : structuredClone(DEFAULT_ARCHITECTURE);
        const role = session?.role ?? "participant";
        const revealState = session?.revealState ?? "hidden";
        const scenario =
          role === "interviewer"
            ? parsedScenario
            : candidateScenario(parsedScenario);
        set({
          scenario,
          architecture,
          role,
          sharedScenarioId: session?.id ?? null,
          sharedHostToken: session?.hostToken ?? null,
          revealState,
          collaboration: emptyCollaboration(),
        });
      } catch {
        localStorage.removeItem("systemforge:draft");
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
    }
  },
  loadSharedScenario: (scenario, architecture, role, session) => {
    localStorage.setItem(
      "systemforge:draft",
      JSON.stringify({ scenario, architecture }),
    );
    set({
      scenario,
      architecture,
      role,
      result: null,
      solverResult: null,
      runState: "idle",
      solverState: "idle",
      solverExecution: null,
      notice:
        role === "interviewer"
          ? "Interviewer scenario loaded with private criteria."
          : session?.revealState === "revealed"
            ? "Shared scenario loaded. The interviewer has revealed the evaluation criteria."
            : "Shared scenario loaded. Hidden interviewer criteria remain private.",
      canonicalRunId: null,
      canonicalRunStatus: "idle",
      canonicalRunDigest: null,
      sharedScenarioId: session?.id ?? null,
      sharedHostToken: session?.hostToken ?? null,
      revealState: session?.revealState ?? "hidden",
      collaboration: session?.collaboration ?? emptyCollaboration(),
    });
    if (session) {
      sessionStorage.setItem(
        "systemforge:session",
        JSON.stringify({
          id: session.id,
          ...(session.hostToken ? { hostToken: session.hostToken } : {}),
          role,
          revealState: session.revealState,
        }),
      );
    } else {
      sessionStorage.removeItem("systemforge:session");
    }
  },
  setScenario: (scenario) => {
    set({
      scenario,
      result: null,
      solverResult: null,
      runState: "idle",
      solverState: "idle",
      solverExecution: null,
      canonicalRunId: null,
      canonicalRunStatus: "idle",
      canonicalRunDigest: null,
    });
    persistDraft(scenario, get().architecture);
  },
  setArchitecture: (architecture) => {
    const current = get().architecture;
    set({
      architecture,
      architectureUndo: [
        ...get().architectureUndo,
        structuredClone(current),
      ].slice(-HISTORY_LIMIT),
      architectureRedo: [],
      result: null,
      solverResult: null,
      runState: "idle",
      solverState: "idle",
      solverExecution: null,
      canonicalRunId: null,
      canonicalRunStatus: "idle",
      canonicalRunDigest: null,
    });
    persistDraft(get().scenario, architecture);
  },
  canUndo: () => get().architectureUndo.length > 0,
  canRedo: () => get().architectureRedo.length > 0,
  undoArchitecture: () => {
    const undo = get().architectureUndo;
    const previous = undo.at(-1);
    if (!previous) return;
    const current = get().architecture;
    set({
      architecture: structuredClone(previous),
      architectureUndo: undo.slice(0, -1),
      architectureRedo: [
        structuredClone(current),
        ...get().architectureRedo,
      ].slice(0, HISTORY_LIMIT),
      result: null,
      solverResult: null,
      runState: "idle",
      solverState: "idle",
      solverExecution: null,
      notice: "Architecture change undone.",
    });
    persistDraft(get().scenario, previous);
  },
  redoArchitecture: () => {
    const redo = get().architectureRedo;
    const next = redo[0];
    if (!next) return;
    const current = get().architecture;
    set({
      architecture: structuredClone(next),
      architectureUndo: [
        ...get().architectureUndo,
        structuredClone(current),
      ].slice(-HISTORY_LIMIT),
      architectureRedo: redo.slice(1),
      result: null,
      solverResult: null,
      runState: "idle",
      solverState: "idle",
      solverExecution: null,
      notice: "Architecture change restored.",
    });
    persistDraft(get().scenario, next);
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
    const scenario = get().scenario;
    const requirements = scenario.requirements.some(
      (current) => current.id === requirement.id,
    )
      ? scenario.requirements.map((current) =>
          current.id === requirement.id ? requirement : current,
        )
      : [...scenario.requirements, requirement];
    const next = { ...scenario, requirements };
    set({
      scenario: next,
      result: null,
      solverResult: null,
      runState: "idle",
      solverState: "idle",
      solverExecution: null,
    });
    localStorage.setItem(
      "systemforge:draft",
      JSON.stringify({ scenario: next, architecture: get().architecture }),
    );
  },
  removeRequirement: (id) => {
    const scenario = get().scenario;
    const next = {
      ...scenario,
      requirements: scenario.requirements.filter(
        (requirement) => requirement.id !== id,
      ),
    };
    set({
      scenario: next,
      result: null,
      solverResult: null,
      runState: "idle",
      solverState: "idle",
      solverExecution: null,
    });
    localStorage.setItem(
      "systemforge:draft",
      JSON.stringify({ scenario: next, architecture: get().architecture }),
    );
  },
  refreshSharedScenario: async () => {
    const id = get().sharedScenarioId;
    if (!id) return;
    try {
      const shared = await fetchSharedScenario(
        id,
        get().sharedHostToken ?? undefined,
      );
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
      set({
        scenario,
        role: shared.role,
        revealState: shared.revealState,
        collaboration: shared.collaboration,
        solverResult: null,
        solverState: "idle",
        solverExecution: null,
      });
      localStorage.setItem(
        "systemforge:draft",
        JSON.stringify({ scenario, architecture: get().architecture }),
      );
      sessionStorage.setItem(
        "systemforge:session",
        JSON.stringify({
          id,
          ...(get().sharedHostToken
            ? { hostToken: get().sharedHostToken }
            : {}),
          role: shared.role,
          revealState: shared.revealState,
        }),
      );
    } catch {
      // Canonical session refresh is best-effort; local interview work remains usable.
    }
  },
  setInterviewReveal: async (revealed) => {
    const id = get().sharedScenarioId;
    const hostToken = get().sharedHostToken;
    if (!id || !hostToken) {
      set({
        notice:
          "Controlled reveal requires an interviewer canonical link. Local interview links keep private criteria isolated.",
      });
      return;
    }
    try {
      const shared = await setSharedScenarioReveal(id, hostToken, revealed);
      set({
        revealState: shared.revealState,
        collaboration: shared.collaboration,
        notice: revealed
          ? "Candidate criteria revealed for this canonical interview session."
          : "Candidate criteria concealed for this canonical interview session.",
      });
    } catch (error) {
      set({
        notice:
          error instanceof Error
            ? error.message
            : "The interview reveal state could not be updated.",
      });
    }
  },
  updateInterviewCollaboration: async (patch) => {
    const id = get().sharedScenarioId;
    if (!id) {
      set({
        notice:
          "Publish this interview to open its shared journal, cursor, and clock.",
      });
      return;
    }
    try {
      const shared = await updateCanonicalInterviewCollaboration(
        id,
        patch,
        get().sharedHostToken ?? undefined,
      );
      set({
        collaboration: shared.collaboration,
        notice: "Interview session state synchronized.",
      });
    } catch (error) {
      set({
        notice:
          error instanceof Error
            ? error.message
            : "The interview session state could not be synchronized.",
      });
    }
  },
  checkService: async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2_500);
    const apiAvailability = await checkApi(controller.signal);
    window.clearTimeout(timeout);
    set({ apiAvailability });
  },
  runLocal: async () => {
    set({ runState: "running", workspaceMode: "run", notice: null });
    try {
      const result = await runLocalSimulation(
        get().scenario,
        get().architecture,
      );
      set({ result, runState: "complete", workspaceMode: "investigate" });
      const sharedScenarioId = get().sharedScenarioId;
      if (
        sharedScenarioId &&
        get().role === "participant" &&
        get().scenario.mode === "interview"
      ) {
        try {
          const shared = await recordSharedScenarioRun(sharedScenarioId);
          const derived = get().scenario.requirements.filter(
            (requirement) =>
              requirement.visibility === "derived" &&
              requirement.owner === "candidate",
          );
          const knownIds = new Set(
            shared.scenario.requirements.map(({ id }) => id),
          );
          set({
            scenario: {
              ...shared.scenario,
              requirements: [
                ...shared.scenario.requirements,
                ...derived.filter(
                  (requirement) => !knownIds.has(requirement.id),
                ),
              ],
            },
            revealState: shared.revealState,
            solverResult: null,
            solverState: "idle",
            solverExecution: null,
          });
          localStorage.setItem(
            "systemforge:draft",
            JSON.stringify({
              scenario: get().scenario,
              architecture: get().architecture,
            }),
          );
          sessionStorage.setItem(
            "systemforge:session",
            JSON.stringify({
              id: sharedScenarioId,
              role: "participant",
              revealState: shared.revealState,
            }),
          );
        } catch {
          set({
            notice:
              "The run completed locally. Canonical interview state is unavailable, so no server-side reveal changed.",
          });
        }
      }
    } catch (error) {
      set({
        runState: "error",
        notice:
          error instanceof Error
            ? error.message
            : "The local simulation failed.",
      });
    }
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
          ? `Canonical solving was unavailable, so this comparison ran locally. ${solved.fallbackReason}`
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
    if (get().apiAvailability !== "online") {
      set({
        notice:
          "Canonical submission is unavailable. Your architecture still runs locally in this browser.",
      });
      return;
    }
    try {
      const receipt = await submitCanonicalRun({
        scenario: get().scenario,
        architecture: get().architecture,
        clientEngineVersion: ENGINE_VERSION,
      });
      set({
        canonicalRunId: receipt.id,
        canonicalRunStatus: "queued",
        canonicalRunDigest: null,
        notice: `Canonical run ${receipt.id.slice(0, 8)} queued. Local work remains available while it runs.`,
      });
      for (let attempt = 0; attempt < 75; attempt += 1) {
        const run = await fetchCanonicalRun(receipt.id);
        set({ canonicalRunStatus: run.status });
        if (run.status === "completed") {
          set({
            canonicalRunDigest: run.digest ?? run.result?.digest ?? null,
            notice: `Canonical run ${receipt.id.slice(0, 8)} completed with engine ${run.result?.engineVersion ?? "unknown"}.`,
          });
          return;
        }
        if (run.status === "failed") {
          set({
            notice: `Canonical run ${receipt.id.slice(0, 8)} failed: ${run.failureMessage ?? run.failureCode ?? "unknown worker failure"}. Local simulation remains available.`,
          });
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
      set({
        notice: `Canonical run ${receipt.id.slice(0, 8)} is still queued. You can keep working locally and check it again later.`,
      });
    } catch (error) {
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
            ? "This browser uses an older simulation engine. Refresh the application before retrying canonical submission; the current architecture still runs locally."
            : retry
              ? `Canonical capacity is busy. Try again in about ${retry} seconds; local simulation remains available.`
              : "The service could not accept this run. Local simulation remains available.",
      });
    }
  },
  dismissNotice: () => set({ notice: null }),
}));
