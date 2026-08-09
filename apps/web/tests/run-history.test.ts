// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Scenario } from "@systemforge/contracts";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  simulate,
} from "@systemforge/sim-core";
import {
  appendCompletedRunAction,
  createCompletedRunArtifact,
} from "../src/lib/completedRun";
import {
  addLocalRunHistoryRecord,
  compareLocalRunHistory,
  createCompletedRunHistoryRecord,
  createTerminalRunHistoryRecord,
  downloadLocalRunHistoryRecord,
  loadLocalRunHistory,
  MAX_LOCAL_RUN_HISTORY_ENTRIES,
  setLocalRunHistoryBackendForTests,
  updateLocalRunHistoryRecord,
  verifyLocalRunHistoryReplay,
  type LocalRunHistoryRecord,
} from "../src/lib/runHistory";

const testDigestProvider: Pick<SubtleCrypto, "digest"> = {
  digest: (_algorithm, data) => {
    const input = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    const output = new Uint8Array(32);
    for (const [index, byte] of input.entries())
      output[index % output.length] =
        (output[index % output.length]! * 33 + byte + index) & 0xff;
    return Promise.resolve(output.buffer);
  },
};

let stored: unknown[] = [];
const memoryBackend = {
  read: () => Promise.resolve(structuredClone(stored)),
  write: (records: readonly LocalRunHistoryRecord[]) => {
    stored = structuredClone([...records]);
    return Promise.resolve();
  },
  clear: () => {
    stored = [];
    return Promise.resolve();
  },
};

const createArtifact = async (runId: string, scenario = DEFAULT_SCENARIO) => {
  const result = simulate(scenario, DEFAULT_ARCHITECTURE);
  return createCompletedRunArtifact({
    identity: {
      runId,
      scenarioId: scenario.id,
      architectureId: DEFAULT_ARCHITECTURE.id,
      scenarioRevision: 2,
      architectureRevision: 3,
    },
    scenario,
    architecture: DEFAULT_ARCHITECTURE,
    result,
    actionLog: appendCompletedRunAction([], "start", null),
    digestProvider: null,
  });
};

const terminalRecord = (runId: string, finishedAt = new Date().toISOString()) =>
  createTerminalRunHistoryRecord({
    identity: {
      runId,
      scenarioRevision: 1,
      architectureRevision: 1,
    },
    status: "failed",
    startedAt: finishedAt,
    finishedAt,
    scenario: DEFAULT_SCENARIO,
    architecture: DEFAULT_ARCHITECTURE,
    actionCount: 0,
  })!;

beforeEach(() => {
  stored = [];
  setLocalRunHistoryBackendForTests(memoryBackend);
});

afterEach(() => {
  setLocalRunHistoryBackendForTests(null);
  vi.restoreAllMocks();
});

describe("local Run history", () => {
  it("stores and verifies a candidate-safe replay bundle", async () => {
    const artifact = await createArtifact("history-complete");
    const record = await createCompletedRunHistoryRecord(artifact, {
      digestProvider: testDigestProvider,
    });

    expect(record).toMatchObject({
      status: "completed",
      replayState: "available",
      repeatCount: 1,
      determinismWarning: false,
    });
    expect(record?.replayInputDigest).toMatch(/^[0-9a-f]+$/);
    await addLocalRunHistoryRecord(record!);

    const loaded = await loadLocalRunHistory();
    expect(loaded.records).toHaveLength(1);
    await expect(
      verifyLocalRunHistoryReplay(loaded.records[0]!, testDigestProvider),
    ).resolves.toMatchObject({
      privacyScope: "candidate-safe",
      source: { runId: "history-complete" },
    });
  });

  it("excludes private interview runs and their terminal states", async () => {
    const scenario: Scenario = structuredClone(DEFAULT_SCENARIO);
    scenario.mode = "interview";
    scenario.interview = {
      candidateBrief: "Design the checkout path.",
      interviewerBrief: "PRIVATE INTERVIEWER SENTINEL",
      timeboxMinutes: 45,
      allowCandidateRequirements: true,
      revealPolicy: "never",
    };
    scenario.requirements.push({
      ...scenario.requirements[0]!,
      id: "private-rubric",
      label: "PRIVATE HIDDEN CRITERION",
      visibility: "hidden",
      owner: "interviewer",
    });

    await expect(
      createCompletedRunHistoryRecord(
        await createArtifact("private-complete", scenario),
        { digestProvider: testDigestProvider },
      ),
    ).resolves.toBeNull();
    expect(
      createTerminalRunHistoryRecord({
        identity: {
          runId: "private-failed",
          scenarioRevision: 1,
          architectureRevision: 1,
        },
        status: "failed",
        startedAt: new Date().toISOString(),
        scenario,
        architecture: DEFAULT_ARCHITECTURE,
        actionCount: 0,
      }),
    ).toBeNull();
    expect(JSON.stringify(stored)).not.toContain("PRIVATE");
  });

  it("deduplicates identical outputs and flags divergent deterministic outputs", async () => {
    const first = await createCompletedRunHistoryRecord(
      await createArtifact("repeat-one"),
      { digestProvider: testDigestProvider },
    );
    const second = await createCompletedRunHistoryRecord(
      await createArtifact("repeat-two"),
      { digestProvider: testDigestProvider },
    );
    await addLocalRunHistoryRecord(first!);
    let result = await addLocalRunHistoryRecord(second!);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.repeatCount).toBe(2);

    const divergent = {
      ...second!,
      id: "repeat-divergent",
      runId: "repeat-divergent",
      resultDigest: {
        ...second!.resultDigest!,
        value: `${second!.resultDigest!.value}-different`,
      },
    };
    result = await addLocalRunHistoryRecord(divergent);
    expect(result.records).toHaveLength(2);
    expect(result.records.every((record) => record.determinismWarning)).toBe(
      true,
    );
  });

  it("expires old unstarred records and enforces entry and baseline caps", async () => {
    const old = terminalRecord("old", "2020-01-01T00:00:00.000Z");
    await addLocalRunHistoryRecord(old);
    expect((await loadLocalRunHistory()).records).toHaveLength(0);

    for (let index = 0; index < MAX_LOCAL_RUN_HISTORY_ENTRIES + 3; index += 1)
      await addLocalRunHistoryRecord(terminalRecord(`run-${index}`));
    let result = await loadLocalRunHistory();
    expect(result.records).toHaveLength(MAX_LOCAL_RUN_HISTORY_ENTRIES);

    for (const record of result.records.slice(0, 6))
      await updateLocalRunHistoryRecord(record.id, { starred: true });
    result = await loadLocalRunHistory();
    await expect(
      updateLocalRunHistoryRecord(result.records[6]!.id, { starred: true }),
    ).rejects.toThrow("At most 6 run baselines");
  });

  it("never clears valid records when retention cleanup cannot commit", async () => {
    const old = terminalRecord("old-preserved", "2020-01-01T00:00:00.000Z");
    stored = [old];
    let clearCalls = 0;
    setLocalRunHistoryBackendForTests({
      read: () => Promise.resolve(structuredClone(stored)),
      write: () => Promise.reject(new Error("transient IndexedDB abort")),
      clear: () => {
        clearCalls += 1;
        stored = [];
        return Promise.resolve();
      },
    });

    const result = await loadLocalRunHistory();

    expect(result.records).toEqual([]);
    expect(result.issue).toContain("cleanup could not be saved");
    expect(clearCalls).toBe(0);
    expect(stored).toEqual([old]);
  });

  it("rejects a tampered retained replay before replay or download", async () => {
    const record = await createCompletedRunHistoryRecord(
      await createArtifact("tampered-history"),
      { digestProvider: testDigestProvider },
    );
    const bundle = JSON.parse(record!.replayBundle!) as {
      inputs: { scenario: { title: string } };
    };
    bundle.inputs.scenario.title = "Tampered title";
    const tampered = {
      ...record!,
      replayBundle: JSON.stringify(bundle),
      replayBytes: new TextEncoder().encode(JSON.stringify(bundle)).byteLength,
    };

    await expect(
      verifyLocalRunHistoryReplay(tampered, testDigestProvider),
    ).rejects.toThrow();
    await expect(downloadLocalRunHistoryRecord(tampered)).rejects.toThrow();
  });

  it("compares exact modeled deltas and rejects cross-engine comparisons", async () => {
    const source = await createCompletedRunHistoryRecord(
      await createArtifact("compare-source"),
      { digestProvider: testDigestProvider },
    );
    const comparison = structuredClone(source!);
    comparison.id = "compare-target";
    comparison.runId = "compare-target";
    comparison.metrics!.p95LatencyMs += 10;

    expect(compareLocalRunHistory(source!, comparison)).toMatchObject({
      compatible: true,
      sameInputs: true,
      objectivesComparable: true,
      objectivePassRateDeltaPercent: 0,
      metricDeltas: { p95LatencyMs: 10 },
    });
    const changedObjective = JSON.parse(source!.objectiveSignatures[0]!) as [
      string,
      string,
      string,
      number,
      string,
    ];
    changedObjective[3] = changedObjective[3] / 10;
    comparison.objectiveSignatures = [
      JSON.stringify(changedObjective),
      ...source!.objectiveSignatures.slice(1),
    ].sort();
    comparison.metrics!.objectivesPassed = 2;
    comparison.metrics!.objectivesTotal = 100;
    expect(compareLocalRunHistory(source!, comparison)).toMatchObject({
      compatible: true,
      objectivesComparable: false,
      objectivePassRateDeltaPercent: null,
    });
    comparison.engineVersion = "different-engine";
    expect(compareLocalRunHistory(source!, comparison)).toMatchObject({
      compatible: false,
      metricDeltas: null,
    });
  });
});
