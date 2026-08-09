// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  analyzeRobustness,
} from "@systemforge/sim-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionWorkbench } from "../src/components/DecisionWorkbench";
import type {
  RobustnessWorkerCommand,
  RobustnessWorkerMessage,
} from "../src/lib/robustnessAnalysis";
import { useLabStore } from "../src/store/useLabStore";

class WorkerMock {
  static instances: WorkerMock[] = [];

  onmessage: ((event: MessageEvent<RobustnessWorkerMessage>) => void) | null =
    null;
  onerror: (() => void) | null = null;
  messages: RobustnessWorkerCommand[] = [];
  terminated = false;

  constructor() {
    WorkerMock.instances.push(this);
  }

  postMessage(message: RobustnessWorkerCommand) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  emit(message: RobustnessWorkerMessage) {
    this.onmessage?.({
      data: message,
    } as MessageEvent<RobustnessWorkerMessage>);
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  WorkerMock.instances = [];
  useLabStore.setState({
    scenario: structuredClone(DEFAULT_SCENARIO),
    architecture: structuredClone(DEFAULT_ARCHITECTURE),
    scenarioRevision: 0,
    architectureRevision: 0,
    result: null,
    runState: "idle",
    solverResult: null,
    solverState: "idle",
  });
});

describe("DecisionWorkbench robustness analysis", () => {
  it("shows deterministic progress and produces no result after cancellation", async () => {
    vi.stubGlobal("Worker", WorkerMock);
    render(<DecisionWorkbench open onClose={vi.fn()} />);

    expect(screen.getByText(/Nine bounded deterministic seeds/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Analyze seed sensitivity/ }),
    );
    const worker = WorkerMock.instances[0]!;
    const start = worker.messages[0] as Extract<
      RobustnessWorkerCommand,
      { type: "start" }
    >;

    act(() => {
      worker.emit({
        type: "progress",
        identity: start.identity,
        completedSeeds: 3,
        totalSeeds: 9,
        progress: 1 / 3,
      });
    });

    expect(
      screen.getByText("Completed 3 of 9 deterministic seed runs (33%)."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Cancel analysis/ }));

    expect(
      await screen.findByText(
        "Analysis cancelled. No robustness result was produced.",
      ),
    ).toBeTruthy();
    expect(worker.terminated).toBe(true);
    expect(worker.messages.at(-1)).toEqual({
      type: "cancel",
      identity: start.identity,
    });
    expect(screen.queryByText("Objective pass rate")).toBeNull();
  });

  it("surfaces a worker error as a no-result state and allows retry", async () => {
    vi.stubGlobal("Worker", WorkerMock);
    render(<DecisionWorkbench open onClose={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Analyze seed sensitivity/ }),
    );
    const worker = WorkerMock.instances[0]!;
    const start = worker.messages[0] as Extract<
      RobustnessWorkerCommand,
      { type: "start" }
    >;

    act(() => {
      worker.emit({
        type: "error",
        identity: start.identity,
        error: "Robustness worker failed safely.",
      });
    });

    expect(
      await screen.findByText("Robustness worker failed safely."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Analyze seed sensitivity/ }),
    ).toBeTruthy();
    expect(screen.queryByText("Objective pass rate")).toBeNull();
  });

  it("invalidates the active request when the architecture revision changes", () => {
    vi.stubGlobal("Worker", WorkerMock);
    render(<DecisionWorkbench open onClose={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Analyze seed sensitivity/ }),
    );
    const worker = WorkerMock.instances[0]!;
    const start = worker.messages[0] as Extract<
      RobustnessWorkerCommand,
      { type: "start" }
    >;
    const staleResult = analyzeRobustness(
      DEFAULT_SCENARIO,
      DEFAULT_ARCHITECTURE,
      { seedCount: 2 },
    );

    act(() => {
      useLabStore.setState({ architectureRevision: 1 });
    });
    act(() => {
      worker.emit({
        type: "complete",
        identity: start.identity,
        result: staleResult,
      });
    });

    expect(worker.terminated).toBe(true);
    expect(worker.messages.at(-1)).toEqual({
      type: "cancel",
      identity: start.identity,
    });
    expect(screen.queryByText("Objective pass rate")).toBeNull();
    expect(screen.getByText(/Nine bounded deterministic seeds/)).toBeTruthy();
  });
});
