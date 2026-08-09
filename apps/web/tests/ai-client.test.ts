import {
  AI_ASSISTANT_CONTRACT_VERSION,
  AI_ASSISTANT_PROMPT_VERSION,
} from "@systemforge/contracts";
import { DEFAULT_ARCHITECTURE, DEFAULT_SCENARIO } from "@systemforge/sim-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conductInterviewWithAi,
  debriefCanonicalRunWithAi,
} from "../src/lib/ai";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web AI client privacy", () => {
  it("candidate-sanitizes interview context before sending it", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            contractVersion: AI_ASSISTANT_CONTRACT_VERSION,
            promptVersion: AI_ASSISTANT_PROMPT_VERSION,
            provider: { id: "openai-responses", model: "test-model" },
            assumptions: [],
            boundary: "candidate-visible-facilitation-not-scoring",
            task: "conduct-interview",
            question: "What recovery target would you clarify first?",
            purpose: "Invite explicit discovery before topology design.",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const scenario = structuredClone(DEFAULT_SCENARIO);
    scenario.mode = "interview";
    scenario.interview = {
      candidateBrief: "Design the service.",
      interviewerBrief: "PRIVATE-RUBRIC-SENTINEL",
      timeboxMinutes: 45,
      allowCandidateRequirements: true,
      revealPolicy: "never",
    };
    scenario.requirements[0] = {
      ...scenario.requirements[0]!,
      label: "PRIVATE-REQUIREMENT-SENTINEL",
      visibility: "hidden",
      owner: "interviewer",
    };

    await conductInterviewWithAi({
      scenario,
      architecture: structuredClone(DEFAULT_ARCHITECTURE),
      candidateNotes: "Candidate note",
      candidatePhase: "Clarifying requirements",
      previousQuestions: [],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    if (typeof init.body !== "string")
      throw new Error("Expected the AI request body to be serialized JSON.");
    const body = init.body;
    expect(body).not.toContain("PRIVATE-RUBRIC-SENTINEL");
    expect(body).not.toContain("PRIVATE-REQUIREMENT-SENTINEL");
    expect(body).toContain("Design the service.");
  });

  it("sends a host credential only when the caller explicitly supplies it", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            contractVersion: AI_ASSISTANT_CONTRACT_VERSION,
            promptVersion: AI_ASSISTANT_PROMPT_VERSION,
            provider: { id: "openai-responses", model: "test-model" },
            assumptions: [],
            boundary: "deterministic-modeled-evidence-not-production-telemetry",
            task: "debrief-run",
            runId: "da9e2e66-d41d-46ee-9f96-94ab7a153830",
            engineVersion: "0.7.0",
            digest: "sha256:test",
            privacyScope: "public",
            headline: "The run has one dominant pressure point",
            observations: [
              {
                finding: "The bottleneck needs a follow-up.",
                evidenceIds: ["fact"],
              },
            ],
            nextTests: [],
            evidence: [
              {
                id: "fact",
                label: "Checks passed",
                value: "3 of 4",
                source: "frame",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const run = { runId: "da9e2e66-d41d-46ee-9f96-94ab7a153830" };

    await debriefCanonicalRunWithAi(run);
    await debriefCanonicalRunWithAi(
      run,
      "0e18d74a-4bef-4757-90e9-fc814b2ce77b",
    );

    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toEqual({
      "content-type": "application/json",
    });
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer 0e18d74a-4bef-4757-90e9-fc814b2ce77b",
    });
  });
});
