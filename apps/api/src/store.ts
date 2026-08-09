import type {
  AiAssistantProviderEvidence,
  Architecture,
  RunSubmission,
  Scenario,
  SimulationResult,
} from "@systemforge/contracts";

export interface AiUsageReservation {
  providerId: AiAssistantProviderEvidence["id"];
  model: string;
  reservedCostCents: number;
  maximumDailyRequests: number;
  maximumMonthlyCostCents: number;
}

export interface AiUsageBudgetState {
  dailyRequests: number;
  monthlyReservedCostCents: number;
}

export class AiUsageBudgetExceededError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("The bounded AI assistance budget is exhausted.");
    this.name = "AiUsageBudgetExceededError";
  }
}

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
  reserveAiUsage(reservation: AiUsageReservation): Promise<AiUsageBudgetState>;
  queueRun(
    submission: RunSubmission,
    maximumQueued: number,
    maximumStored: number,
  ): Promise<RunRecord>;
  getRun(id: string): Promise<RunRecord | null>;
  getRunSubmission(id: string): Promise<RunSubmission | null>;
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
