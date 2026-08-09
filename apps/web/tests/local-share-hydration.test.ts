// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  solveArchitecture,
} from "@systemforge/sim-core";
import type { LocalSharePayload } from "../src/lib/share";

const mocks = vi.hoisted(() => ({
  decodeLocalShareInWorker: vi.fn(),
}));

vi.mock("../src/lib/localShareDecoder", () => ({
  decodeLocalShareInWorker: mocks.decodeLocalShareInWorker,
}));

const { useLabStore } = await import("../src/store/useLabStore");

const privateInterviewScenario = () => ({
  ...structuredClone(DEFAULT_SCENARIO),
  mode: "interview" as const,
  interview: {
    candidateBrief: "Design the service.",
    interviewerBrief: "Require regional durability.",
    timeboxMinutes: 45,
    allowCandidateRequirements: true,
    revealPolicy: "interviewer-controlled" as const,
  },
  requirements: [
    ...structuredClone(DEFAULT_SCENARIO.requirements),
    {
      id: "private-durability",
      label: "No acknowledged writes may be lost",
      metric: "dataLoss" as const,
      operator: "eq" as const,
      target: 0,
      unit: "writes",
      visibility: "hidden" as const,
      owner: "interviewer" as const,
    },
  ],
});

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/lab");
  useLabStore.setState({
    scenario: structuredClone(DEFAULT_SCENARIO),
    architecture: structuredClone(DEFAULT_ARCHITECTURE),
    role: "participant",
    sharedScenarioId: null,
    sharedHostToken: null,
    revealState: "hidden",
    notice: null,
  });
});

describe("local share hydration privacy", () => {
  it("scrubs the share hash before decoding and keeps interviewer data out of localStorage", async () => {
    const scenario = privateInterviewScenario();
    const payload: LocalSharePayload = {
      scenario,
      architecture: structuredClone(DEFAULT_ARCHITECTURE),
      role: "interviewer",
    };
    mocks.decodeLocalShareInWorker.mockResolvedValue(payload);
    window.history.replaceState({}, "", "/lab#share=private-payload&panel=run");

    const hydration = useLabStore.getState().hydrate();
    const strictModeReplay = useLabStore.getState().hydrate();

    expect(window.location.hash).toBe("#panel=run");
    expect(strictModeReplay).toBe(hydration);
    await Promise.all([hydration, strictModeReplay]);
    expect(mocks.decodeLocalShareInWorker).toHaveBeenCalledWith(
      "private-payload",
    );
    expect(mocks.decodeLocalShareInWorker).toHaveBeenCalledOnce();
    expect(useLabStore.getState()).toMatchObject({
      scenario,
      role: "interviewer",
      sharedScenarioId: null,
      sharedHostToken: null,
    });
    const publicDraft = JSON.parse(
      localStorage.getItem("systemforge:draft") ?? "{}",
    ) as { scenario?: typeof scenario };
    expect(publicDraft.scenario?.interview?.interviewerBrief).toBe("");
    expect(
      publicDraft.scenario?.requirements.some(
        (requirement) => requirement.visibility === "hidden",
      ),
    ).toBe(false);
    const privateDraft = JSON.parse(
      sessionStorage.getItem("systemforge:interviewer-draft") ?? "{}",
    ) as { scenario?: typeof scenario };
    expect(privateDraft.scenario).toEqual(scenario);
    expect(sessionStorage.getItem("systemforge:session")).toBeNull();
  });

  it("ignores a decoded payload after a newer server-backed scenario loads", async () => {
    let releaseDecode!: (payload: LocalSharePayload | null) => void;
    mocks.decodeLocalShareInWorker.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDecode = resolve;
        }),
    );
    window.history.replaceState({}, "", "/lab#share=slow-private-payload");
    const hydration = useLabStore.getState().hydrate();
    const currentScenario = {
      ...structuredClone(DEFAULT_SCENARIO),
      id: "current-server-scenario",
      title: "Current server scenario",
    };

    useLabStore
      .getState()
      .loadSharedScenario(
        currentScenario,
        structuredClone(DEFAULT_ARCHITECTURE),
        "participant",
        {
          id: "4fa97132-f1f0-41b8-8657-4966154a2545",
          revealState: "hidden",
        },
      );
    releaseDecode({
      scenario: privateInterviewScenario(),
      architecture: structuredClone(DEFAULT_ARCHITECTURE),
      role: "interviewer",
    });
    await hydration;

    expect(useLabStore.getState()).toMatchObject({
      scenario: currentScenario,
      role: "participant",
      sharedScenarioId: "4fa97132-f1f0-41b8-8657-4966154a2545",
    });
    expect(sessionStorage.getItem("systemforge:interviewer-draft")).toBeNull();
  });

  it("fails an invalid local share closed from an existing private workspace", async () => {
    const privateScenario = privateInterviewScenario();
    useLabStore.setState({
      scenario: privateScenario,
      role: "interviewer",
      solverResult: solveArchitecture(privateScenario, DEFAULT_ARCHITECTURE, {
        maxCandidates: 1,
      }),
      solverState: "complete",
      solverExecution: "local",
      sharedScenarioId: "4fa97132-f1f0-41b8-8657-4966154a2545",
      sharedHostToken: "0e18d74a-4bef-4757-90e9-fc814b2ce77b",
      revealState: "revealed",
    });
    sessionStorage.setItem(
      "systemforge:interviewer-draft",
      JSON.stringify({
        scenario: privateScenario,
        architecture: DEFAULT_ARCHITECTURE,
      }),
    );
    mocks.decodeLocalShareInWorker.mockResolvedValue(null);
    window.history.replaceState({}, "", "/lab#share=invalid");

    await useLabStore.getState().hydrate();

    expect(window.location.hash).toBe("");
    expect(useLabStore.getState()).toMatchObject({
      role: "participant",
      sharedScenarioId: null,
      sharedHostToken: null,
      revealState: "hidden",
      solverResult: null,
      solverState: "idle",
      solverExecution: null,
    });
    expect(
      useLabStore
        .getState()
        .scenario.requirements.some(
          (requirement) => requirement.visibility === "hidden",
        ),
    ).toBe(false);
    expect(useLabStore.getState().scenario.interview?.interviewerBrief).toBe(
      "",
    );
    expect(sessionStorage.getItem("systemforge:interviewer-draft")).toBeNull();
  });

  it("treats an empty share parameter as invalid instead of restoring private state", async () => {
    const privateScenario = privateInterviewScenario();
    useLabStore.setState({
      scenario: privateScenario,
      role: "interviewer",
      sharedScenarioId: "4fa97132-f1f0-41b8-8657-4966154a2545",
      sharedHostToken: "0e18d74a-4bef-4757-90e9-fc814b2ce77b",
    });
    mocks.decodeLocalShareInWorker.mockResolvedValue(null);
    window.history.replaceState({}, "", "/lab#share=");

    await useLabStore.getState().hydrate();

    expect(mocks.decodeLocalShareInWorker).toHaveBeenCalledWith("");
    expect(window.location.hash).toBe("");
    expect(useLabStore.getState()).toMatchObject({
      role: "participant",
      sharedScenarioId: null,
      sharedHostToken: null,
      solverResult: null,
    });
    expect(useLabStore.getState().scenario.interview?.interviewerBrief).toBe(
      "",
    );
  });
});
