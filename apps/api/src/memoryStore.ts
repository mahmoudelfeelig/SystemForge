import { randomUUID } from "node:crypto";
import type {
  Architecture,
  RunSubmission,
  Scenario,
} from "@systemforge/contracts";
import {
  QueueCapacityError,
  type ControlStore,
  type RunRecord,
  type SharedScenarioRecord,
} from "./store";

export class MemoryControlStore implements ControlStore {
  readonly runs = new Map<string, RunRecord>();
  readonly scenarios = new Map<string, SharedScenarioRecord>();
  available = true;

  ready(): Promise<boolean> {
    return Promise.resolve(this.available);
  }

  queueRun(
    _submission: RunSubmission,
    maximumQueued: number,
  ): Promise<RunRecord> {
    const queued = [...this.runs.values()].filter(
      (run) => run.status === "queued" || run.status === "running",
    ).length;
    if (queued >= maximumQueued) throw new QueueCapacityError();
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
  ): Promise<SharedScenarioRecord> {
    const record = {
      id: randomUUID(),
      hostToken: randomUUID(),
      scenario,
      architecture,
    };
    this.scenarios.set(record.id, record);
    return Promise.resolve(record);
  }

  getScenario(id: string): Promise<SharedScenarioRecord | null> {
    return Promise.resolve(this.scenarios.get(id) ?? null);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
