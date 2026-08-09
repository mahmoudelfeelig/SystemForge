// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Architecture,
  Scenario,
  SimulationResult,
} from "@systemforge/contracts";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  simulate,
} from "@systemforge/sim-core";
import type {
  LocalSimulationSession,
  SimulationRunIdentity,
  SimulationSessionSnapshot,
  StartLocalSimulationOptions,
} from "../src/lib/localSimulation";
import {
  createCompletedRunReplayBundle,
  type CompletedRunReplayBundle,
} from "../src/lib/replayBundle";

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

const mocks = vi.hoisted(() => {
  class MockSimulationRunCancelledError extends Error {}
  return {
    startLocalSimulation: vi.fn(),
    fetchSharedScenario: vi.fn(),
    recordSharedScenarioRun: vi.fn(),
    setSharedScenarioReveal: vi.fn(),
    submitCanonicalRun: vi.fn(),
    fetchCanonicalRun: vi.fn(),
    updateInterviewCollaboration: vi.fn(),
    MockSimulationRunCancelledError,
  };
});

vi.mock("../src/lib/localSimulation", () => ({
  startLocalSimulation: mocks.startLocalSimulation,
  SimulationRunCancelledError: mocks.MockSimulationRunCancelledError,
}));

vi.mock("../src/lib/api", () => ({
  checkApi: vi.fn(),
  fetchCanonicalRun: mocks.fetchCanonicalRun,
  fetchSharedScenario: mocks.fetchSharedScenario,
  recordSharedScenarioRun: mocks.recordSharedScenarioRun,
  setSharedScenarioReveal: mocks.setSharedScenarioReveal,
  solveCanonicalArchitecture: vi.fn(),
  submitCanonicalRun: mocks.submitCanonicalRun,
  updateInterviewCollaboration: mocks.updateInterviewCollaboration,
}));

const { useLabStore } = await import("../src/store/useLabStore");

interface PendingRun {
  identity: SimulationRunIdentity;
  options: StartLocalSimulationOptions;
  session: LocalSimulationSession;
  resolve: (result: SimulationResult) => void;
}

const pendingRuns: PendingRun[] = [];

mocks.startLocalSimulation.mockImplementation(
  (
    _scenario: Scenario,
    _architecture: Architecture,
    options: StartLocalSimulationOptions = {},
  ): LocalSimulationSession => {
    const identity = options.identity!;
    let resolve!: (result: SimulationResult) => void;
    const result = new Promise<SimulationResult>((done) => {
      resolve = done;
    });
    const session: LocalSimulationSession = {
      identity,
      state: "starting",
      result,
      cancel: vi.fn(() => {
        options.onStateChange?.("cancelling");
        options.onStateChange?.("cancelled");
      }),
      pause: vi.fn(),
      resume: vi.fn(),
      step: vi.fn(),
      injectIncident: vi.fn(),
      applyIntervention: vi.fn(),
      snapshot: vi.fn(),
      fork: vi.fn(),
      finish: vi.fn(),
      setSpeed: vi.fn(),
    };
    pendingRuns.push({ identity, options, session, resolve });
    return session;
  },
);

const completeRun = (pending: PendingRun, result: SimulationResult) => {
  pending.options.onStateChange?.("complete", {
    type: "complete",
    identity: pending.identity,
    result,
  });
  pending.resolve(result);
};

const expectQueuedCanonicalRunInvalidatedBy = async (
  mutate: () => void | Promise<void>,
) => {
  const runId = "da9e2e66-d41d-46ee-9f96-94ab7a153830";
  let releaseStatus!: (status: {
    id: string;
    status: "completed";
    digest: string;
    result: SimulationResult;
  }) => void;
  mocks.submitCanonicalRun.mockResolvedValue({ id: runId });
  mocks.fetchCanonicalRun.mockImplementation(
    () =>
      new Promise((resolve) => {
        releaseStatus = resolve;
      }),
  );
  useLabStore.setState({ apiAvailability: "online" });

  const submission = useLabStore.getState().submitCanonical();
  await vi.waitFor(() => expect(mocks.fetchCanonicalRun).toHaveBeenCalled());
  await mutate();
  releaseStatus({
    id: runId,
    status: "completed",
    digest: "stale-canonical-digest",
    result: simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE),
  });
  await submission;

  expect(useLabStore.getState()).toMatchObject({
    canonicalRunId: null,
    canonicalRunStatus: "idle",
    canonicalRunDigest: null,
  });
};

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  pendingRuns.length = 0;
  useLabStore.setState({
    scenario: structuredClone(DEFAULT_SCENARIO),
    architecture: structuredClone(DEFAULT_ARCHITECTURE),
    scenarioRevision: 0,
    architectureRevision: 0,
    result: null,
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
    runHistoryIssue: null,
    transientArchitectureUpdate: null,
    apiAvailability: "checking",
    canonicalRunId: null,
    canonicalRunStatus: "idle",
    canonicalRunDigest: null,
    role: "participant",
    sharedScenarioId: null,
    sharedHostToken: null,
    revealState: "hidden",
    notice: null,
  });
});

describe("local run store identity", () => {
  it("adds a candidate-safe completed run to local history", async () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const runPromise = useLabStore.getState().runLocal();
    completeRun(pendingRuns[0]!, result);
    await runPromise;

    expect(useLabStore.getState().runHistory).toEqual([
      expect.objectContaining({
        status: "completed",
        scenario: expect.objectContaining({ id: DEFAULT_SCENARIO.id }),
        metrics: expect.objectContaining({
          objectivesTotal: expect.any(Number),
        }),
      }),
    ]);
  });

  it("does not persist a private interview run in local history", async () => {
    const scenario = structuredClone(DEFAULT_SCENARIO);
    scenario.mode = "interview";
    scenario.interview = {
      candidateBrief: "Design the public checkout path.",
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
    useLabStore.setState({ scenario });

    const runPromise = useLabStore.getState().runLocal();
    completeRun(pendingRuns[0]!, simulate(scenario, DEFAULT_ARCHITECTURE));
    await runPromise;

    expect(useLabStore.getState().runHistory).toEqual([]);
    expect(localStorage.getItem("systemforge:run-history:v1")).toBeNull();
  });

  it("loads a custom scenario without interview privacy language", () => {
    useLabStore
      .getState()
      .loadSharedScenario(
        { ...structuredClone(DEFAULT_SCENARIO), mode: "custom" },
        structuredClone(DEFAULT_ARCHITECTURE),
        "participant",
      );

    expect(useLabStore.getState().notice).toBe("Scenario loaded in the Lab.");
  });

  it("does not persist a host credential unless the server confirms interviewer role", () => {
    const sharedScenarioId = "4fa97132-f1f0-41b8-8657-4966154a2545";
    useLabStore
      .getState()
      .loadSharedScenario(
        structuredClone(DEFAULT_SCENARIO),
        structuredClone(DEFAULT_ARCHITECTURE),
        "participant",
        {
          id: sharedScenarioId,
          hostToken: "0e18d74a-4bef-4757-90e9-fc814b2ce77b",
          revealState: "hidden",
        },
      );

    expect(useLabStore.getState()).toMatchObject({
      role: "participant",
      sharedScenarioId,
      sharedHostToken: null,
    });
    expect(
      JSON.parse(sessionStorage.getItem("systemforge:session") ?? "{}"),
    ).toEqual({
      id: sharedScenarioId,
      role: "participant",
      revealState: "hidden",
    });
  });

  it("aborts an older shared refresh and ignores its late response", async () => {
    const sharedScenarioId = "4fa97132-f1f0-41b8-8657-4966154a2545";
    let releaseFirst!: (value: unknown) => void;
    let releaseSecond!: (value: unknown) => void;
    mocks.fetchSharedScenario
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSecond = resolve;
          }),
      );
    useLabStore.setState({
      scenario: structuredClone(DEFAULT_SCENARIO),
      sharedScenarioId,
      sharedHostToken: null,
      role: "participant",
    });

    const firstRefresh = useLabStore.getState().refreshSharedScenario();
    const firstSignal = mocks.fetchSharedScenario.mock.calls[0]?.[2] as
      AbortSignal | undefined;
    const secondRefresh = useLabStore.getState().refreshSharedScenario();
    const secondSignal = mocks.fetchSharedScenario.mock.calls[1]?.[2] as
      AbortSignal | undefined;

    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal?.aborted).toBe(false);
    releaseSecond({
      id: sharedScenarioId,
      scenario: {
        ...structuredClone(DEFAULT_SCENARIO),
        title: "Latest shared scenario",
      },
      architecture: structuredClone(DEFAULT_ARCHITECTURE),
      role: "participant",
      revealState: "hidden",
      collaboration: {
        candidateNotes: "",
        candidateCursor: "Latest cursor",
        startedAt: null,
        updatedAt: new Date(0).toISOString(),
      },
    });
    await secondRefresh;
    releaseFirst({
      id: sharedScenarioId,
      scenario: {
        ...structuredClone(DEFAULT_SCENARIO),
        title: "Stale shared scenario",
      },
      architecture: structuredClone(DEFAULT_ARCHITECTURE),
      role: "participant",
      revealState: "hidden",
      collaboration: {
        candidateNotes: "",
        candidateCursor: "Stale cursor",
        startedAt: null,
        updatedAt: new Date(0).toISOString(),
      },
    });
    await firstRefresh;

    expect(useLabStore.getState().scenario.title).toBe(
      "Latest shared scenario",
    );
    expect(useLabStore.getState().collaboration.candidateCursor).toBe(
      "Latest cursor",
    );
  });

  it("serializes reveal and collaboration mutations so responses cannot overwrite newer state", async () => {
    const sharedScenarioId = "4fa97132-f1f0-41b8-8657-4966154a2545";
    const hostToken = "0e18d74a-4bef-4757-90e9-fc814b2ce77b";
    let releaseReveal!: (value: unknown) => void;
    let releaseCollaboration!: (value: unknown) => void;
    mocks.setSharedScenarioReveal.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseReveal = resolve;
        }),
    );
    mocks.updateInterviewCollaboration.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCollaboration = resolve;
        }),
    );
    useLabStore.setState({
      sharedScenarioId,
      sharedHostToken: hostToken,
      role: "interviewer",
      revealState: "hidden",
    });

    const reveal = useLabStore.getState().setInterviewReveal(true);
    await vi.waitFor(() =>
      expect(mocks.setSharedScenarioReveal).toHaveBeenCalledOnce(),
    );
    const collaboration = useLabStore
      .getState()
      .updateInterviewCollaboration({ candidateCursor: "Latest cursor" });

    expect(mocks.updateInterviewCollaboration).not.toHaveBeenCalled();
    releaseReveal({
      revealState: "revealed",
      collaboration: {
        candidateNotes: "",
        candidateCursor: "Cursor returned with reveal",
        startedAt: null,
        updatedAt: new Date(0).toISOString(),
      },
    });
    await reveal;
    await vi.waitFor(() =>
      expect(mocks.updateInterviewCollaboration).toHaveBeenCalledOnce(),
    );
    releaseCollaboration({
      collaboration: {
        candidateNotes: "",
        candidateCursor: "Latest cursor",
        startedAt: null,
        updatedAt: new Date(1).toISOString(),
      },
    });
    await collaboration;

    expect(useLabStore.getState()).toMatchObject({
      revealState: "revealed",
      collaboration: { candidateCursor: "Latest cursor" },
    });
  });

  it("cancels a previous session and rejects its late completion", async () => {
    const baseline = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const firstResult = structuredClone(baseline);
    const secondResult = structuredClone(baseline);

    const firstPromise = useLabStore.getState().runLocal();
    const first = pendingRuns[0]!;
    const secondPromise = useLabStore.getState().runLocal();
    const second = pendingRuns[1]!;

    expect(first.session.cancel).toHaveBeenCalledOnce();
    expect(second.identity.runId).not.toBe(first.identity.runId);
    expect(second.identity).toMatchObject({
      scenarioRevision: 0,
      architectureRevision: 0,
      scenarioId: DEFAULT_SCENARIO.id,
      architectureId: DEFAULT_ARCHITECTURE.id,
    });

    completeRun(first, firstResult);
    await firstPromise;
    expect(useLabStore.getState().result).toBeNull();
    expect(useLabStore.getState().localRunSession?.identity).toEqual(
      second.identity,
    );

    completeRun(second, secondResult);
    await secondPromise;
    expect(useLabStore.getState()).toMatchObject({
      result: secondResult,
      runState: "complete",
      localRunSession: {
        identity: second.identity,
        state: "complete",
      },
      completedRunArtifact: {
        manifest: {
          runId: second.identity.runId,
          seed: DEFAULT_SCENARIO.seed,
          boundary: { liveInterventionRecomputed: false },
        },
      },
    });
  });

  it("replays identical captured inputs and verifies the completed digest", async () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const sourcePromise = useLabStore.getState().runLocal();
    completeRun(pendingRuns[0]!, result);
    await sourcePromise;
    const source = useLabStore.getState().completedRunArtifact!;

    useLabStore.getState().setScenario({
      ...structuredClone(DEFAULT_SCENARIO),
      title: "Edited after source run",
    });
    const replayPromise = useLabStore.getState().replayCompletedRun();
    const replay = pendingRuns[1]!;

    expect(useLabStore.getState().scenario).toEqual(source.scenario);
    expect(useLabStore.getState().architecture).toEqual(source.architecture);
    expect(replay.identity.runId).not.toBe(source.manifest.runId);
    completeRun(replay, structuredClone(result));
    await replayPromise;

    expect(useLabStore.getState().completedRunArtifact?.manifest).toMatchObject(
      {
        replay: {
          sourceRunId: source.manifest.runId,
          identicalInputs: true,
          resultDigestMatched: true,
          verified: true,
        },
        actionLog: [
          {
            sequence: 0,
            command: "replay-start",
            sourceRunId: source.manifest.runId,
          },
          { sequence: 1, command: "complete" },
        ],
      },
    );
  });

  it("loads an imported bundle as a candidate-safe replay and verifies its recomputed digest", async () => {
    const action = {
      type: "apply-intervention" as const,
      id: "portable-scale-action",
      atSecond: 8,
      nodeId: "api",
      intervention: { kind: "scale" as const, instances: 12 },
    };
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
      actions: [action],
    });
    const sourcePromise = useLabStore.getState().runLocal();
    useLabStore.setState({ localRunActions: [action] });
    completeRun(pendingRuns[0]!, result);
    await sourcePromise;
    const source = useLabStore.getState().completedRunArtifact!;
    const bundle = await createCompletedRunReplayBundle(
      source,
      testDigestProvider,
    );
    useLabStore.setState({
      role: "interviewer",
      sharedScenarioId: "4fa97132-f1f0-41b8-8657-4966154a2545",
      sharedHostToken: "0e18d74a-4bef-4757-90e9-fc814b2ce77b",
    });
    sessionStorage.setItem(
      "systemforge:session",
      JSON.stringify({ id: "private-session" }),
    );

    const replayIntent = useLabStore.getState().queueImportedReplay(bundle);
    await useLabStore.getState().hydrate();
    await useLabStore
      .getState()
      .consumeQueuedImportedReplay("unrelated-lab-navigation");
    expect(pendingRuns).toHaveLength(1);
    const replayPromise = useLabStore
      .getState()
      .consumeQueuedImportedReplay(replayIntent);
    const replay = pendingRuns[1]!;

    expect(replay.options.actions).toEqual(bundle.inputs.actionSchedule);
    expect(useLabStore.getState()).toMatchObject({
      scenario: bundle.inputs.scenario,
      architecture: bundle.inputs.architecture,
      role: "participant",
      sharedScenarioId: null,
      sharedHostToken: null,
      runState: "running",
    });
    expect(sessionStorage.getItem("systemforge:session")).toBeNull();
    completeRun(
      replay,
      simulate(bundle.inputs.scenario, bundle.inputs.architecture, {
        actions: bundle.inputs.actionSchedule,
      }),
    );
    await replayPromise;

    expect(
      useLabStore.getState().completedRunArtifact?.manifest.replay,
    ).toEqual({
      sourceRunId: source.manifest.runId,
      identicalInputs: true,
      resultDigestMatched: true,
      verified: true,
    });
    expect(localStorage.getItem("systemforge:draft")).not.toContain(
      'interviewerBrief":"Private',
    );
  });

  it("discards an expired imported-replay navigation intent", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const intent = useLabStore
        .getState()
        .queueImportedReplay({} as CompletedRunReplayBundle);
      now.mockReturnValue(61_002);

      await useLabStore.getState().consumeQueuedImportedReplay(intent);

      expect(pendingRuns).toHaveLength(0);
      expect(useLabStore.getState().notice).toBe(
        "The replay transfer expired. Return to Replay and verify the bundle again.",
      );
    } finally {
      now.mockRestore();
    }
  });

  it("refuses an imported replay before worker allocation when engine evidence differs", async () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const sourcePromise = useLabStore.getState().runLocal();
    completeRun(pendingRuns[0]!, result);
    await sourcePromise;
    const bundle = await createCompletedRunReplayBundle(
      useLabStore.getState().completedRunArtifact!,
      testDigestProvider,
    );
    bundle.source.engineVersion = "0.0.0-incompatible";
    pendingRuns.length = 0;

    await useLabStore.getState().replayImportedBundle(bundle);

    expect(pendingRuns).toHaveLength(0);
    expect(useLabStore.getState().notice).toContain("Replay was not started");
    expect(useLabStore.getState().notice).toContain("requires engine");
  });

  it("schedules paused future actions and records replay snapshot, fork, and finish commands", async () => {
    const baseline = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const runPromise = useLabStore.getState().runLocal();
    const pending = pendingRuns[0]!;
    pending.options.onBatch?.({
      type: "batch",
      identity: pending.identity,
      batchIndex: 0,
      frameOffset: 0,
      eventOffset: 0,
      frames: baseline.frames.slice(0, 4),
      events: [],
      deliveredFrames: 4,
      deliveredEvents: 0,
      totalFrames: baseline.frames.length,
      totalEvents: baseline.events.length,
      progress: 4 / baseline.frames.length,
    });
    pending.options.onStateChange?.("paused", {
      type: "paused",
      identity: pending.identity,
    });

    useLabStore.getState().applyLocalIntervention("api", {
      kind: "scale",
      instances: 12,
    });
    const action = vi.mocked(pending.session.applyIntervention).mock
      .calls[0]![0];
    expect(action).toMatchObject({
      type: "apply-intervention",
      atSecond: 4,
      nodeId: "api",
      intervention: { kind: "scale", instances: 12 },
    });
    pending.options.onStateChange?.("paused", {
      type: "action-applied",
      identity: pending.identity,
      action,
      deliveredSecond: 3,
      totalFrames: baseline.frames.length,
      totalEvents: baseline.events.length + 1,
    });
    expect(useLabStore.getState().localRunActions).toEqual([action]);
    expect(useLabStore.getState().localRunActionLog.at(-1)).toMatchObject({
      command: "apply-intervention",
      deliveredSecond: 3,
      action,
    });

    useLabStore.getState().snapshotLocalRun();
    expect(pending.session.snapshot).toHaveBeenCalledOnce();
    useLabStore.getState().forkLocalRunSession();
    expect(pending.session.fork).toHaveBeenCalledWith(
      expect.stringMatching(/^branch-/),
    );
    useLabStore.getState().finishLocalRun();
    expect(pending.session.finish).toHaveBeenCalledOnce();
    expect(useLabStore.getState().localRunActionLog.at(-1)).toMatchObject({
      command: "finish",
      deliveredSecond: 3,
    });

    completeRun(
      pending,
      simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, { actions: [action] }),
    );
    await runPromise;
    expect(
      useLabStore.getState().completedRunArtifact?.manifest.simulationActions,
    ).toEqual([action]);

    const replayPromise = useLabStore.getState().replayCompletedRun();
    const replay = pendingRuns[1]!;
    expect(replay.options.actions).toEqual([action]);
    completeRun(
      replay,
      simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, { actions: [action] }),
    );
    await replayPromise;
    expect(useLabStore.getState().completedRunArtifact?.manifest).toMatchObject(
      {
        simulationActions: [action],
        replay: { verified: true },
      },
    );
  });

  it("opens a captured live fork as a paused deterministic replay with its delivered prefix", async () => {
    const baseline = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const deliveredFrames = baseline.frames.slice(0, 4);
    const deliveredEvents = baseline.events.filter(
      (event) => event.second <= 3,
    );
    const sourcePromise = useLabStore.getState().runLocal();
    const source = pendingRuns[0]!;
    source.options.onBatch?.({
      type: "batch",
      identity: source.identity,
      batchIndex: 0,
      frameOffset: 0,
      eventOffset: 0,
      frames: deliveredFrames,
      events: deliveredEvents,
      deliveredFrames: deliveredFrames.length,
      deliveredEvents: deliveredEvents.length,
      totalFrames: baseline.frames.length,
      totalEvents: baseline.events.length,
      progress: deliveredFrames.length / baseline.frames.length,
    });
    source.options.onStateChange?.("paused", {
      type: "paused",
      identity: source.identity,
    });
    useLabStore.getState().applyLocalIntervention("api", {
      kind: "scale",
      instances: 12,
    });
    const capturedAction = vi.mocked(source.session.applyIntervention).mock
      .calls[0]![0];
    source.options.onStateChange?.("paused", {
      type: "action-applied",
      identity: source.identity,
      action: capturedAction,
      deliveredSecond: 3,
      totalFrames: baseline.frames.length,
      totalEvents: baseline.events.length,
    });
    useLabStore.getState().forkLocalRunSession();
    const forkSnapshot: SimulationSessionSnapshot = {
      version: 1,
      snapshotId: `${source.identity.runId}-fork-branch-1`,
      sourceRunId: source.identity.runId,
      scenario: structuredClone(DEFAULT_SCENARIO),
      architecture: structuredClone(DEFAULT_ARCHITECTURE),
      actions: [capturedAction],
      cursor: {
        nextFrame: deliveredFrames.length,
        nextEvent: deliveredEvents.length,
        batchIndex: 1,
        deliveredSecond: 3,
      },
      prefixFingerprint: "captured-prefix",
      resultFingerprint: "captured-result",
      restoration: "deterministic-replay-from-second-zero",
      opaqueRuntimeStateSerialized: false,
    };
    source.options.onStateChange?.("paused", {
      type: "fork-created",
      identity: source.identity,
      snapshot: forkSnapshot,
      forkKey: "branch-1",
    });

    const forkPromise = useLabStore.getState().openLocalRunFork();
    const fork = pendingRuns[1]!;
    completeRun(
      source,
      simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
        actions: [capturedAction],
      }),
    );

    expect(source.session.cancel).toHaveBeenCalledOnce();
    expect(fork.identity.runId).not.toBe(source.identity.runId);
    expect(fork.options).toMatchObject({ restore: forkSnapshot });
    expect(fork.options.actions).toBeUndefined();
    expect(useLabStore.getState()).toMatchObject({
      runState: "running",
      localRunFrames: deliveredFrames,
      localRunEvents: deliveredEvents,
      localRunActions: [capturedAction],
      localRunForkSnapshot: null,
      localRunSession: {
        deliveredFrames: deliveredFrames.length,
        deliveredEvents: deliveredEvents.length,
      },
    });
    fork.options.onStateChange?.("running", {
      type: "started",
      identity: fork.identity,
      totalFrames: baseline.frames.length,
      totalEvents: baseline.events.length,
      speed: 1,
    });
    fork.options.onStateChange?.("paused", {
      type: "paused",
      identity: fork.identity,
    });
    expect(useLabStore.getState()).toMatchObject({
      localRunSession: { state: "paused" },
      localRunFrames: deliveredFrames,
      localRunEvents: deliveredEvents,
    });
    expect(useLabStore.getState().notice).toContain("Recomputed from t+0");

    useLabStore.getState().injectLocalNodeOutage("api");
    const futureAction = vi.mocked(fork.session.injectIncident).mock
      .calls[0]![0];
    expect(futureAction.atSecond).toBe(4);
    fork.options.onStateChange?.("paused", {
      type: "action-applied",
      identity: fork.identity,
      action: futureAction,
      deliveredSecond: 3,
      totalFrames: baseline.frames.length,
      totalEvents: baseline.events.length + 1,
    });

    completeRun(
      fork,
      simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
        actions: [capturedAction, futureAction],
      }),
    );
    await forkPromise;
    await sourcePromise;
    expect(
      useLabStore.getState().completedRunArtifact?.manifest.simulationActions,
    ).toEqual([capturedAction, futureAction]);
  });

  it("refuses to open a live fork when no captured replay snapshot exists", async () => {
    await useLabStore.getState().openLocalRunFork();

    expect(pendingRuns).toHaveLength(0);
    expect(useLabStore.getState().notice).toContain(
      "Capture a paused local replay fork",
    );
  });

  it("forks static drafts from a delivered second without mutating the source artifact", async () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const sourcePromise = useLabStore.getState().runLocal();
    completeRun(pendingRuns[0]!, result);
    await sourcePromise;
    const source = useLabStore.getState().completedRunArtifact!;

    useLabStore.getState().setCompletedRunSnapshotSecond(12.4);
    expect(
      useLabStore.getState().completedRunArtifact?.manifest.snapshot,
    ).toMatchObject({
      requestedSecond: 12.4,
      deliveredSecond: 12,
      recomputed: false,
    });
    useLabStore.getState().forkCompletedRun(20.6);

    expect(useLabStore.getState()).toMatchObject({
      result: null,
      runState: "idle",
      sharedScenarioId: null,
      completedRunFork: {
        snapshot: { deliveredSecond: 21 },
        provenance: {
          sourceRunId: source.manifest.runId,
          originalRunRecomputed: false,
        },
      },
    });
    expect(useLabStore.getState().scenario.id).not.toBe(source.scenario.id);
    expect(useLabStore.getState().architecture.id).not.toBe(
      source.architecture.id,
    );
    expect(useLabStore.getState().scenario).toEqual(
      useLabStore.getState().completedRunFork?.scenario,
    );
    expect(useLabStore.getState().architecture).toEqual(
      useLabStore.getState().completedRunFork?.architecture,
    );
    expect(source.scenario.id).toBe(DEFAULT_SCENARIO.id);
    expect(source.architecture.id).toBe(DEFAULT_ARCHITECTURE.id);
  });

  it("invalidates and cancels a run when the architecture changes", async () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const runPromise = useLabStore.getState().runLocal();
    const pending = pendingRuns[0]!;

    useLabStore.getState().setArchitecture({
      ...structuredClone(DEFAULT_ARCHITECTURE),
      name: "Changed during run",
    });

    expect(pending.session.cancel).toHaveBeenCalledOnce();
    expect(useLabStore.getState()).toMatchObject({
      architectureRevision: 1,
      result: null,
      runState: "idle",
      localRunSession: null,
    });

    completeRun(pending, result);
    await runPromise;
    expect(useLabStore.getState()).toMatchObject({
      result: null,
      runState: "idle",
      localRunSession: null,
    });
  });

  it("invalidates an active run on a transient architecture update", async () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const runPromise = useLabStore.getState().runLocal();
    const pending = pendingRuns[0]!;
    const dragged = structuredClone(DEFAULT_ARCHITECTURE);
    dragged.nodes[0]!.position.x += 40;

    useLabStore.getState().setArchitectureTransient(dragged);

    expect(pending.session.cancel).toHaveBeenCalledOnce();
    expect(useLabStore.getState()).toMatchObject({
      architecture: dragged,
      architectureRevision: 1,
      result: null,
      runState: "idle",
      localRunSession: null,
      transientArchitectureUpdate: { updateCount: 1 },
    });

    completeRun(pending, result);
    await runPromise;
    expect(useLabStore.getState()).toMatchObject({
      result: null,
      runState: "idle",
      localRunSession: null,
    });
  });

  it("does not treat a local run as server-verified interview evidence", async () => {
    const interview = {
      ...structuredClone(DEFAULT_SCENARIO),
      mode: "interview" as const,
      interview: {
        candidateBrief: "Design the service.",
        interviewerBrief: "",
        timeboxMinutes: 45,
        allowCandidateRequirements: true,
        revealPolicy: "after-run" as const,
      },
    };
    useLabStore.setState({
      scenario: interview,
      sharedScenarioId: "4fa97132-f1f0-41b8-8657-4966154a2545",
      role: "participant",
    });
    const runPromise = useLabStore.getState().runLocal();
    const pending = pendingRuns[0]!;
    completeRun(
      pending,
      simulate(interview, structuredClone(DEFAULT_ARCHITECTURE)),
    );
    await runPromise;

    expect(mocks.recordSharedScenarioRun).not.toHaveBeenCalled();
    expect(useLabStore.getState().revealState).toBe("hidden");
  });

  it("records only a completed canonical run and preserves candidate-derived requirements", async () => {
    const sharedScenarioId = "4fa97132-f1f0-41b8-8657-4966154a2545";
    const runId = "7b4237d9-901f-4be3-88c7-d602e9f40f5d";
    const derived = {
      ...structuredClone(DEFAULT_SCENARIO.requirements[0]!),
      id: "candidate-derived",
      label: "Candidate-derived latency target",
      visibility: "derived" as const,
      owner: "candidate" as const,
    };
    const interview = {
      ...structuredClone(DEFAULT_SCENARIO),
      mode: "interview" as const,
      requirements: [
        ...structuredClone(DEFAULT_SCENARIO.requirements),
        derived,
      ],
      interview: {
        candidateBrief: "Design the service.",
        interviewerBrief: "",
        timeboxMinutes: 45,
        allowCandidateRequirements: true,
        revealPolicy: "after-run" as const,
      },
    };
    const revealedScenario = {
      ...structuredClone(interview),
      requirements: [
        ...structuredClone(DEFAULT_SCENARIO.requirements),
        {
          ...structuredClone(DEFAULT_SCENARIO.requirements[0]!),
          id: "private-criterion",
          label: "Private criterion",
          visibility: "public" as const,
          owner: "interviewer" as const,
        },
      ],
    };
    const result = simulate(interview, DEFAULT_ARCHITECTURE);
    mocks.submitCanonicalRun.mockResolvedValue({ id: runId });
    mocks.fetchCanonicalRun.mockResolvedValue({
      id: runId,
      status: "completed",
      digest: "canonical-digest",
      result,
    });
    mocks.recordSharedScenarioRun.mockResolvedValue({
      scenario: revealedScenario,
      revealState: "revealed",
    });
    useLabStore.setState({
      apiAvailability: "online",
      scenario: interview,
      sharedScenarioId,
      role: "participant",
    });

    await useLabStore.getState().submitCanonical();

    expect(mocks.submitCanonicalRun).toHaveBeenCalledWith(
      expect.objectContaining({ sharedScenarioId }),
    );
    expect(mocks.recordSharedScenarioRun).toHaveBeenCalledWith(
      sharedScenarioId,
      runId,
    );
    expect(useLabStore.getState()).toMatchObject({
      canonicalRunId: runId,
      canonicalRunStatus: "completed",
      canonicalRunDigest: "canonical-digest",
      revealState: "revealed",
    });
    expect(
      useLabStore
        .getState()
        .scenario.requirements.some(({ id }) => id === derived.id),
    ).toBe(true);
  });

  it("omits share binding for non-shared and interviewer canonical runs", async () => {
    const runId = "7b4237d9-901f-4be3-88c7-d602e9f40f5d";
    mocks.submitCanonicalRun.mockResolvedValue({ id: runId });
    mocks.fetchCanonicalRun.mockResolvedValue({
      id: runId,
      status: "completed",
      result: simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE),
    });
    useLabStore.setState({
      apiAvailability: "online",
      scenario: structuredClone(DEFAULT_SCENARIO),
      sharedScenarioId: null,
      role: "participant",
    });

    await useLabStore.getState().submitCanonical();

    expect(mocks.submitCanonicalRun.mock.calls[0]?.[0]).not.toHaveProperty(
      "sharedScenarioId",
    );
    mocks.submitCanonicalRun.mockClear();
    mocks.fetchCanonicalRun.mockClear();
    const interview = {
      ...structuredClone(DEFAULT_SCENARIO),
      mode: "interview" as const,
      interview: {
        candidateBrief: "Design the service.",
        interviewerBrief: "Private rubric.",
        timeboxMinutes: 45,
        allowCandidateRequirements: true,
        revealPolicy: "after-run" as const,
      },
    };
    mocks.submitCanonicalRun.mockResolvedValue({ id: runId });
    mocks.fetchCanonicalRun.mockResolvedValue({
      id: runId,
      status: "completed",
      result: simulate(interview, DEFAULT_ARCHITECTURE),
    });
    useLabStore.setState({
      scenario: interview,
      sharedScenarioId: "4fa97132-f1f0-41b8-8657-4966154a2545",
      role: "interviewer",
      canonicalRunId: null,
      canonicalRunStatus: "idle",
    });

    await useLabStore.getState().submitCanonical();

    expect(mocks.submitCanonicalRun.mock.calls[0]?.[0]).not.toHaveProperty(
      "sharedScenarioId",
    );
    expect(mocks.recordSharedScenarioRun).not.toHaveBeenCalled();
  });

  it("does not apply a canonical interview reveal after the session revision changes", async () => {
    let releaseReveal!: (value: unknown) => void;
    mocks.recordSharedScenarioRun.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseReveal = resolve;
        }),
    );
    const sharedScenarioId = "4fa97132-f1f0-41b8-8657-4966154a2545";
    const runId = "7b4237d9-901f-4be3-88c7-d602e9f40f5d";
    const interview = {
      ...structuredClone(DEFAULT_SCENARIO),
      mode: "interview" as const,
      interview: {
        candidateBrief: "Design the service.",
        interviewerBrief: "",
        timeboxMinutes: 45,
        allowCandidateRequirements: true,
        revealPolicy: "after-run" as const,
      },
    };
    mocks.submitCanonicalRun.mockResolvedValue({ id: runId });
    mocks.fetchCanonicalRun.mockResolvedValue({
      id: runId,
      status: "completed",
      result: simulate(interview, DEFAULT_ARCHITECTURE),
    });
    useLabStore.setState({
      apiAvailability: "online",
      scenario: interview,
      sharedScenarioId,
      role: "participant",
    });
    const submitPromise = useLabStore.getState().submitCanonical();
    await vi.waitFor(() =>
      expect(mocks.recordSharedScenarioRun).toHaveBeenCalledWith(
        sharedScenarioId,
        runId,
      ),
    );

    useLabStore.getState().setScenario({
      ...interview,
      title: "Edited after canonical completion",
    });
    releaseReveal({
      scenario: { ...interview, title: "Stale server reveal" },
      revealState: "revealed",
    });
    await submitPromise;

    expect(useLabStore.getState()).toMatchObject({
      revealState: "hidden",
      scenario: { title: "Edited after canonical completion" },
      result: null,
      runState: "idle",
    });
  });

  it("invalidates queued canonical evidence after a requirement edit", async () => {
    await expectQueuedCanonicalRunInvalidatedBy(() => {
      useLabStore.getState().updateRequirement({
        ...structuredClone(DEFAULT_SCENARIO.requirements[0]!),
        label: "Edited while the canonical run was queued",
      });
    });
  });

  it("invalidates queued canonical evidence after an architecture undo or redo", async () => {
    const baseline = structuredClone(DEFAULT_ARCHITECTURE);
    const edited = structuredClone(DEFAULT_ARCHITECTURE);
    edited.nodes.find((node) => node.id === "api")!.config.instances += 1;
    useLabStore.setState({
      architecture: edited,
      architectureUndo: [baseline],
      architectureRedo: [],
    });
    await expectQueuedCanonicalRunInvalidatedBy(() => {
      useLabStore.getState().undoArchitecture();
    });

    useLabStore.setState({
      architecture: baseline,
      architectureUndo: [],
      architectureRedo: [edited],
    });
    await expectQueuedCanonicalRunInvalidatedBy(() => {
      useLabStore.getState().redoArchitecture();
    });
  });

  it("invalidates queued canonical evidence when a transient edit is discarded", async () => {
    const baseline = structuredClone(DEFAULT_ARCHITECTURE);
    const transient = structuredClone(DEFAULT_ARCHITECTURE);
    transient.nodes.find((node) => node.id === "api")!.position.x += 40;
    useLabStore.setState({
      architecture: transient,
      transientArchitectureUpdate: {
        baseArchitecture: baseline,
        updateCount: 1,
      },
    });

    await expectQueuedCanonicalRunInvalidatedBy(() => {
      useLabStore.getState().cancelArchitectureTransient();
    });
  });

  it("invalidates queued canonical evidence after a shared scenario refresh", async () => {
    const sharedScenarioId = "4fa97132-f1f0-41b8-8657-4966154a2545";
    useLabStore.setState({ sharedScenarioId });
    mocks.fetchSharedScenario.mockResolvedValue({
      id: sharedScenarioId,
      scenario: {
        ...structuredClone(DEFAULT_SCENARIO),
        title: "Refreshed while the canonical run was queued",
      },
      architecture: structuredClone(DEFAULT_ARCHITECTURE),
      role: "participant",
      revealState: "hidden",
      collaboration: {
        candidateNotes: "",
        candidateCursor: "Reviewing the refreshed brief",
        startedAt: null,
        updatedAt: new Date(0).toISOString(),
      },
    });

    await expectQueuedCanonicalRunInvalidatedBy(() =>
      useLabStore.getState().refreshSharedScenario(),
    );
  });
});
