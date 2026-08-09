// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  AI_ASSISTANT_CONTRACT_VERSION,
  AI_ASSISTANT_PROMPT_VERSION,
  type AiScenarioCompileResponse,
} from "@systemforge/contracts";
import { DEFAULT_ARCHITECTURE, DEFAULT_SCENARIO } from "@systemforge/sim-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchAiCapabilities: vi.fn(),
  compileRequirementsWithAi: vi.fn(),
  compileScenarioWithAi: vi.fn(),
  debriefCanonicalRunWithAi: vi.fn(),
  conductInterviewWithAi: vi.fn(),
}));

vi.mock("../src/lib/ai", () => mocks);

const { InterviewAiFacilitator, RunAiDebriefPanel, ScenarioAiAssistant } =
  await import("../src/components/AiAssistantPanels");
const { useLabStore } = await import("../src/store/useLabStore");

const provider = { id: "openai-responses" as const, model: "test-model" };

const capabilityResponse = {
  contractVersion: AI_ASSISTANT_CONTRACT_VERSION,
  enabled: true,
  tasks: [
    "compile-requirements",
    "author-scenario",
    "debrief-run",
    "conduct-interview",
  ] as const,
  provider: { id: "openai-responses" as const },
  boundaries: ["proposal only"],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  useLabStore.setState({
    scenario: structuredClone(DEFAULT_SCENARIO),
    architecture: structuredClone(DEFAULT_ARCHITECTURE),
    scenarioRevision: 0,
    architectureRevision: 0,
    canonicalRunId: null,
    canonicalRunStatus: "idle",
    canonicalRunDigest: null,
    role: "participant",
    sharedScenarioId: null,
    sharedHostToken: null,
  });
});

describe("optional AI assistant panels", () => {
  it("previews a validated scenario without mutating until Apply", async () => {
    mocks.fetchAiCapabilities.mockResolvedValue(capabilityResponse);
    const proposedScenario = {
      ...structuredClone(DEFAULT_SCENARIO),
      mode: "custom" as const,
      title: "AI-proposed checkout exercise",
      summary: "Proposed operating summary with the reviewed failure scope.",
    };
    const response: AiScenarioCompileResponse = {
      contractVersion: AI_ASSISTANT_CONTRACT_VERSION,
      promptVersion: AI_ASSISTANT_PROMPT_VERSION,
      provider,
      assumptions: [],
      boundary: "ai-proposal-not-modeled-evidence",
      task: "author-scenario",
      scenario: proposedScenario,
      changes: [{ path: "title", provenance: "ai-wording" }],
      unresolvedQuestions: [],
    };
    mocks.compileScenarioWithAi.mockResolvedValue(response);
    const onApplyScenario = vi.fn();

    render(
      <ScenarioAiAssistant
        scenario={{ ...structuredClone(DEFAULT_SCENARIO), mode: "custom" }}
        architecture={structuredClone(DEFAULT_ARCHITECTURE)}
        mode="custom"
        onApplyScenario={onApplyScenario}
        onApplyRequirements={vi.fn()}
      />,
    );

    await screen.findByText("Optional assistant connected");
    fireEvent.change(screen.getByLabelText(/Written brief/), {
      target: {
        value:
          "Sustain 12,000 rps and keep p95 latency below 300 ms for 10 minutes.",
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Prepare validated proposal" }),
    );

    expect(
      await screen.findByText("AI-proposed checkout exercise"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Proposed operating summary with the reviewed failure scope.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Scheduled incidents")).toBeTruthy();
    expect(screen.getByText("Evaluation criteria")).toBeTruthy();
    expect(screen.getAllByText(/public/).length).toBeGreaterThan(0);
    expect(onApplyScenario).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Apply validated proposal" }),
    );
    expect(onApplyScenario).toHaveBeenCalledWith(
      expect.objectContaining({ title: "AI-proposed checkout exercise" }),
    );
  });

  it("ignores a proposal that resolves after the draft changes", async () => {
    mocks.fetchAiCapabilities.mockResolvedValue(capabilityResponse);
    let resolveProposal!: (value: AiScenarioCompileResponse) => void;
    mocks.compileScenarioWithAi.mockImplementation(
      () =>
        new Promise<AiScenarioCompileResponse>((resolve) => {
          resolveProposal = resolve;
        }),
    );
    const original = {
      ...structuredClone(DEFAULT_SCENARIO),
      mode: "custom" as const,
    };
    const changed = { ...original, title: "Changed while waiting" };
    const view = render(
      <ScenarioAiAssistant
        scenario={original}
        architecture={structuredClone(DEFAULT_ARCHITECTURE)}
        mode="custom"
        onApplyScenario={vi.fn()}
        onApplyRequirements={vi.fn()}
      />,
    );

    await screen.findByText("Optional assistant connected");
    fireEvent.change(screen.getByLabelText(/Written brief/), {
      target: { value: "Keep p95 below 300 ms during 10 minutes." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Prepare validated proposal" }),
    );
    view.rerender(
      <ScenarioAiAssistant
        scenario={changed}
        architecture={structuredClone(DEFAULT_ARCHITECTURE)}
        mode="custom"
        onApplyScenario={vi.fn()}
        onApplyRequirements={vi.fn()}
      />,
    );
    resolveProposal({
      contractVersion: AI_ASSISTANT_CONTRACT_VERSION,
      promptVersion: AI_ASSISTANT_PROMPT_VERSION,
      provider,
      assumptions: [],
      boundary: "ai-proposal-not-modeled-evidence",
      task: "author-scenario",
      scenario: { ...original, title: "Stale proposal" },
      changes: [{ path: "title", provenance: "ai-wording" }],
      unresolvedQuestions: [],
    });

    await waitFor(() =>
      expect(screen.queryByText("Stale proposal")).toBeNull(),
    );
  });

  it("renders exact deterministic evidence and sends a host token only for the interviewer", async () => {
    mocks.fetchAiCapabilities.mockResolvedValue(capabilityResponse);
    mocks.debriefCanonicalRunWithAi.mockResolvedValue({
      contractVersion: AI_ASSISTANT_CONTRACT_VERSION,
      promptVersion: AI_ASSISTANT_PROMPT_VERSION,
      provider,
      assumptions: [],
      boundary: "deterministic-modeled-evidence-not-production-telemetry",
      task: "debrief-run",
      runId: "da9e2e66-d41d-46ee-9f96-94ab7a153830",
      engineVersion: "0.7.0",
      digest: "sha256:deterministic",
      privacyScope: "interviewer",
      headline: "The primary dependency sets the recovery boundary",
      observations: [
        {
          finding: "The availability objective needs another failure test.",
          evidenceIds: ["availability"],
        },
      ],
      nextTests: ["Repeat with the regional dependency removed."],
      evidence: [
        {
          id: "availability",
          label: "Minimum availability",
          value: "99.9%",
          source: "frame",
        },
      ],
    });
    useLabStore.setState({
      canonicalRunId: "da9e2e66-d41d-46ee-9f96-94ab7a153830",
      canonicalRunStatus: "completed",
      canonicalRunDigest: "sha256:deterministic",
      role: "interviewer",
      sharedScenarioId: "14a16318-e263-4d63-9da9-a32e96e35a5c",
      sharedHostToken: "0e18d74a-4bef-4757-90e9-fc814b2ce77b",
    });

    render(<RunAiDebriefPanel />);
    await screen.findByText("Optional assistant connected");
    fireEvent.click(
      screen.getByRole("button", { name: "Debrief canonical run" }),
    );

    expect(await screen.findByText("99.9%")).toBeTruthy();
    expect(mocks.debriefCanonicalRunWithAi).toHaveBeenCalledWith(
      { runId: "da9e2e66-d41d-46ee-9f96-94ab7a153830" },
      "0e18d74a-4bef-4757-90e9-fc814b2ce77b",
      expect.any(AbortSignal),
    );
  });

  it("keeps interview facilitation candidate-visible and explicitly non-scoring", async () => {
    mocks.fetchAiCapabilities.mockResolvedValue(capabilityResponse);
    mocks.conductInterviewWithAi.mockResolvedValue({
      contractVersion: AI_ASSISTANT_CONTRACT_VERSION,
      promptVersion: AI_ASSISTANT_PROMPT_VERSION,
      provider,
      assumptions: [],
      boundary: "candidate-visible-facilitation-not-scoring",
      task: "conduct-interview",
      question: "How would you discover the recovery objective?",
      purpose: "Invite the candidate to clarify recovery before designing.",
    });
    const interview = structuredClone(DEFAULT_SCENARIO);
    interview.mode = "interview";
    interview.interview = {
      candidateBrief: "Design the service.",
      interviewerBrief: "PRIVATE-RUBRIC-SENTINEL",
      timeboxMinutes: 45,
      allowCandidateRequirements: true,
      revealPolicy: "never",
    };
    useLabStore.setState({
      scenario: interview,
      role: "interviewer",
      scenarioRevision: 1,
    });
    const onQuestionGenerated = vi.fn();

    render(
      <InterviewAiFacilitator
        candidateNotes="Current unsaved candidate note"
        candidatePhase="Clarifying requirements"
        previousQuestions={[]}
        onQuestionGenerated={onQuestionGenerated}
      />,
    );
    await screen.findByText("Optional assistant connected");
    fireEvent.click(
      screen.getByRole("button", { name: "Draft next question" }),
    );

    expect(
      await screen.findByText("How would you discover the recovery objective?"),
    ).toBeTruthy();
    expect(screen.getByText(/no candidate score/i)).toBeTruthy();
    expect(mocks.conductInterviewWithAi).toHaveBeenCalledWith(
      expect.objectContaining({
        architecture: expect.objectContaining({ id: DEFAULT_ARCHITECTURE.id }),
        candidateNotes: "Current unsaved candidate note",
        candidatePhase: "Clarifying requirements",
      }),
      expect.any(AbortSignal),
    );
    expect(onQuestionGenerated).toHaveBeenCalledWith(
      "How would you discover the recovery objective?",
    );
  });
});
