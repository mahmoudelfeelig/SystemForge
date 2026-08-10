import { randomUUID } from "node:crypto";
import type {
  Architecture,
  RunSubmission,
  Scenario,
} from "@systemforge/contracts";
import {
  AiUsageBudgetExceededError,
  QueueCapacityError,
  SharedScenarioCapacityError,
  type ControlStore,
  type AiUsageBudgetState,
  type AiUsageReservation,
  type InterviewCollaborationPatch,
  type RunRecord,
  type SharedScenarioRecord,
  type SharedScenarioView,
} from "./store";

export class MemoryControlStore implements ControlStore {
  readonly runs = new Map<string, RunRecord>();
  readonly runSubmissions = new Map<string, RunSubmission>();
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
  readonly aiUsageReservations: Array<{
    createdAt: Date;
    reservedCostCents: number;
  }> = [];

  ready(): Promise<boolean> {
    return Promise.resolve(this.available);
  }

  async reserveAiUsage(
    reservation: AiUsageReservation,
  ): Promise<AiUsageBudgetState> {
    await Promise.resolve();
    const now = new Date();
    const dayStart = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const dailyRequests = this.aiUsageReservations.filter(
      (entry) => entry.createdAt.getTime() >= dayStart,
    ).length;
    const monthlyReservedCostCents = this.aiUsageReservations
      .filter((entry) => entry.createdAt.getTime() >= monthStart)
      .reduce((total, entry) => total + entry.reservedCostCents, 0);
    const monthlyRequests = this.aiUsageReservations.filter(
      (entry) => entry.createdAt.getTime() >= monthStart,
    ).length;
    const monthlyCostExceeded =
      reservation.maximumMonthlyCostCents !== undefined &&
      monthlyReservedCostCents + reservation.reservedCostCents >
        reservation.maximumMonthlyCostCents;
    if (
      dailyRequests >= reservation.maximumDailyRequests ||
      monthlyRequests >= reservation.maximumMonthlyRequests ||
      monthlyCostExceeded
    ) {
      const nextDay = dayStart + 86_400_000;
      const nextMonth = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() + 1,
        1,
      );
      throw new AiUsageBudgetExceededError(
        Math.max(
          1,
          Math.ceil(
            ((dailyRequests >= reservation.maximumDailyRequests
              ? nextDay
              : nextMonth) -
              now.getTime()) /
              1_000,
          ),
        ),
      );
    }
    this.aiUsageReservations.push({
      createdAt: now,
      reservedCostCents: reservation.reservedCostCents,
    });
    return {
      dailyRequests: dailyRequests + 1,
      monthlyRequests: monthlyRequests + 1,
      monthlyReservedCostCents:
        monthlyReservedCostCents + reservation.reservedCostCents,
    };
  }

  queueRun(
    submission: RunSubmission,
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
      if (oldest) {
        this.runs.delete(oldest.id);
        this.runSubmissions.delete(oldest.id);
      }
    }
    if (this.runs.size >= maximumStored) throw new QueueCapacityError();
    const run: RunRecord = {
      id: randomUUID(),
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    this.runs.set(run.id, run);
    this.runSubmissions.set(run.id, structuredClone(submission));
    return Promise.resolve(run);
  }

  getRun(id: string): Promise<RunRecord | null> {
    return Promise.resolve(this.runs.get(id) ?? null);
  }

  getRunSubmission(id: string): Promise<RunSubmission | null> {
    const submission = this.runSubmissions.get(id);
    return Promise.resolve(submission ? structuredClone(submission) : null);
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
