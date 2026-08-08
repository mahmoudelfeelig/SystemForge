import type {
  Architecture,
  RunSubmission,
  Scenario,
  SimulationResult,
} from "@systemforge/contracts";

export interface RunRecord {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  result?: SimulationResult;
  digest?: string;
  failureCode?: string;
  failureMessage?: string;
  createdAt: string;
}

export interface SharedScenarioRecord {
  id: string;
  hostToken: string;
  scenario: Scenario;
  architecture: Architecture;
}

export interface SharedScenarioView {
  id: string;
  scenario: Scenario;
  architecture: Architecture;
  isHost: boolean;
  revealState: "hidden" | "revealed";
  collaboration: InterviewCollaborationState;
}

export interface InterviewCollaborationState {
  candidateNotes: string;
  candidateCursor: string;
  startedAt: string | null;
  updatedAt: string;
  interviewerNotes?: string;
}

export interface InterviewCollaborationPatch {
  candidateNotes?: string;
  candidateCursor?: string;
  interviewerNotes?: string;
  clockAction?: "start" | "reset";
}

export class QueueCapacityError extends Error {
  constructor(readonly retryAfterSeconds = 30) {
    super("Canonical simulation capacity is currently full.");
    this.name = "QueueCapacityError";
  }
}

export class SharedScenarioCapacityError extends Error {
  constructor(readonly retryAfterSeconds = 60) {
    super("Canonical scenario storage is currently full.");
    this.name = "SharedScenarioCapacityError";
  }
}

export interface ControlStore {
  ready(): Promise<boolean>;
  queueRun(
    submission: RunSubmission,
    maximumQueued: number,
    maximumStored: number,
  ): Promise<RunRecord>;
  getRun(id: string): Promise<RunRecord | null>;
  shareScenario(
    scenario: Scenario,
    architecture: Architecture,
    maximumShared: number,
  ): Promise<SharedScenarioRecord>;
  getScenario(
    id: string,
    hostToken?: string,
  ): Promise<SharedScenarioView | null>;
  markScenarioRun(id: string): Promise<SharedScenarioView | null>;
  setScenarioReveal(
    id: string,
    hostToken: string,
    revealed: boolean,
  ): Promise<SharedScenarioView | null>;
  updateScenarioCollaboration(
    id: string,
    hostToken: string | undefined,
    patch: InterviewCollaborationPatch,
  ): Promise<SharedScenarioView | null>;
  close(): Promise<void>;
}
