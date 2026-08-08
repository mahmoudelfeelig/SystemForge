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

    const localLink = screen.getByLabelText("Challenge link");
    expect((localLink as HTMLInputElement).value).toContain("/lab#share=");

    fireEvent.click(
      screen.getByRole("button", { name: /compile and open lab/i }),
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

  it("keeps interviewer objectives private when compiling the modular interview lab", () => {
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
      screen.getByRole("button", { name: /compile and open lab/i }),
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

    const localLink = screen.getByLabelText("Challenge link");
    fireEvent.click(
      screen.getByRole("button", { name: "Request canonical link" }),
    );

    await waitFor(() =>
      expect(screen.getByText(/local links remain available/i)).toBeTruthy(),
    );
    expect((localLink as HTMLInputElement).disabled).toBe(false);
    expect((localLink as HTMLInputElement).value).toContain("/lab#share=");
  });
});
