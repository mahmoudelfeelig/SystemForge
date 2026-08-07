import type {
  Architecture,
  Requirement,
  Scenario,
  SimulationResult,
} from "@systemforge/contracts";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  ENGINE_VERSION,
} from "@systemforge/sim-core";
import { create } from "zustand";
import { checkApi, submitCanonicalRun, type ApiAvailability } from "../lib/api";
import { runLocalSimulation } from "../lib/localSimulation";
import { decodeLocalShare } from "../lib/share";

export type WorkspaceMode = "build" | "run" | "investigate";

interface LabState {
  scenario: Scenario;
  architecture: Architecture;
  result: SimulationResult | null;
  selectedNodeId: string | null;
  selectedEventId: string | null;
  workspaceMode: WorkspaceMode;
  runState: "idle" | "running" | "complete" | "error";
  apiAvailability: ApiAvailability;
  role: "participant" | "interviewer";
  notice: string | null;
  canonicalRunId: string | null;
  hydrate: () => void;
  loadSharedScenario: (
    scenario: Scenario,
    architecture: Architecture,
    role: "participant" | "interviewer",
  ) => void;
  setScenario: (scenario: Scenario) => void;
  setArchitecture: (architecture: Architecture) => void;
  setSelectedNodeId: (id: string | null) => void;
  setSelectedEventId: (id: string | null) => void;
  setWorkspaceMode: (mode: WorkspaceMode) => void;
  updateRequirement: (requirement: Requirement) => void;
  checkService: () => Promise<void>;
  runLocal: () => Promise<void>;
  submitCanonical: () => Promise<void>;
  dismissNotice: () => void;
}

const cloneDefaults = () => ({
  scenario: structuredClone(DEFAULT_SCENARIO),
  architecture: structuredClone(DEFAULT_ARCHITECTURE),
});

export const useLabStore = create<LabState>((set, get) => ({
  ...cloneDefaults(),
  result: null,
  selectedNodeId: "api",
  selectedEventId: null,
  workspaceMode: "build",
  runState: "idle",
  apiAvailability: "checking",
  role: "participant",
  notice: null,
  canonicalRunId: null,
  hydrate: () => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const shared = hash.get("share");
    if (shared) {
      const decoded = decodeLocalShare(shared);
      if (decoded) {
        set({
          scenario: decoded.scenario,
          architecture:
            decoded.architecture ?? structuredClone(DEFAULT_ARCHITECTURE),
          role: decoded.role,
          notice: "Shared scenario loaded locally. No server was required.",
        });
        return;
      }
      set({
        notice:
          "This local share link is invalid or uses an unsupported schema version.",
      });
      return;
    }
    const draft = localStorage.getItem("systemforge:draft");
    if (draft) {
      try {
        const parsed = JSON.parse(draft) as {
          scenario: Scenario;
          architecture?: Architecture;
        };
        set({
          scenario: parsed.scenario,
          architecture:
            parsed.architecture ?? structuredClone(DEFAULT_ARCHITECTURE),
        });
      } catch {
        localStorage.removeItem("systemforge:draft");
      }
    }
  },
  loadSharedScenario: (scenario, architecture, role) => {
    localStorage.setItem(
      "systemforge:draft",
      JSON.stringify({ scenario, architecture }),
    );
    set({
      scenario,
      architecture,
      role,
      result: null,
      runState: "idle",
      notice:
        role === "interviewer"
          ? "Interviewer scenario loaded with private criteria."
          : "Shared scenario loaded. Hidden interviewer criteria remain private.",
    });
  },
  setScenario: (scenario) => set({ scenario, result: null, runState: "idle" }),
  setArchitecture: (architecture) => {
    set({ architecture, result: null, runState: "idle" });
    localStorage.setItem(
      "systemforge:draft",
      JSON.stringify({ scenario: get().scenario, architecture }),
    );
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
    set({ scenario: next });
    localStorage.setItem(
      "systemforge:draft",
      JSON.stringify({ scenario: next, architecture: get().architecture }),
    );
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
        notice: `Canonical run ${receipt.id.slice(0, 8)} queued. Local work remains available while it runs.`,
      });
    } catch (error) {
      const retry =
        typeof error === "object" && error && "retryAfterSeconds" in error
          ? Number(error.retryAfterSeconds)
          : null;
      set({
        apiAvailability: retry ? "busy" : "offline",
        notice: retry
          ? `Canonical capacity is busy. Try again in about ${retry} seconds; local simulation remains available.`
          : "The service could not accept this run. Local simulation remains available.",
      });
    }
  },
  dismissNotice: () => set({ notice: null }),
}));
