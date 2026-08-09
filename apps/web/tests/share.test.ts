// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  ENGINE_VERSION,
} from "@systemforge/sim-core";
import {
  checkApi,
  fetchSharedScenario,
  recordSharedScenarioRun,
  setSharedScenarioReveal,
  shareScenario,
  solveCanonicalArchitecture,
  submitCanonicalRun,
  updateInterviewCollaboration,
} from "../src/lib/api";
import {
  candidateLocalShareLink,
  decodeLocalShare,
  encodeLocalShare,
  interviewShareLinks,
  LocalShareTooLargeError,
  scenarioForLocalShare,
} from "../src/lib/share";
import { useLabStore } from "../src/store/useLabStore";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  useLabStore.setState({
    scenario: structuredClone(DEFAULT_SCENARIO),
    architecture: structuredClone(DEFAULT_ARCHITECTURE),
    role: "participant",
    sharedScenarioId: null,
    sharedHostToken: null,
    revealState: "hidden",
  });
});

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

describe("browser sharing and fallback", () => {
  it("creates a compact versioned share with an integrity check", () => {
    const encoded = encodeLocalShare({
      scenario: DEFAULT_SCENARIO,
      architecture: DEFAULT_ARCHITECTURE,
      role: "participant",
    });

    expect(encoded.startsWith("sf2.")).toBe(true);
    expect(encoded.length).toBeLessThan(6_000);
    expect(decodeLocalShare(encoded)).toEqual({
      scenario: DEFAULT_SCENARIO,
      architecture: DEFAULT_ARCHITECTURE,
      role: "participant",
    });

    const parts = encoded.split(".");
    parts[1] = "corrupt";
    expect(decodeLocalShare(parts.join("."))).toBeNull();
  });

  it("migrates version 1 uncompressed local links", () => {
    const legacy = btoa(
      JSON.stringify({
        scenario: DEFAULT_SCENARIO,
        architecture: DEFAULT_ARCHITECTURE,
        role: "participant",
      }),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");

    expect(decodeLocalShare(legacy)).toEqual({
      scenario: DEFAULT_SCENARIO,
      architecture: DEFAULT_ARCHITECTURE,
      role: "participant",
    });
  });

  it("keeps hidden interview criteria out of candidate-local links", () => {
    const interview = privateInterviewScenario();

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

  it("builds the Lab's default share as candidate-safe from an interviewer workspace", () => {
    const link = candidateLocalShareLink(
      privateInterviewScenario(),
      DEFAULT_ARCHITECTURE,
      "https://systemforge.example",
    );
    const payload = decodeLocalShare(new URL(link).hash.replace("#share=", ""));

    expect(link.startsWith("https://systemforge.example/lab#share=")).toBe(
      true,
    );
    expect(payload?.role).toBe("participant");
    expect(payload?.scenario.interview?.interviewerBrief).toBe("");
    expect(
      payload?.scenario.requirements.some(
        (requirement) => requirement.id === "private-durability",
      ),
    ).toBe(false);
  });

  it("rejects a local share whose architecture does not match the current contract", () => {
    const malformed = btoa(
      JSON.stringify({
        scenario: DEFAULT_SCENARIO,
        architecture: {},
        role: "participant",
      }),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");

    expect(decodeLocalShare(malformed)).toBeNull();
  });

  it("round-trips a blank editor architecture through a local share", () => {
    const blankArchitecture = {
      ...structuredClone(DEFAULT_ARCHITECTURE),
      id: "blank-shared-editor",
      name: "Blank shared editor",
      nodes: [],
      edges: [],
    };

    const decoded = decodeLocalShare(
      encodeLocalShare({
        scenario: DEFAULT_SCENARIO,
        architecture: blankArchitecture,
        role: "participant",
      }),
    );

    expect(decoded?.architecture).toEqual(blankArchitecture);
  });

  it("refuses to emit a local link that its own decoder would reject", () => {
    const nodes = Array.from({ length: 200 }, (_, index) => ({
      ...structuredClone(DEFAULT_ARCHITECTURE.nodes[index % 8]!),
      id: `large-node-${index}`,
      name: `Large component ${index}`,
      position: { x: (index % 20) * 140, y: Math.floor(index / 20) * 90 },
    }));
    const edges = Array.from({ length: 600 }, (_, index) => ({
      id: `large-edge-${index}`,
      source: nodes[index % nodes.length]!.id,
      target: nodes[(index * 17 + 1) % nodes.length]!.id,
      config: {
        trafficShare: 0.5 + (index % 50) / 100,
        latencyMs: index % 100,
        jitterMs: index % 25,
        packetLossRate: (index % 10) / 1_000,
        asynchronous: index % 3 === 0,
      },
    }));

    expect(() =>
      encodeLocalShare({
        scenario: DEFAULT_SCENARIO,
        architecture: {
          ...structuredClone(DEFAULT_ARCHITECTURE),
          id: "large-valid-editor-graph",
          nodes,
          edges,
        },
        role: "participant",
      }),
    ).toThrow(LocalShareTooLargeError);
  });

  it("sanitizes participant-side lab shares even when browser state contains private criteria", () => {
    const scenario = scenarioForLocalShare(
      privateInterviewScenario(),
      "participant",
    );

    expect(scenario.interview?.interviewerBrief).toBe("");
    expect(
      scenario.requirements.some(
        (requirement) => requirement.visibility === "hidden",
      ),
    ).toBe(false);
  });

  it("defensively strips misplaced interview data from a participant share", () => {
    const scenario = {
      ...privateInterviewScenario(),
      mode: "custom" as const,
      requirements: structuredClone(DEFAULT_SCENARIO.requirements),
    };

    const shared = scenarioForLocalShare(scenario, "participant");

    expect(shared.interview).toBeUndefined();
  });

  it("migrates a canonical interviewer draft out of localStorage", async () => {
    const scenario = privateInterviewScenario();
    localStorage.setItem(
      "systemforge:draft",
      JSON.stringify({ scenario, architecture: DEFAULT_ARCHITECTURE }),
    );
    sessionStorage.setItem(
      "systemforge:session",
      JSON.stringify({
        id: "4fa97132-f1f0-41b8-8657-4966154a2545",
        hostToken: "0e18d74a-4bef-4757-90e9-fc814b2ce77b",
        role: "interviewer",
        revealState: "hidden",
      }),
    );
    useLabStore.setState({ role: "participant", sharedHostToken: null });

    await useLabStore.getState().hydrate();

    expect(useLabStore.getState()).toMatchObject({
      role: "interviewer",
      sharedHostToken: "0e18d74a-4bef-4757-90e9-fc814b2ce77b",
    });
    expect(useLabStore.getState().scenario.interview?.interviewerBrief).toBe(
      "Require regional durability.",
    );
    const publicDraft = JSON.parse(
      localStorage.getItem("systemforge:draft") ?? "{}",
    ) as { scenario?: ReturnType<typeof privateInterviewScenario> };
    expect(publicDraft.scenario?.interview?.interviewerBrief).toBe("");
    expect(
      publicDraft.scenario?.requirements.some(
        (requirement) => requirement.visibility === "hidden",
      ),
    ).toBe(false);
    const privateDraft = JSON.parse(
      sessionStorage.getItem("systemforge:interviewer-draft") ?? "{}",
    ) as { scenario?: ReturnType<typeof privateInterviewScenario> };
    expect(privateDraft.scenario?.interview?.interviewerBrief).toBe(
      "Require regional durability.",
    );
  });

  it("scrubs a private localStorage draft when no interviewer session exists", async () => {
    localStorage.setItem(
      "systemforge:draft",
      JSON.stringify({
        scenario: privateInterviewScenario(),
        architecture: DEFAULT_ARCHITECTURE,
      }),
    );
    sessionStorage.setItem(
      "systemforge:session",
      JSON.stringify({
        id: "4fa97132-f1f0-41b8-8657-4966154a2545",
        hostToken: "not-a-valid-host-token",
        role: "interviewer",
        revealState: "revealed",
      }),
    );

    await useLabStore.getState().hydrate();

    expect(useLabStore.getState().role).toBe("participant");
    expect(useLabStore.getState().scenario.interview?.interviewerBrief).toBe(
      "",
    );
    expect(
      useLabStore
        .getState()
        .scenario.requirements.some(
          (requirement) => requirement.visibility === "hidden",
        ),
    ).toBe(false);
    expect(
      useLabStore
        .getState()
        .scenario.requirements.some(
          (requirement) => requirement.id === "private-durability",
        ),
    ).toBe(false);
    const persisted = JSON.parse(
      localStorage.getItem("systemforge:draft") ?? "{}",
    ) as { scenario?: ReturnType<typeof privateInterviewScenario> };
    expect(persisted.scenario?.interview?.interviewerBrief).toBe("");
    expect(
      persisted.scenario?.requirements.some(
        (requirement) => requirement.visibility === "hidden",
      ),
    ).toBe(false);
    expect(sessionStorage.getItem("systemforge:interviewer-draft")).toBeNull();
    expect(sessionStorage.getItem("systemforge:session")).toBeNull();
  });

  it("restores a safe workspace instead of hydrating a malformed persisted draft", async () => {
    localStorage.setItem(
      "systemforge:draft",
      JSON.stringify({ scenario: DEFAULT_SCENARIO, architecture: {} }),
    );
    useLabStore.setState({
      architecture: {
        ...structuredClone(DEFAULT_ARCHITECTURE),
        id: "stale-architecture",
      },
      notice: null,
    });

    await useLabStore.getState().hydrate();

    expect(useLabStore.getState().architecture.id).toBe(
      DEFAULT_ARCHITECTURE.id,
    );
    expect(localStorage.getItem("systemforge:draft")).toBeNull();
    expect(useLabStore.getState().notice).toContain("restored a safe");
  });

  it("hydrates a persisted blank editor architecture", async () => {
    const blankArchitecture = {
      ...structuredClone(DEFAULT_ARCHITECTURE),
      id: "blank-persisted-editor",
      name: "Blank persisted editor",
      nodes: [],
      edges: [],
    };
    localStorage.setItem(
      "systemforge:draft",
      JSON.stringify({
        scenario: DEFAULT_SCENARIO,
        architecture: blankArchitecture,
      }),
    );

    await useLabStore.getState().hydrate();

    expect(useLabStore.getState().architecture).toEqual(blankArchitecture);
    expect(localStorage.getItem("systemforge:draft")).not.toBeNull();
  });

  it("sends interviewer credentials through the standard bearer header", async () => {
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

    const hostToken = "0e18d74a-4bef-4757-90e9-fc814b2ce77b";
    await fetchSharedScenario("scenario-id", hostToken);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/scenarios/scenario-id",
      expect.objectContaining({
        headers: {
          authorization: `Bearer ${hostToken}`,
          "content-type": "application/json",
        },
      }),
    );
  });

  it("records interview milestones and controls reveal state through bounded session routes", async () => {
    const shared = {
      id: "4fa97132-f1f0-41b8-8657-4966154a2545",
      scenario: DEFAULT_SCENARIO,
      architecture: DEFAULT_ARCHITECTURE,
      role: "participant" as const,
      revealState: "revealed" as const,
    };
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(shared), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const runId = "2f4536f2-4fbb-45ba-ab4d-5cbc864d8419";
    await expect(recordSharedScenarioRun(shared.id, runId)).resolves.toEqual(
      shared,
    );
    await expect(
      setSharedScenarioReveal(
        shared.id,
        "0e18d74a-4bef-4757-90e9-fc814b2ce77b",
        true,
      ),
    ).resolves.toEqual(shared);
    await expect(
      updateInterviewCollaboration(
        shared.id,
        { interviewerNotes: "Private notes" },
        "0e18d74a-4bef-4757-90e9-fc814b2ce77b",
      ),
    ).resolves.toEqual(shared);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/scenarios/${shared.id}/runs`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ runId }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/scenarios/${shared.id}/reveal`,
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          authorization: "Bearer 0e18d74a-4bef-4757-90e9-fc814b2ce77b",
        }),
        body: JSON.stringify({ revealed: true }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `/api/scenarios/${shared.id}/collaboration`,
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          authorization: "Bearer 0e18d74a-4bef-4757-90e9-fc814b2ce77b",
        }),
        body: JSON.stringify({ interviewerNotes: "Private notes" }),
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

  it("posts a versioned canonical solver request", async () => {
    const receipt = {
      execution: "canonical",
      result: { engineVersion: "0.7.0", solverVersion: "0.1.0" },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(receipt), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      solveCanonicalArchitecture(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
        maxCandidates: 4,
      }),
    ).resolves.toEqual(receipt);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/solve",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          scenario: DEFAULT_SCENARIO,
          architecture: DEFAULT_ARCHITECTURE,
          clientEngineVersion: ENGINE_VERSION,
          options: { maxCandidates: 4 },
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

  it("tells a stale browser to refresh while preserving local simulation", async () => {
    useLabStore.setState({ apiAvailability: "online", notice: null });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "engine_version_mismatch",
              message: "Refresh the application before retrying.",
              localModeAvailable: true,
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await useLabStore.getState().submitCanonical();

    expect(useLabStore.getState().apiAvailability).toBe("offline");
    expect(useLabStore.getState().notice).toMatch(/refresh.*runs locally/i);
  });

  it("follows an accepted canonical run through completion", async () => {
    useLabStore.setState({
      scenario: structuredClone(DEFAULT_SCENARIO),
      architecture: structuredClone(DEFAULT_ARCHITECTURE),
      apiAvailability: "online",
      canonicalRunId: null,
      canonicalRunStatus: "idle",
      canonicalRunDigest: null,
      notice: null,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "58f4dbdf-d1d7-49dd-a80d-ec96f4323c16",
            status: "queued",
            statusUrl:
              "https://systemforge.elfeel.me/api/runs/58f4dbdf-d1d7-49dd-a80d-ec96f4323c16",
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "58f4dbdf-d1d7-49dd-a80d-ec96f4323c16",
            status: "completed",
            digest: "a".repeat(64),
            result: { engineVersion: "0.7.0", digest: "a".repeat(64) },
            createdAt: "2026-08-08T00:00:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await useLabStore.getState().submitCanonical();

    expect(useLabStore.getState()).toMatchObject({
      canonicalRunStatus: "completed",
      canonicalRunDigest: "a".repeat(64),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/runs/58f4dbdf-d1d7-49dd-a80d-ec96f4323c16",
      expect.any(Object),
    );
  });
});
