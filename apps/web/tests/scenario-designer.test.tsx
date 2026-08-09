// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import {
  AI_ASSISTANT_CONTRACT_VERSION,
  AI_ASSISTANT_PROMPT_VERSION,
} from "@systemforge/contracts";
import { ScenarioDesignerPage } from "../src/pages/ScenarioDesignerPage";
import { useLabStore } from "../src/store/useLabStore";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe("scenario workload controls", () => {
  it("lets the interviewer disable retries on client timeout", () => {
    render(
      <MemoryRouter>
        <ScenarioDesignerPage mode="interview" />
      </MemoryRouter>,
    );

    const retryOnTimeout = screen.getByLabelText("Retry on client timeout");
    expect((retryOnTimeout as HTMLInputElement).checked).toBe(true);

    fireEvent.click(retryOnTimeout);

    expect((retryOnTimeout as HTMLInputElement).checked).toBe(false);
  });

  it("authors a custom measurable objective and compiles it into the shared lab", () => {
    render(
      <MemoryRouter>
        <ScenarioDesignerPage mode="custom" />
      </MemoryRouter>,
    );

    const originalCount = screen.getAllByLabelText("Requirement label").length;
    fireEvent.click(screen.getByRole("button", { name: "Add objective" }));

    const labels = screen.getAllByLabelText("Requirement label");
    const metrics = screen.getAllByLabelText("Metric");
    const operators = screen.getAllByLabelText("Operator");
    const targets = screen.getAllByLabelText("Target");
    const units = screen.getAllByLabelText("Unit");
    expect(labels).toHaveLength(originalCount + 1);

    fireEvent.change(labels.at(-1)!, {
      target: { value: "Checkout remains interactive during regional loss" },
    });
    fireEvent.change(metrics.at(-1)!, { target: { value: "p95LatencyMs" } });
    fireEvent.change(operators.at(-1)!, { target: { value: "lte" } });
    fireEvent.change(targets.at(-1)!, { target: { value: "350" } });
    fireEvent.change(units.at(-1)!, { target: { value: "ms" } });

    const localLink = screen.getByLabelText("Scenario link");
    expect((localLink as HTMLInputElement).value).toContain("/lab#share=");

    fireEvent.click(
      screen.getAllByRole("button", { name: /open in lab/i })[0]!,
    );

    expect(useLabStore.getState().scenario.mode).toBe("custom");
    expect(useLabStore.getState().scenario.requirements.at(-1)).toMatchObject({
      label: "Checkout remains interactive during regional loss",
      metric: "p95LatencyMs",
      operator: "lte",
      target: 350,
      unit: "ms",
      visibility: "public",
      owner: "scenario",
    });
  });

  it("authors bounded seeded incident rules with scope and prior-frame triggers", () => {
    render(
      <MemoryRouter>
        <ScenarioDesignerPage mode="custom" />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByLabelText("Enable seeded incident model"));
    fireEvent.change(screen.getByLabelText("Maximum generated incidents"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add seeded rule" }));

    fireEvent.change(screen.getByLabelText("Rule label"), {
      target: { value: "Primary database pressure" },
    });
    fireEvent.change(screen.getByLabelText("Rule failure"), {
      target: { value: "database-degradation" },
    });
    fireEvent.change(screen.getByLabelText("Hazard per eligible second"), {
      target: { value: "0.2" },
    });
    fireEvent.change(screen.getByLabelText("Cooldown seconds"), {
      target: { value: "12" },
    });
    fireEvent.change(screen.getByLabelText("Maximum occurrences"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByLabelText("Rule magnitude"), {
      target: { value: "2.5" },
    });
    fireEvent.change(screen.getByLabelText("Rule duration seconds"), {
      target: { value: "7" },
    });
    fireEvent.change(screen.getByLabelText("Scope region"), {
      target: { value: "EU" },
    });
    fireEvent.change(screen.getByLabelText("Scope failure domain"), {
      target: { value: "cluster" },
    });
    fireEvent.click(screen.getByLabelText("Correlate matching scope"));
    fireEvent.change(screen.getByLabelText("State trigger metric"), {
      target: { value: "p95LatencyMs" },
    });
    fireEvent.change(screen.getByLabelText("Trigger threshold"), {
      target: { value: "250" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add seeded rule" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove seeded rule Seeded node failure",
      }),
    );
    expect(screen.getAllByText(/SEEDED RULE/)).toHaveLength(1);

    fireEvent.click(
      screen.getAllByRole("button", { name: /open in lab/i })[0]!,
    );

    expect(useLabStore.getState().scenario.stochasticIncidents).toEqual({
      enabled: true,
      maxGeneratedIncidents: 3,
      rules: [
        expect.objectContaining({
          enabled: true,
          kind: "database-degradation",
          label: "Primary database pressure",
          hazardRatePerSecond: 0.2,
          cooldownSeconds: 12,
          maxOccurrences: 2,
          magnitude: 2.5,
          durationSeconds: 7,
          scope: {
            region: "EU",
            failureDomain: "cluster",
            correlated: true,
          },
          trigger: {
            metric: "p95LatencyMs",
            operator: "gte",
            threshold: 250,
          },
        }),
      ],
    });
    expect(screen.getByText(/not measured failure rates/i)).toBeTruthy();
  });

  it("keeps interviewer objectives private when compiling the modular interview lab", async () => {
    render(
      <MemoryRouter>
        <ScenarioDesignerPage mode="interview" />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("Evaluation brief"), {
      target: { value: "Look for explicit regional durability reasoning." },
    });
    fireEvent.change(screen.getByLabelText("Requirement label"), {
      target: { value: "No acknowledged writes are lost" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: /open in lab/i })[0]!,
    );

    expect(useLabStore.getState()).toMatchObject({ role: "interviewer" });
    expect(useLabStore.getState().scenario).toMatchObject({
      mode: "interview",
      interview: {
        interviewerBrief: "Look for explicit regional durability reasoning.",
        allowCandidateRequirements: true,
      },
      requirements: [
        expect.objectContaining({
          label: "No acknowledged writes are lost",
          visibility: "hidden",
          owner: "interviewer",
        }),
      ],
    });
    await useLabStore.getState().hydrate();
    expect(useLabStore.getState()).toMatchObject({ role: "interviewer" });
    expect(
      useLabStore
        .getState()
        .scenario.requirements.some(
          (requirement) => requirement.visibility === "hidden",
        ),
    ).toBe(true);
  });

  it("merges AI-compiled public objectives without deleting the private rubric", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.endsWith("/api/ai/capabilities"))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                contractVersion: AI_ASSISTANT_CONTRACT_VERSION,
                enabled: true,
                tasks: [
                  "compile-requirements",
                  "author-scenario",
                  "debrief-run",
                  "conduct-interview",
                ],
                provider: { id: "openai-responses" },
                boundaries: ["proposal only"],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        if (url.endsWith("/api/ai/compile/requirements"))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                contractVersion: AI_ASSISTANT_CONTRACT_VERSION,
                promptVersion: AI_ASSISTANT_PROMPT_VERSION,
                provider: { id: "openai-responses", model: "test-model" },
                assumptions: [],
                boundary: "ai-proposal-not-modeled-evidence",
                task: "compile-requirements",
                requirements: [
                  {
                    id: "ai-public-availability",
                    label: "Availability remains above the stated objective",
                    metric: "availability",
                    operator: "gte",
                    target: 99.9,
                    unit: "%",
                    visibility: "public",
                    owner: "scenario",
                  },
                ],
                unresolvedQuestions: [],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        return Promise.reject(new Error(`Unexpected request: ${url}`));
      }),
    );
    render(
      <MemoryRouter>
        <ScenarioDesignerPage mode="interview" />
      </MemoryRouter>,
    );

    await screen.findByText("Optional assistant connected");
    fireEvent.change(screen.getByLabelText("Proposal type"), {
      target: { value: "compile-requirements" },
    });
    fireEvent.change(screen.getByLabelText("Objective visibility"), {
      target: { value: "public" },
    });
    fireEvent.change(screen.getByLabelText("Written brief"), {
      target: { value: "Keep availability above 99.9% during the test." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Prepare validated proposal" }),
    );
    expect(
      await screen.findByText(
        "Availability remains above the stated objective",
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Apply validated proposal" }),
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /open in lab/i })[0]!,
    );

    const requirements = useLabStore.getState().scenario.requirements;
    expect(
      requirements.some((requirement) => requirement.visibility === "hidden"),
    ).toBe(true);
    expect(requirements).toContainEqual(
      expect.objectContaining({
        id: "ai-public-availability",
        visibility: "public",
        owner: "scenario",
      }),
    );
  });

  it("keeps the local challenge link available when canonical publishing is busy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "scenario_capacity_exceeded",
              message: "Canonical sharing is currently full.",
              retryAfterSeconds: 60,
              localModeAvailable: true,
            },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    render(
      <MemoryRouter>
        <ScenarioDesignerPage mode="custom" />
      </MemoryRouter>,
    );

    const localLink = screen.getByLabelText("Scenario link");
    fireEvent.click(screen.getByRole("button", { name: "Create short link" }));

    await waitFor(() =>
      expect(screen.getByText(/local links remain available/i)).toBeTruthy(),
    );
    expect((localLink as HTMLInputElement).disabled).toBe(false);
    expect((localLink as HTMLInputElement).value).toContain("/lab#share=");
  });

  it("does not attach an in-flight short link to a newer draft", async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    render(
      <MemoryRouter>
        <ScenarioDesignerPage mode="custom" />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create short link" }));
    fireEvent.change(screen.getByLabelText("Scenario title"), {
      target: { value: "A newer scenario draft" },
    });
    resolveFetch(
      new Response(
        JSON.stringify({
          id: "old-draft",
          url: "https://systemforge.example.test/scenario/old-draft",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(screen.queryByLabelText("Scenario short link")).toBeNull();
  });
});
