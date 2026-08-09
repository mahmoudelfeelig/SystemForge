// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Requirement } from "@systemforge/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  candidateRequirementsEnabled,
  DerivedRequirementEditor,
} from "../src/pages/LabPage";
import { useLabStore } from "../src/store/useLabStore";
import { DEFAULT_SCENARIO } from "@systemforge/sim-core";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const requirement: Requirement = {
  id: "derived-latency",
  label: "Checkout remains interactive",
  metric: "p95LatencyMs",
  operator: "lte",
  target: 400,
  unit: "ms",
  visibility: "derived",
  owner: "candidate",
};

describe("candidate-derived requirements", () => {
  it("captures the candidate's actual constraint instead of a fixed placeholder", () => {
    const onSave = vi.fn();
    const onRemove = vi.fn();
    render(
      <DerivedRequirementEditor
        requirement={requirement}
        onSave={onSave}
        onRemove={onRemove}
      />,
    );

    fireEvent.change(screen.getByLabelText("Derived requirement"), {
      target: { value: "Acknowledged writes must survive failover" },
    });
    fireEvent.change(screen.getByLabelText("Derived requirement metric"), {
      target: { value: "dataLoss" },
    });
    fireEvent.change(screen.getByLabelText("Derived requirement operator"), {
      target: { value: "eq" },
    });
    fireEvent.change(screen.getByLabelText("Derived requirement target"), {
      target: { value: "0" },
    });

    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Acknowledged writes must survive failover",
        metric: "dataLoss",
        operator: "eq",
        target: 0,
        owner: "candidate",
        visibility: "derived",
      }),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove Checkout remains interactive",
      }),
    );
    expect(onRemove).toHaveBeenCalledWith("derived-latency");
  });

  it("persists removals and invalidates a stale result", () => {
    const scenario = {
      ...structuredClone(DEFAULT_SCENARIO),
      requirements: [
        ...structuredClone(DEFAULT_SCENARIO.requirements),
        requirement,
      ],
    };
    useLabStore.setState({
      scenario,
      result: { digest: "stale" } as never,
      runState: "complete",
    });

    useLabStore.getState().removeRequirement(requirement.id);

    expect(
      useLabStore
        .getState()
        .scenario.requirements.some((item) => item.id === requirement.id),
    ).toBe(false);
    expect(useLabStore.getState().result).toBeNull();
    expect(useLabStore.getState().runState).toBe("idle");
    expect(
      JSON.parse(localStorage.getItem("systemforge:draft") ?? "{}"),
    ).toMatchObject({
      scenario: {
        requirements: expect.not.arrayContaining([
          expect.objectContaining({ id: requirement.id }),
        ]),
      },
    });
  });

  it("honors the interviewer's candidate-authoring policy", () => {
    const interview = {
      mode: "interview",
      interview: { allowCandidateRequirements: true },
    };
    expect(candidateRequirementsEnabled(interview, "participant")).toBe(true);
    expect(
      candidateRequirementsEnabled(
        {
          ...interview,
          interview: { allowCandidateRequirements: false },
        },
        "participant",
      ),
    ).toBe(false);
    expect(candidateRequirementsEnabled(interview, "interviewer")).toBe(false);
  });
});
