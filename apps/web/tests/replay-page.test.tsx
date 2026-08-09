// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  ENGINE_VERSION,
  resolveBehavioralProfileEvidence,
} from "@systemforge/sim-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ReplayPage } from "../src/pages/ReplayPage";
import type {
  CompletedRunReplayBundle,
  CompletedRunReplayCompatibility,
} from "../src/lib/replayBundle";
import type * as ReplayBundleModule from "../src/lib/replayBundle";
import type {
  ReplayComparisonSession,
  SynchronizedReplayComparisonResult,
} from "../src/lib/replayComparison";
import type * as ReplayComparisonModule from "../src/lib/replayComparison";
import { useLabStore } from "../src/store/useLabStore";

const mocks = vi.hoisted(() => ({
  assessCompatibility: vi.fn(),
  compareBundles: vi.fn(),
  queueImportedReplay: vi.fn(),
  readBundle: vi.fn(),
  startComparison: vi.fn(),
}));

vi.mock("../src/lib/replayBundle", async (importOriginal) => ({
  ...(await importOriginal<typeof ReplayBundleModule>()),
  assessCompletedRunReplayCompatibility: mocks.assessCompatibility,
  compareCompletedRunReplayBundles: mocks.compareBundles,
  readCompletedRunReplayBundleFile: mocks.readBundle,
}));

vi.mock("../src/lib/replayComparison", async (importOriginal) => ({
  ...(await importOriginal<typeof ReplayComparisonModule>()),
  startSynchronizedReplayComparison: mocks.startComparison,
}));

const originalQueueImportedReplay = useLabStore.getState().queueImportedReplay;

const LabReplayTarget = () => {
  const location = useLocation();
  const intent =
    typeof location.state === "object" &&
    location.state !== null &&
    "importedReplayIntent" in location.state
      ? String(location.state.importedReplayIntent)
      : "missing";
  return <p>Lab replay target {intent}</p>;
};

const compatible: CompletedRunReplayCompatibility = {
  compatible: true,
  engineVersionMatched: true,
  behavioralProfilesMatched: true,
  currentEngineVersion: ENGINE_VERSION,
  issues: [],
};

const replayBundle = (runId: string): CompletedRunReplayBundle => ({
  replayBundleVersion: 1,
  kind: "systemforge.completed-run-replay",
  privacyScope: "candidate-safe",
  source: {
    runId,
    manifestVersion: 3,
    engineVersion: ENGINE_VERSION,
    seed: DEFAULT_SCENARIO.seed,
    scenario: {
      id: DEFAULT_SCENARIO.id,
      schemaVersion: DEFAULT_SCENARIO.schemaVersion,
      revision: 2,
    },
    architecture: {
      id: DEFAULT_ARCHITECTURE.id,
      schemaVersion: DEFAULT_ARCHITECTURE.schemaVersion,
      revision: 4,
    },
    resultDigest: {
      algorithm: "fnv1a64-result-json-v1",
      value: `${runId}-result-digest`,
      source: "browser-fallback",
    },
  },
  inputs: {
    scenario: structuredClone(DEFAULT_SCENARIO),
    architecture: structuredClone(DEFAULT_ARCHITECTURE),
    actionSchedule: [],
  },
  modelEvidence: {
    behavioralProfiles: resolveBehavioralProfileEvidence(DEFAULT_ARCHITECTURE),
    output: "deterministic-modeled-run",
    restoration: "deterministic-replay-from-second-zero",
    opaqueRuntimeStateSerialized: false,
  },
  integrity: {
    inputDigest: {
      algorithm: "sha256-canonical-json-v1",
      value: "a".repeat(64),
    },
    actionScheduleDigest: {
      algorithm: "sha256-canonical-json-v1",
      value: "b".repeat(64),
    },
    payloadDigest: {
      algorithm: "sha256-canonical-json-v1",
      value: "c".repeat(64),
    },
  },
});

const renderReplayPage = () =>
  render(
    <MemoryRouter initialEntries={["/replay"]}>
      <Routes>
        <Route path="/replay" element={<ReplayPage />} />
        <Route path="/lab" element={<LabReplayTarget />} />
      </Routes>
    </MemoryRouter>,
  );

const selectFile = (input: HTMLElement, name: string) => {
  fireEvent.change(input, {
    target: {
      files: [new File(["{}"], name, { type: "application/json" })],
    },
  });
};

beforeEach(() => {
  mocks.assessCompatibility.mockReset();
  mocks.compareBundles.mockReset();
  mocks.readBundle.mockReset();
  mocks.queueImportedReplay.mockClear();
  mocks.queueImportedReplay.mockReturnValue("replay-intent-1");
  mocks.startComparison.mockReset();
  useLabStore.setState({
    queueImportedReplay: mocks.queueImportedReplay,
  });
});

afterEach(() => {
  cleanup();
  useLabStore.setState({
    queueImportedReplay: originalQueueImportedReplay,
  });
});

describe("completed-run replay page", () => {
  it("loads a verified local bundle and starts its replay in the Lab", async () => {
    const bundle = replayBundle("source-run");
    mocks.readBundle.mockResolvedValueOnce(bundle);
    mocks.assessCompatibility.mockReturnValueOnce(compatible);

    renderReplayPage();
    selectFile(
      screen.getByLabelText(/Choose a replay bundle/i),
      "source-replay.json",
    );

    expect(
      await screen.findByText("Bundle checks passed for this model build"),
    ).toBeTruthy();
    expect(screen.getByText("source-run")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Verify and replay/i,
      }),
    );

    expect(mocks.queueImportedReplay).toHaveBeenCalledWith(bundle);
    expect(
      await screen.findByText("Lab replay target replay-intent-1"),
    ).toBeTruthy();
  });

  it("refuses an engine or profile mismatch before the replay action", async () => {
    mocks.readBundle.mockResolvedValueOnce(replayBundle("old-run"));
    mocks.assessCompatibility.mockReturnValueOnce({
      ...compatible,
      compatible: false,
      engineVersionMatched: false,
      issues: ["This bundle requires a different engine version."],
    });

    renderReplayPage();
    selectFile(
      screen.getByLabelText(/Choose a replay bundle/i),
      "old-replay.json",
    );

    expect(
      await screen.findByText("Bundle is not compatible with this model build"),
    ).toBeTruthy();
    expect(
      screen.getByText("This bundle requires a different engine version."),
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: /Verify and replay/i,
      }).disabled,
    ).toBe(true);
    expect(mocks.queueImportedReplay).not.toHaveBeenCalled();
  });

  it("explains why a manifest-only file cannot be replayed", async () => {
    mocks.readBundle.mockRejectedValueOnce(
      new Error(
        "Completed-run manifest files are evidence only and cannot be replayed.",
      ),
    );

    renderReplayPage();
    selectFile(
      screen.getByLabelText(/Choose a replay bundle/i),
      "manifest.json",
    );

    expect(await screen.findByText("Bundle rejected")).toBeTruthy();
    expect(
      screen.getByText(
        "Completed-run manifest files are evidence only and cannot be replayed.",
      ),
    ).toBeTruthy();
  });

  it("keeps a synchronized comparison alive across progress renders", async () => {
    const source = replayBundle("source-run");
    const comparison = replayBundle("comparison-run");
    mocks.readBundle
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(comparison);
    mocks.assessCompatibility.mockReturnValue(compatible);
    mocks.compareBundles.mockReturnValue({
      sourceRunId: "source-run",
      comparisonRunId: "comparison-run",
      inputDigestMatched: true,
      actionScheduleMatched: true,
      sameDeterministicInputs: true,
      runtimeStateCompared: false,
    });
    let finish!: (result: SynchronizedReplayComparisonResult) => void;
    const result = new Promise<SynchronizedReplayComparisonResult>(
      (resolve) => {
        finish = resolve;
      },
    );
    const cancel = vi.fn();
    let reportProgress:
      | ((progress: {
          completedBranches: number;
          totalBranches: number;
          progress: number;
        }) => void)
      | undefined;
    mocks.startComparison.mockImplementation(
      (_source, _comparison, options): ReplayComparisonSession => {
        reportProgress = options.onProgress;
        return {
          requestId: options.requestId,
          state: "running",
          result,
          cancel,
        };
      },
    );

    renderReplayPage();
    selectFile(screen.getByLabelText(/Choose a replay bundle/i), "source.json");
    await screen.findByText("Bundle checks passed for this model build");
    selectFile(
      screen.getByLabelText(/Select comparison bundle/i),
      "comparison.json",
    );
    await screen.findByText(/This preflight compares inputs and actions only/i);

    fireEvent.click(
      screen.getByRole("button", {
        name: /Run comparison/i,
      }),
    );
    act(() =>
      reportProgress?.({
        completedBranches: 1,
        totalBranches: 2,
        progress: 0.5,
      }),
    );
    await waitFor(() => expect(cancel).not.toHaveBeenCalled());
    const comparisonRegion = screen.getByRole("region", {
      name: "Compare two runs",
    });
    const comparisonStatus = screen.getByRole("status", {
      name: "Replay comparison status",
    });
    expect(comparisonRegion.getAttribute("aria-busy")).toBe("true");
    expect(comparisonStatus.textContent).toContain(
      "Replay comparison running. 50 percent complete.",
    );

    const output: SynchronizedReplayComparisonResult = {
      comparisonVersion: 1,
      source: {
        runId: "source-run",
        sourceResultDigest: source.source.resultDigest,
        recomputedResultDigest: source.source.resultDigest,
        resultDigestMatched: true,
        passedObjectives: 2,
        totalObjectives: 2,
      },
      comparison: {
        runId: "comparison-run",
        sourceResultDigest: comparison.source.resultDigest,
        recomputedResultDigest: comparison.source.resultDigest,
        resultDigestMatched: true,
        passedObjectives: 2,
        totalObjectives: 2,
      },
      timeline: {
        alignedFrameCount: 61,
        firstModeledSecond: 0,
        lastModeledSecond: 60,
      },
      metrics: {
        objectivePassRatePercentage: {
          source: 100,
          comparison: 100,
          delta: 0,
          aggregation: "completed-run-objective-pass-rate",
        },
        p95LatencyMs: {
          source: 40,
          comparison: 35,
          delta: -5,
          aggregation: "maximum-aligned-frame",
        },
        errorRatePercentagePoints: {
          source: 1,
          comparison: 0.5,
          delta: -0.5,
          aggregation: "maximum-aligned-frame",
        },
        availabilityPercentagePoints: {
          source: 99,
          comparison: 99.5,
          delta: 0.5,
          aggregation: "minimum-aligned-frame",
        },
        monthlyCostEur: {
          source: 100,
          comparison: 120,
          delta: 20,
          aggregation: "maximum-aligned-frame",
        },
      },
      verified: true,
      workUnits: 1_000,
      boundary: {
        execution: "two-fresh-deterministic-recomputations",
        alignment: "modeled-second",
        opaqueRuntimeStateRestored: false,
        productionTelemetryCompared: false,
      },
    };
    act(() => finish(output));

    expect(
      await screen.findByText("Both recomputations match their source digests"),
    ).toBeTruthy();
    expect(
      screen.getByText(/61 frames aligned from second 0 through 60/),
    ).toBeTruthy();
    expect(comparisonRegion.getAttribute("aria-busy")).toBe("false");
    expect(comparisonStatus.textContent).toContain(
      "Replay comparison complete. Source replay digest matched. Comparison replay digest matched.",
    );
    expect(cancel).not.toHaveBeenCalled();
  });
});
