// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  applyBehavioralProfile,
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  simulate,
} from "@systemforge/sim-core";
import {
  appendCompletedRunAction,
  createCompletedRunArtifact,
  digestCompletedRunResult,
  forkCompletedRunAtSecond,
  snapshotCompletedRunAtSecond,
  withCompletedRunSnapshot,
} from "../src/lib/completedRun";
import { buildCompletedRunManifestExport } from "../src/lib/evidenceReport";
import type { SimulationAction } from "@systemforge/contracts";
import type { SimulationRunIdentity } from "../src/lib/localSimulation";

const identity = (runId: string): SimulationRunIdentity => ({
  runId,
  scenarioRevision: 4,
  architectureRevision: 9,
  scenarioId: DEFAULT_SCENARIO.id,
  architectureId: DEFAULT_ARCHITECTURE.id,
});

describe("completed run evidence", () => {
  it("builds a deterministic manifest from completed modeled output", async () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const actionLog = appendCompletedRunAction([], "start", null, {
      value: 1,
    });
    const completedLog = appendCompletedRunAction(
      actionLog,
      "complete",
      result.frames.at(-1)!.second,
    );

    const first = await createCompletedRunArtifact({
      identity: identity("run-one"),
      scenario: DEFAULT_SCENARIO,
      architecture: DEFAULT_ARCHITECTURE,
      result,
      actionLog: completedLog,
      snapshotSecond: 10,
      digestProvider: null,
    });
    const second = await createCompletedRunArtifact({
      identity: identity("run-one"),
      scenario: DEFAULT_SCENARIO,
      architecture: DEFAULT_ARCHITECTURE,
      result,
      actionLog: completedLog,
      snapshotSecond: 10,
      digestProvider: null,
    });

    expect(second.manifest).toEqual(first.manifest);
    expect(first.manifest).toMatchObject({
      manifestVersion: 3,
      runId: "run-one",
      engineVersion: result.engineVersion,
      scenario: {
        id: DEFAULT_SCENARIO.id,
        revision: 4,
      },
      architecture: {
        id: DEFAULT_ARCHITECTURE.id,
        revision: 9,
      },
      seed: DEFAULT_SCENARIO.seed,
      behavioralProfiles: result.behavioralProfiles,
      resultDigest: {
        algorithm: "fnv1a64-result-json-v1",
        source: "browser-fallback",
      },
      snapshot: {
        requestedSecond: 10,
        deliveredSecond: 10,
        source: "completed-modeled-output",
        recomputed: false,
      },
      simulationActions: [],
      boundary: {
        liveInterventionRecomputed: false,
        sessionRestoration: "deterministic-replay-from-second-zero",
        opaqueRuntimeStateSerialized: false,
      },
    });
    expect(first.manifest.actionLog.map((entry) => entry.sequence)).toEqual([
      0, 1,
    ]);
  });

  it("retains resolved profile assumptions, provenance, and overrides in every manifest", async () => {
    const architecture = structuredClone(DEFAULT_ARCHITECTURE);
    const database = architecture.nodes.find((node) => node.id === "db")!;
    const profiled = applyBehavioralProfile(
      database,
      "aws.rds-postgresql.db-r7g-large",
      1,
    );
    profiled.config.behavior = {
      ...profiled.config.behavior,
      storage: {
        ...profiled.config.behavior?.storage,
        readIops: 24_000,
      },
    };
    architecture.nodes = architecture.nodes.map((node) =>
      node.id === profiled.id ? profiled : node,
    );
    const result = simulate(DEFAULT_SCENARIO, architecture);
    const artifact = await createCompletedRunArtifact({
      identity: {
        ...identity("profile-evidence"),
        architectureId: architecture.id,
      },
      scenario: DEFAULT_SCENARIO,
      architecture,
      result,
      actionLog: appendCompletedRunAction([], "start", null),
      digestProvider: null,
    });

    expect(artifact.manifest.behavioralProfiles).toEqual(
      result.behavioralProfiles,
    );
    expect(
      artifact.manifest.behavioralProfiles.find(
        (entry) => entry.nodeId === "db",
      ),
    ).toMatchObject({
      status: "resolved",
      profileId: "aws.rds-postgresql.db-r7g-large",
      profileVersion: 1,
      localOverrides: true,
      overriddenFields: ["config.behavior.storage.readIops"],
      assumptions: expect.arrayContaining([expect.any(String)]),
      provenance: expect.arrayContaining([
        expect.objectContaining({ publisher: "Amazon Web Services" }),
      ]),
    });
  });

  it("rejects stale or forged profile evidence before manifest creation", async () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    result.behavioralProfiles = result.behavioralProfiles.slice(1);

    await expect(
      createCompletedRunArtifact({
        identity: identity("stale-profile-evidence"),
        scenario: DEFAULT_SCENARIO,
        architecture: DEFAULT_ARCHITECTURE,
        result,
        actionLog: appendCompletedRunAction([], "start", null),
        digestProvider: null,
      }),
    ).rejects.toThrow(
      "Completed run behavioral-profile evidence does not match its architecture input.",
    );
  });

  it("rejects modeled output produced from different deterministic inputs", async () => {
    const differentScenario = structuredClone(DEFAULT_SCENARIO);
    differentScenario.workload.baseRps = 1;
    differentScenario.workload.peakRps = 1;
    const staleResult = simulate(differentScenario, DEFAULT_ARCHITECTURE);

    await expect(
      createCompletedRunArtifact({
        identity: identity("stale-input-result"),
        scenario: DEFAULT_SCENARIO,
        architecture: DEFAULT_ARCHITECTURE,
        result: staleResult,
        actionLog: appendCompletedRunAction([], "start", null),
        digestProvider: null,
      }),
    ).rejects.toThrow(
      "Completed run result does not match its deterministic simulation inputs.",
    );

    staleResult.inputFingerprint = simulate(
      DEFAULT_SCENARIO,
      DEFAULT_ARCHITECTURE,
    ).inputFingerprint;
    await expect(
      createCompletedRunArtifact({
        identity: identity("forged-input-fingerprint"),
        scenario: DEFAULT_SCENARIO,
        architecture: DEFAULT_ARCHITECTURE,
        result: staleResult,
        actionLog: appendCompletedRunAction([], "start", null),
        digestProvider: null,
      }),
    ).rejects.toThrow(
      "Completed run output failed deterministic input-result verification.",
    );
  });

  it("persists full intervention payloads and binds replay evidence to the schedule", async () => {
    const action: SimulationAction = {
      type: "apply-intervention",
      id: "scale-api-at-5",
      atSecond: 5,
      nodeId: "api",
      intervention: { kind: "scale", instances: 12 },
    };
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
      actions: [action],
    });
    const actionLog = appendCompletedRunAction(
      appendCompletedRunAction([], "start", null),
      "apply-intervention",
      3,
      { action },
    );
    const source = await createCompletedRunArtifact({
      identity: identity("action-source"),
      scenario: DEFAULT_SCENARIO,
      architecture: DEFAULT_ARCHITECTURE,
      result,
      actionLog,
      simulationActions: [action],
      digestProvider: null,
    });
    const replay = await createCompletedRunArtifact({
      identity: identity("action-replay"),
      scenario: structuredClone(DEFAULT_SCENARIO),
      architecture: structuredClone(DEFAULT_ARCHITECTURE),
      result: structuredClone(result),
      actionLog: appendCompletedRunAction([], "replay-start", null, {
        sourceRunId: source.manifest.runId,
      }),
      simulationActions: [structuredClone(action)],
      replayOf: source,
      digestProvider: null,
    });
    expect(source.manifest.actionLog[1]?.action).toEqual(action);
    expect(source.manifest.simulationActions).toEqual([action]);
    expect(source.manifest.boundary.liveInterventionRecomputed).toBe(true);
    expect(replay.manifest.replay?.verified).toBe(true);
    await expect(
      createCompletedRunArtifact({
        identity: identity("action-replay-wrong"),
        scenario: structuredClone(DEFAULT_SCENARIO),
        architecture: structuredClone(DEFAULT_ARCHITECTURE),
        result: structuredClone(result),
        actionLog: appendCompletedRunAction([], "replay-start", null, {
          sourceRunId: source.manifest.runId,
        }),
        simulationActions: [],
        replayOf: source,
        digestProvider: null,
      }),
    ).rejects.toThrow(
      "Completed run result does not match its deterministic simulation inputs.",
    );
  });

  it("binds the digest to result content and preserves a reported digest", async () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const changed = structuredClone(result);
    changed.frames[0]!.throughputRps += 1;

    const originalDigest = await digestCompletedRunResult(result, null);
    const changedDigest = await digestCompletedRunResult(changed, null);
    const reported = await digestCompletedRunResult(
      { ...result, digest: "reported-digest" },
      null,
    );

    expect(changedDigest.value).not.toBe(originalDigest.value);
    expect(reported).toEqual({
      algorithm: "reported-result-digest",
      value: "reported-digest",
      source: "result",
    });
  });

  it("selects an actual delivered frame without claiming recomputation", () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);

    const snapshot = snapshotCompletedRunAtSecond(result, 10.4);

    expect(snapshot).toMatchObject({
      requestedSecond: 10.4,
      deliveredSecond: 10,
      selection: "nearest-delivered-frame",
      recomputed: false,
    });
    expect(snapshot.frame).toEqual(result.frames[10]);
    expect(snapshot.events.every((event) => event.second === 10)).toBe(true);
  });

  it("verifies identical replay output and creates a post-run input fork", async () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const source = await createCompletedRunArtifact({
      identity: identity("source-run"),
      scenario: DEFAULT_SCENARIO,
      architecture: DEFAULT_ARCHITECTURE,
      result,
      actionLog: appendCompletedRunAction([], "start", null),
      digestProvider: null,
    });
    const replay = await createCompletedRunArtifact({
      identity: identity("replay-run"),
      scenario: structuredClone(DEFAULT_SCENARIO),
      architecture: structuredClone(DEFAULT_ARCHITECTURE),
      result: structuredClone(result),
      actionLog: appendCompletedRunAction([], "replay-start", null, {
        sourceRunId: source.manifest.runId,
      }),
      replayOf: source,
      digestProvider: null,
    });
    const selected = withCompletedRunSnapshot(source, 20);
    const fork = forkCompletedRunAtSecond(selected, 20.6, "branch-a");

    expect(replay.manifest.replay).toEqual({
      sourceRunId: "source-run",
      identicalInputs: true,
      resultDigestMatched: true,
      verified: true,
    });
    expect(fork.scenario.id).not.toBe(DEFAULT_SCENARIO.id);
    expect(fork.architecture.id).not.toBe(DEFAULT_ARCHITECTURE.id);
    expect(fork.snapshot.deliveredSecond).toBe(21);
    expect(fork.provenance).toMatchObject({
      kind: "post-run-static-input-fork",
      sourceRunId: "source-run",
      originalRunRecomputed: false,
    });
    expect(DEFAULT_SCENARIO.id).toBe(source.scenario.id);
    expect(DEFAULT_ARCHITECTURE.id).toBe(source.architecture.id);
  });

  it("exports only the serializable manifest without private interview content", async () => {
    const scenario = structuredClone(DEFAULT_SCENARIO);
    scenario.mode = "interview";
    scenario.interview = {
      candidateBrief: "Design the service.",
      interviewerBrief: "PRIVATE-INTERVIEWER-BRIEF",
      timeboxMinutes: 45,
      allowCandidateRequirements: true,
      revealPolicy: "never",
    };
    scenario.requirements[0] = {
      ...scenario.requirements[0]!,
      label: "PRIVATE-RUBRIC-REQUIREMENT",
      visibility: "hidden",
      owner: "interviewer",
    };
    const artifact = await createCompletedRunArtifact({
      identity: {
        ...identity("private-source"),
        scenarioId: scenario.id,
      },
      scenario,
      architecture: DEFAULT_ARCHITECTURE,
      result: simulate(scenario, DEFAULT_ARCHITECTURE),
      actionLog: appendCompletedRunAction([], "start", null),
      digestProvider: null,
    });

    const exported = buildCompletedRunManifestExport(artifact);
    const parsed = JSON.parse(exported) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      manifestExportVersion: 1,
      privacyScope: "completed-run-manifest-only",
      sourceRetention: "browser-session",
      replayable: false,
      replayBoundary: "evidence-only-no-deterministic-inputs",
      manifest: { runId: "private-source" },
    });
    expect(exported).not.toContain("PRIVATE-INTERVIEWER-BRIEF");
    expect(exported).not.toContain("PRIVATE-RUBRIC-REQUIREMENT");
  });
});
