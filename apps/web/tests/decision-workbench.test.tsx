// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  simulate,
} from "@systemforge/sim-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionWorkbench } from "../src/components/DecisionWorkbench";
import {
  appendCompletedRunAction,
  createCompletedRunArtifact,
  forkCompletedRunAtSecond,
  type CompletedRunArtifact,
} from "../src/lib/completedRun";
import { useLabStore } from "../src/store/useLabStore";

const originalReplayCompletedRun = useLabStore.getState().replayCompletedRun;
const originalForkCompletedRun = useLabStore.getState().forkCompletedRun;

const completedArtifact = async (): Promise<CompletedRunArtifact> => {
  const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
  const started = appendCompletedRunAction([], "start", null, { value: 1 });
  return createCompletedRunArtifact({
    identity: {
      runId: "ui-completed-run",
      scenarioRevision: 3,
      architectureRevision: 7,
      scenarioId: DEFAULT_SCENARIO.id,
      architectureId: DEFAULT_ARCHITECTURE.id,
    },
    scenario: DEFAULT_SCENARIO,
    architecture: DEFAULT_ARCHITECTURE,
    result,
    actionLog: appendCompletedRunAction(started, "complete", 12),
    snapshotSecond: 12,
    digestProvider: null,
  });
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  useLabStore.setState({
    scenario: structuredClone(DEFAULT_SCENARIO),
    architecture: structuredClone(DEFAULT_ARCHITECTURE),
    scenarioRevision: 0,
    architectureRevision: 0,
    result: null,
    runState: "idle",
    completedRunArtifact: null,
    completedRunFork: null,
    runHistory: [],
    runHistoryUsedBytes: 0,
    runHistoryIssue: null,
    architectureSnapshots: [],
    architectureUndo: [],
    architectureRedo: [],
    role: "participant",
    replayCompletedRun: originalReplayCompletedRun,
    forkCompletedRun: originalForkCompletedRun,
  });
});

describe("completed-run decision workbench", () => {
  it("shows manifest identity, digest, snapshot, and explicit runtime boundaries", async () => {
    const artifact = await completedArtifact();
    useLabStore.setState({
      result: artifact.result,
      runState: "complete",
      completedRunArtifact: artifact,
    });

    render(<DecisionWorkbench open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Report" }));
    const report = screen.getByRole("tabpanel", { name: "Report" });

    expect(within(report).getByText("ui-completed-run")).toBeTruthy();
    expect(
      within(report).getByText("Result digest").parentElement?.textContent,
    ).toContain(artifact.manifest.resultDigest.value);
    expect(within(report).getByText("Actions").parentElement?.textContent).toBe(
      "Actions2",
    );
    expect(
      within(report).getByText("Snapshot").parentElement?.textContent,
    ).toContain("Delivered second 12 · exact");
    expect(
      within(report).getByText(/Replay starts from modeled second 0/),
    ).toBeTruthy();
    expect(
      within(report).getByText(/do not restore in-flight queues/),
    ).toBeTruthy();
    expect(
      within(report).getByText(/full completed artifact is not persisted/),
    ).toBeTruthy();
    expect(
      within(report).getByRole<HTMLButtonElement>("button", {
        name: /Completed-run manifest/,
      }).disabled,
    ).toBe(false);
    expect(
      within(report).getByRole<HTMLButtonElement>("button", {
        name: /Portable replay bundle/,
      }).disabled,
    ).toBe(false);
    expect(
      within(report).getByText(/This file cannot be imported or replayed/),
    ).toBeTruthy();
  });

  it("exposes the local Run library as a first-class workbench", () => {
    render(<DecisionWorkbench open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));
    const runs = screen.getByRole("tabpanel", { name: "Runs" });

    expect(within(runs).getByText("Run library")).toBeTruthy();
    expect(within(runs).getByText("Stored locally")).toBeTruthy();
    expect(
      within(runs).getByText(/Private interviewer runs are excluded/),
    ).toBeTruthy();
  });

  it("disables replay-bundle export for private interviewer runs", async () => {
    const scenario = structuredClone(DEFAULT_SCENARIO);
    scenario.mode = "interview";
    scenario.interview = {
      candidateBrief: "Design the public flow.",
      interviewerBrief: "Private evaluation material",
      timeboxMinutes: 45,
      allowCandidateRequirements: true,
      revealPolicy: "never",
    };
    scenario.requirements.push({
      ...scenario.requirements[0]!,
      id: "private-objective",
      label: "Private objective",
      visibility: "hidden",
      owner: "interviewer",
    });
    const result = simulate(scenario, DEFAULT_ARCHITECTURE);
    const artifact = await createCompletedRunArtifact({
      identity: {
        runId: "private-ui-run",
        scenarioRevision: 1,
        architectureRevision: 1,
        scenarioId: scenario.id,
        architectureId: DEFAULT_ARCHITECTURE.id,
      },
      scenario,
      architecture: DEFAULT_ARCHITECTURE,
      result,
      actionLog: appendCompletedRunAction([], "complete", 12),
      snapshotSecond: 12,
      digestProvider: null,
    });
    useLabStore.setState({
      scenario,
      result,
      runState: "complete",
      completedRunArtifact: artifact,
      role: "interviewer",
    });

    render(<DecisionWorkbench open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Report" }));
    const report = screen.getByRole("tabpanel", { name: "Report" });
    const portable = within(report).getByRole<HTMLButtonElement>("button", {
      name: /Portable replay bundle/,
    });

    expect(portable.disabled).toBe(true);
    expect(portable.textContent).toContain(
      "Private interviewer runs cannot be exported as replay bundles",
    );
    expect(
      within(report).getByText(
        /Portable replay export remains disabled for any run containing hidden requirements/,
      ),
    ).toBeTruthy();
  });

  it("replays from zero and creates a fork at the selected delivered frame", async () => {
    const artifact = await completedArtifact();
    const replayCompletedRun = vi.fn(() => Promise.resolve());
    const forkCompletedRun = vi.fn();
    const onClose = vi.fn();
    useLabStore.setState({
      result: artifact.result,
      runState: "complete",
      completedRunArtifact: artifact,
      replayCompletedRun,
      forkCompletedRun,
    });

    render(<DecisionWorkbench open onClose={onClose} />);
    fireEvent.click(screen.getByRole("tab", { name: "Report" }));

    fireEvent.click(
      screen.getByRole("button", { name: /Replay captured inputs/ }),
    );
    expect(replayCompletedRun).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Create and apply static fork/,
      }),
    );
    expect(forkCompletedRun).toHaveBeenCalledWith(12);
  });

  it("identifies the applied static fork and opens its current Lab draft", async () => {
    const artifact = await completedArtifact();
    const fork = forkCompletedRunAtSecond(artifact, 12, "ui-fork");
    const onClose = vi.fn();
    useLabStore.setState({
      scenario: fork.scenario,
      architecture: fork.architecture,
      completedRunArtifact: artifact,
      completedRunFork: fork,
    });

    render(<DecisionWorkbench open onClose={onClose} />);
    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    const versions = screen.getByRole("tabpanel", { name: "Versions" });

    expect(
      within(versions).getByText(
        "Static run-input fork is the current Lab draft",
      ),
    ).toBeTruthy();
    expect(
      within(versions).getByText(/did not restore in-flight state/),
    ).toBeTruthy();
    fireEvent.click(
      within(versions).getByRole("button", {
        name: "Open current fork draft in Lab",
      }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });
});
