import { randomUUID } from "node:crypto";
import type {
  Architecture,
  RunSubmission,
  Scenario,
} from "@systemforge/contracts";
import {
  QueueCapacityError,
  SharedScenarioCapacityError,
  type ControlStore,
  type InterviewCollaborationPatch,
  type RunRecord,
  type SharedScenarioRecord,
  type SharedScenarioView,
} from "./store";

export class MemoryControlStore implements ControlStore {
  readonly runs = new Map<string, RunRecord>();
  readonly scenarios = new Map<string, SharedScenarioRecord>();
  readonly scenarioState = new Map<
    string,
    {
      candidateRevealed: boolean;
      firstRunAt: string | null;
      candidateNotes: string;
      candidateCursor: string;
      interviewerNotes: string;
      sessionStartedAt: string | null;
      updatedAt: string;
    }
  >();
  available = true;

  ready(): Promise<boolean> {
    return Promise.resolve(this.available);
  }

  queueRun(
    _submission: RunSubmission,
    maximumQueued: number,
    maximumStored: number,
  ): Promise<RunRecord> {
    const queued = [...this.runs.values()].filter(
      (run) => run.status === "queued" || run.status === "running",
    ).length;
    if (queued >= maximumQueued) throw new QueueCapacityError();
    const terminal = [...this.runs.values()]
      .filter((run) => run.status === "completed" || run.status === "failed")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    while (this.runs.size >= maximumStored && terminal.length > 0) {
      const oldest = terminal.shift();
      if (oldest) this.runs.delete(oldest.id);
    }
    if (this.runs.size >= maximumStored) throw new QueueCapacityError();
    const run: RunRecord = {
      id: randomUUID(),
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    this.runs.set(run.id, run);
    return Promise.resolve(run);
  }

  getRun(id: string): Promise<RunRecord | null> {
    return Promise.resolve(this.runs.get(id) ?? null);
  }

  shareScenario(
    scenario: Scenario,
    architecture: Architecture,
    maximumShared: number,
  ): Promise<SharedScenarioRecord> {
    if (this.scenarios.size >= maximumShared)
      throw new SharedScenarioCapacityError();
    const record = {
      id: randomUUID(),
      hostToken: randomUUID(),
      scenario,
      architecture,
    };
    this.scenarios.set(record.id, record);
    this.scenarioState.set(record.id, {
      candidateRevealed: false,
      firstRunAt: null,
      candidateNotes: "",
      candidateCursor: "Preparing workspace",
      interviewerNotes: "",
      sessionStartedAt: null,
      updatedAt: new Date().toISOString(),
    });
    return Promise.resolve(record);
  }

  getScenario(
    id: string,
    hostToken?: string,
  ): Promise<SharedScenarioView | null> {
    const record = this.scenarios.get(id);
    const state = this.scenarioState.get(id);
    const revealed = record ? this.#isRevealed(record.scenario, state) : false;
    return Promise.resolve(
      record
        ? {
            id: record.id,
            scenario: record.scenario,
            architecture: record.architecture,
            isHost: hostToken === record.hostToken,
            revealState: revealed ? "revealed" : "hidden",
            collaboration: {
              candidateNotes: state?.candidateNotes ?? "",
              candidateCursor: state?.candidateCursor ?? "Preparing workspace",
              startedAt: state?.sessionStartedAt ?? null,
              updatedAt: state?.updatedAt ?? new Date(0).toISOString(),
              ...(hostToken === record.hostToken
                ? { interviewerNotes: state?.interviewerNotes ?? "" }
                : {}),
            },
          }
        : null,
    );
  }

  markScenarioRun(id: string): Promise<SharedScenarioView | null> {
    const record = this.scenarios.get(id);
    const state = this.scenarioState.get(id);
    if (!record || !state) return Promise.resolve(null);
    state.firstRunAt ??= new Date().toISOString();
    return this.getScenario(id);
  }

  setScenarioReveal(
    id: string,
    hostToken: string,
    revealed: boolean,
  ): Promise<SharedScenarioView | null> {
    const record = this.scenarios.get(id);
    const state = this.scenarioState.get(id);
    if (!record || !state || hostToken !== record.hostToken)
      return Promise.resolve(null);
    state.candidateRevealed = revealed;
    return this.getScenario(id, hostToken);
  }

  updateScenarioCollaboration(
    id: string,
    hostToken: string | undefined,
    patch: InterviewCollaborationPatch,
  ): Promise<SharedScenarioView | null> {
    const record = this.scenarios.get(id);
    const state = this.scenarioState.get(id);
    if (!record || !state) return Promise.resolve(null);
    const isHost = hostToken === record.hostToken;
    if (
      (patch.interviewerNotes !== undefined ||
        patch.clockAction !== undefined) &&
      !isHost
    )
      return Promise.resolve(null);
    if (patch.candidateNotes !== undefined)
      state.candidateNotes = patch.candidateNotes;
    if (patch.candidateCursor !== undefined)
      state.candidateCursor = patch.candidateCursor;
    if (patch.interviewerNotes !== undefined)
      state.interviewerNotes = patch.interviewerNotes;
    if (patch.clockAction === "start")
      state.sessionStartedAt = new Date().toISOString();
    if (patch.clockAction === "reset") state.sessionStartedAt = null;
    state.updatedAt = new Date().toISOString();
    return this.getScenario(id, hostToken);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  #isRevealed(
    scenario: Scenario,
    state?: { candidateRevealed: boolean; firstRunAt: string | null },
  ): boolean {
    if (scenario.mode !== "interview" || !scenario.interview || !state)
      return false;
    if (scenario.interview.revealPolicy === "after-run")
      return state.firstRunAt !== null;
    if (scenario.interview.revealPolicy === "interviewer-controlled")
      return state.candidateRevealed;
    return false;
  }
}
