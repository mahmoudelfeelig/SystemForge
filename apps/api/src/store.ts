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

export class QueueCapacityError extends Error {
  constructor(readonly retryAfterSeconds = 30) {
    super("Canonical simulation capacity is currently full.");
    this.name = "QueueCapacityError";
  }
}

export interface ControlStore {
  ready(): Promise<boolean>;
  queueRun(
    submission: RunSubmission,
    maximumQueued: number,
  ): Promise<RunRecord>;
  getRun(id: string): Promise<RunRecord | null>;
  shareScenario(
    scenario: Scenario,
    architecture: Architecture,
  ): Promise<SharedScenarioRecord>;
  getScenario(id: string): Promise<SharedScenarioRecord | null>;
  close(): Promise<void>;
}
