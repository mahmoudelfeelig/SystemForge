// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { Scenario, SimulationAction } from "@systemforge/contracts";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  simulate,
} from "@systemforge/sim-core";
import {
  appendCompletedRunAction,
  createCompletedRunArtifact,
  type CompletedRunArtifact,
} from "../src/lib/completedRun";
import {
  buildCompletedRunReplayBundleExport,
  compareCompletedRunReplayBundles,
  createCompletedRunReplayBundle,
  assessCompletedRunReplayCompatibility,
  MAX_COMPLETED_RUN_REPLAY_BUNDLE_BYTES,
  parseCompletedRunReplayBundle,
  readCompletedRunReplayBundleFile,
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

const createArtifact = async (
  runId: string,
  options: {
    scenario?: Scenario;
    actions?: SimulationAction[];
    architectureName?: string;
  } = {},
): Promise<CompletedRunArtifact> => {
  const scenario = options.scenario ?? structuredClone(DEFAULT_SCENARIO);
  const architecture = {
    ...structuredClone(DEFAULT_ARCHITECTURE),
    ...(options.architectureName ? { name: options.architectureName } : {}),
  };
  const actions = options.actions ?? [];
  const result = simulate(scenario, architecture, {
    ...(actions.length > 0 ? { actions } : {}),
  });
  return createCompletedRunArtifact({
    identity: {
      runId,
      scenarioId: scenario.id,
      architectureId: architecture.id,
      scenarioRevision: 4,
      architectureRevision: 7,
    },
    scenario,
    architecture,
    result,
    actionLog: appendCompletedRunAction([], "start", null),
    simulationActions: actions,
    digestProvider: null,
  });
};

const privateInterviewScenario = (): Scenario => {
  const scenario = structuredClone(DEFAULT_SCENARIO);
  scenario.mode = "interview";
  scenario.interview = {
    candidateBrief: "Design the public checkout path.",
    interviewerBrief: "PRIVATE INTERVIEWER ANALYSIS",
    timeboxMinutes: 45,
    allowCandidateRequirements: true,
    revealPolicy: "never",
  };
  scenario.requirements = [
    {
      ...scenario.requirements[0]!,
      id: "public-latency",
      visibility: "public",
      owner: "scenario",
    },
    {
      ...scenario.requirements[0]!,
      id: "hidden-rubric",
      label: "PRIVATE HIDDEN RUBRIC",
      visibility: "hidden",
      owner: "interviewer",
    },
  ];
  return scenario;
};

describe("completed-run replay bundles", () => {
  it("round-trips the minimum deterministic inputs and model evidence", async () => {
    const action: SimulationAction = {
      type: "apply-intervention",
      id: "scale-api-at-8",
      atSecond: 8,
      nodeId: "api",
      intervention: { kind: "scale", instances: 12 },
    };
    const artifact = await createArtifact("portable-run", {
      actions: [action],
    });

    const serialized = await buildCompletedRunReplayBundleExport(
      artifact,
      testDigestProvider,
    );
    const imported = await parseCompletedRunReplayBundle(
      serialized,
      testDigestProvider,
    );

    expect(imported).toMatchObject({
      replayBundleVersion: 1,
      kind: "systemforge.completed-run-replay",
      privacyScope: "candidate-safe",
      source: {
        runId: "portable-run",
        engineVersion: artifact.manifest.engineVersion,
        resultDigest: artifact.manifest.resultDigest,
      },
      inputs: {
        scenario: { id: DEFAULT_SCENARIO.id },
        architecture: { id: DEFAULT_ARCHITECTURE.id },
        actionSchedule: [action],
      },
      modelEvidence: {
        behavioralProfiles: artifact.manifest.behavioralProfiles,
        output: "deterministic-modeled-run",
        restoration: "deterministic-replay-from-second-zero",
        opaqueRuntimeStateSerialized: false,
      },
    });
    expect(imported).not.toHaveProperty("result");
    expect(imported).not.toHaveProperty("manifest.snapshot");
  });

  it("fails closed instead of exporting a private interviewer run", async () => {
    const artifact = await createArtifact("private-interview-run", {
      scenario: privateInterviewScenario(),
      actions: [
        {
          type: "inject-incident",
          id: "private-action",
          atSecond: 4,
          incident: {
            id: "private-incident",
            kind: "node-failure",
            label: "PRIVATE INTERVIEWER ANALYSIS",
            magnitude: 1,
            targetId: "api",
          },
        },
      ],
    });

    await expect(
      buildCompletedRunReplayBundleExport(artifact, testDigestProvider),
    ).rejects.toMatchObject({
      code: "private-content",
      message: expect.stringContaining("Private interviewer runs"),
    });
  });

  it("rejects manifest-only evidence with a non-replayable explanation", async () => {
    await expect(
      parseCompletedRunReplayBundle(
        JSON.stringify({
          manifestExportVersion: 1,
          privacyScope: "completed-run-manifest-only",
          sourceRetention: "browser-session",
          manifest: {},
        }),
        null,
      ),
    ).rejects.toMatchObject({
      code: "manifest-only",
      message: expect.stringContaining("evidence only"),
    });
  });

  it("rejects unsupported, private, and modified bundles", async () => {
    const artifact = await createArtifact("strict-import");
    const serialized = await buildCompletedRunReplayBundleExport(
      artifact,
      testDigestProvider,
    );
    const unsupported = JSON.parse(serialized) as Record<string, unknown>;
    unsupported.replayBundleVersion = 99;
    await expect(
      parseCompletedRunReplayBundle(
        JSON.stringify(unsupported),
        testDigestProvider,
      ),
    ).rejects.toMatchObject({ code: "unsupported-version" });

    const privateBundle = JSON.parse(serialized) as {
      inputs: { scenario: Scenario };
    };
    privateBundle.inputs.scenario = privateInterviewScenario();
    await expect(
      parseCompletedRunReplayBundle(
        JSON.stringify(privateBundle),
        testDigestProvider,
      ),
    ).rejects.toMatchObject({ code: "private-content" });

    const modified = JSON.parse(serialized) as {
      inputs: { scenario: Scenario };
    };
    modified.inputs.scenario.title = "Modified after export";
    await expect(
      parseCompletedRunReplayBundle(
        JSON.stringify(modified),
        testDigestProvider,
      ),
    ).rejects.toMatchObject({ code: "integrity-mismatch" });

    const addedUnknownField = JSON.parse(serialized) as {
      inputs: { scenario: Record<string, unknown> };
    };
    addedUnknownField.inputs.scenario.unexpectedPrivateField =
      "Content added after export";
    await expect(
      parseCompletedRunReplayBundle(
        JSON.stringify(addedUnknownField),
        testDigestProvider,
      ),
    ).rejects.toMatchObject({ code: "integrity-mismatch" });
  });

  it("rejects an oversized file before reading it", async () => {
    const text = vi.fn(() => Promise.resolve("{}"));

    await expect(
      readCompletedRunReplayBundleFile(
        {
          size: MAX_COMPLETED_RUN_REPLAY_BUNDLE_BYTES + 1,
          text,
        },
        null,
      ),
    ).rejects.toMatchObject({ code: "too-large" });
    expect(text).not.toHaveBeenCalled();
  });

  it("compares static input digests and action schedules without runtime claims", async () => {
    const source = await createCompletedRunReplayBundle(
      await createArtifact("source-branch"),
      testDigestProvider,
    );
    const identical = await createCompletedRunReplayBundle(
      await createArtifact("identical-branch"),
      testDigestProvider,
    );
    const action: SimulationAction = {
      type: "inject-incident",
      id: "branch-outage",
      atSecond: 4,
      incident: {
        id: "branch-outage-incident",
        kind: "node-failure",
        label: "Branch-only outage",
        magnitude: 1,
        targetId: "api",
      },
    };
    const changedSchedule = await createCompletedRunReplayBundle(
      await createArtifact("changed-schedule", { actions: [action] }),
      testDigestProvider,
    );
    const changedInputs = await createCompletedRunReplayBundle(
      await createArtifact("changed-inputs", {
        architectureName: "Changed branch architecture",
      }),
      testDigestProvider,
    );

    expect(compareCompletedRunReplayBundles(source, identical)).toEqual({
      sourceRunId: "source-branch",
      comparisonRunId: "identical-branch",
      inputDigestMatched: true,
      actionScheduleMatched: true,
      sameDeterministicInputs: true,
      runtimeStateCompared: false,
    });
    expect(
      compareCompletedRunReplayBundles(source, changedSchedule),
    ).toMatchObject({
      inputDigestMatched: true,
      actionScheduleMatched: false,
      sameDeterministicInputs: false,
      runtimeStateCompared: false,
    });
    expect(
      compareCompletedRunReplayBundles(source, changedInputs),
    ).toMatchObject({
      inputDigestMatched: false,
      actionScheduleMatched: true,
      sameDeterministicInputs: false,
      runtimeStateCompared: false,
    });
  });

  it("fails compatibility when the engine or current profile evidence differs", async () => {
    const source = await createCompletedRunReplayBundle(
      await createArtifact("compatibility-source"),
      testDigestProvider,
    );

    expect(assessCompletedRunReplayCompatibility(source)).toMatchObject({
      compatible: true,
      engineVersionMatched: true,
      behavioralProfilesMatched: true,
    });

    const wrongEngine = structuredClone(source);
    wrongEngine.source.engineVersion = "0.0.0-older";
    expect(assessCompletedRunReplayCompatibility(wrongEngine)).toMatchObject({
      compatible: false,
      engineVersionMatched: false,
      behavioralProfilesMatched: true,
    });

    const wrongProfileEvidence = structuredClone(source);
    const firstResolved =
      wrongProfileEvidence.modelEvidence.behavioralProfiles.find(
        (entry) => entry.status === "resolved",
      );
    if (firstResolved) firstResolved.assumptions = ["Different assumption"];
    else
      wrongProfileEvidence.modelEvidence.behavioralProfiles[0]!.nodeId =
        "different-node";
    expect(
      assessCompletedRunReplayCompatibility(wrongProfileEvidence),
    ).toMatchObject({
      compatible: false,
      engineVersionMatched: true,
      behavioralProfilesMatched: false,
    });
  });
});
