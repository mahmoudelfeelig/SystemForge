// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ARCHITECTURE, DEFAULT_SCENARIO } from "@systemforge/sim-core";
import {
  checkApi,
  fetchSharedScenario,
  shareScenario,
  submitCanonicalRun,
} from "../src/lib/api";
import { decodeLocalShare, interviewShareLinks } from "../src/lib/share";
import { useLabStore } from "../src/store/useLabStore";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("browser sharing and fallback", () => {
  it("keeps hidden interview criteria out of candidate-local links", () => {
    const interview = {
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
    };

    const links = interviewShareLinks(interview, DEFAULT_ARCHITECTURE);
    const candidate = decodeLocalShare(
      new URL(links.candidate).hash.replace("#share=", ""),
    );
    const interviewer = decodeLocalShare(
      new URL(links.interviewer).hash.replace("#share=", ""),
    );

    expect(
      candidate?.scenario.requirements.some(
        (item) => item.id === "private-durability",
      ),
    ).toBe(false);
    expect(candidate?.scenario.interview?.interviewerBrief).toBe("");
    expect(
      interviewer?.scenario.requirements.some(
        (item) => item.id === "private-durability",
      ),
    ).toBe(true);
  });

  it("encodes the interviewer credential when loading a canonical share", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "scenario-id",
          scenario: DEFAULT_SCENARIO,
          architecture: DEFAULT_ARCHITECTURE,
          role: "interviewer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchSharedScenario("scenario-id", "secret token/with punctuation");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/scenarios/scenario-id?hostToken=secret%20token%2Fwith%20punctuation",
      expect.objectContaining({
        headers: expect.objectContaining({
          "content-type": "application/json",
        }),
      }),
    );
  });

  it("maps readiness and canonical overload responses without hiding the local fallback", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: "service_unavailable" } }),
          { status: 503 },
        ),
      )
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "canonical_capacity_exceeded",
              message: "Canonical capacity is full.",
              retryAfterSeconds: 15,
              localModeAvailable: true,
            },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkApi()).resolves.toBe("online");
    await expect(checkApi()).resolves.toBe("busy");
    await expect(checkApi()).resolves.toBe("offline");
    await expect(
      submitCanonicalRun({
        scenario: DEFAULT_SCENARIO,
        architecture: DEFAULT_ARCHITECTURE,
        clientEngineVersion: "0.1.0",
      }),
    ).rejects.toMatchObject({
      code: "canonical_capacity_exceeded",
      retryAfterSeconds: 15,
      status: 429,
    });
  });

  it("posts canonical scenario payloads and returns short-link metadata", async () => {
    const receipt = {
      id: "scenario-id",
      url: "https://systemforge.elfeel.me/scenario/scenario-id",
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(receipt), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      shareScenario(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE),
    ).resolves.toEqual(receipt);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/scenarios",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          scenario: DEFAULT_SCENARIO,
          architecture: DEFAULT_ARCHITECTURE,
        }),
      }),
    );
  });

  it("keeps canonical submission disabled while local work is available", async () => {
    useLabStore.setState({ apiAvailability: "offline", notice: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await useLabStore.getState().submitCanonical();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useLabStore.getState().notice).toContain("runs locally");
  });
});
