import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  ENGINE_VERSION,
} from "@systemforge/sim-core";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import type { ApiConfig } from "../src/config";
import { MemoryControlStore } from "../src/memoryStore";

const config: ApiConfig = {
  port: 8080,
  host: "127.0.0.1",
  databaseUrl: "postgres://unused",
  publicOrigin: "https://systemforge.elfeel.me",
  trustProxy: false,
  maxQueuedRuns: 1,
  maxStoredRuns: 100,
  maxSharedScenarios: 100,
  maxCanonicalWorkUnits: 30_000,
  maxConcurrentRequests: 8,
  maxConcurrentSolves: 1,
  maxSolverCandidates: 12,
  maxSolverWorkUnits: 120_000,
  solverTimeoutMs: 10_000,
  maxSolverResultBytes: 4_000_000,
  rateLimitMax: 100,
  rateLimitWindow: "1 minute",
};

const submission = {
  scenario: DEFAULT_SCENARIO,
  architecture: DEFAULT_ARCHITECTURE,
  clientEngineVersion: ENGINE_VERSION,
};
let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

describe("control-plane API", () => {
  it("keeps liveness available while readiness reports a local-mode fallback", async () => {
    const store = new MemoryControlStore();
    store.available = false;
    app = await buildApp(config, store);
    const live = await app.inject({ method: "GET", url: "/api/health/live" });
    const ready = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json().error.localModeAvailable).toBe(true);
  });

  it("coalesces readiness probes so public health traffic cannot amplify database work", async () => {
    const store = new MemoryControlStore();
    const ready = vi.spyOn(store, "ready");
    app = await buildApp(config, store);
    const responses = await Promise.all(
      Array.from({ length: 40 }, () =>
        app!.inject({ method: "GET", url: "/api/health/ready" }),
      ),
    );
    expect(responses.every((response) => response.statusCode === 200)).toBe(
      true,
    );
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("accepts bounded canonical jobs and rejects overflow without breaking local mode", async () => {
    app = await buildApp(config, new MemoryControlStore());
    const accepted = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: submission,
    });
    const overflow = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: submission,
    });
    expect(accepted.statusCode).toBe(202);
    expect(overflow.statusCode).toBe(429);
    expect(overflow.headers["retry-after"]).toBe("30");
    expect(overflow.json()).toMatchObject({
      error: { code: "canonical_capacity_exceeded", localModeAvailable: true },
    });
  });

  it("rejects stale browser engines before queueing incomparable canonical work", async () => {
    const store = new MemoryControlStore();
    app = await buildApp(config, store);

    const response = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { ...submission, clientEngineVersion: "0.2.0" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "engine_version_mismatch",
        localModeAvailable: true,
      },
    });
    expect(store.runs.size).toBe(0);
  });

  it("evicts the oldest terminal result before durable run storage can grow without bound", async () => {
    const store = new MemoryControlStore();
    const oldId = crypto.randomUUID();
    store.runs.set(oldId, {
      id: oldId,
      status: "completed",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    app = await buildApp(
      { ...config, maxQueuedRuns: 2, maxStoredRuns: 1 },
      store,
    );

    const accepted = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: submission,
    });

    expect(accepted.statusCode).toBe(202);
    expect(store.runs.has(oldId)).toBe(false);
    expect(store.runs.size).toBe(1);
  });

  it("fails locally when the durable run ceiling is occupied by active work", async () => {
    const store = new MemoryControlStore();
    const runningId = crypto.randomUUID();
    store.runs.set(runningId, {
      id: runningId,
      status: "running",
      createdAt: "2026-08-08T00:00:00.000Z",
    });
    app = await buildApp(
      { ...config, maxQueuedRuns: 2, maxStoredRuns: 1 },
      store,
    );

    const rejected = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: submission,
    });

    expect(rejected.statusCode).toBe(429);
    expect(rejected.json()).toMatchObject({
      error: { code: "canonical_capacity_exceeded", localModeAvailable: true },
    });
  });

  it("rejects canonical result amplification while preserving the local path", async () => {
    app = await buildApp(
      { ...config, maxCanonicalWorkUnits: 1_000 },
      new MemoryControlStore(),
    );
    const oversized = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: submission,
    });

    expect(oversized.statusCode).toBe(422);
    expect(oversized.json()).toMatchObject({
      error: {
        code: "canonical_workload_too_large",
        localModeAvailable: true,
      },
    });
  });

  it("bounds durable scenario sharing independently from local links", async () => {
    app = await buildApp(
      { ...config, maxSharedScenarios: 1 },
      new MemoryControlStore(),
    );
    const payload = {
      scenario: DEFAULT_SCENARIO,
      architecture: DEFAULT_ARCHITECTURE,
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/scenarios",
      payload,
    });
    const overflow = await app.inject({
      method: "POST",
      url: "/api/scenarios",
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(overflow.statusCode).toBe(429);
    expect(overflow.headers["retry-after"]).toBe("60");
    expect(overflow.json()).toMatchObject({
      error: {
        code: "scenario_capacity_exceeded",
        localModeAvailable: true,
      },
    });
  });

  it("never discloses hidden interviewer requirements through the candidate endpoint", async () => {
    const interviewScenario = {
      ...structuredClone(DEFAULT_SCENARIO),
      mode: "interview" as const,
      interview: {
        candidateBrief:
          "Design a checkout service and ask clarifying questions.",
        interviewerBrief: "Look for durability reasoning.",
        timeboxMinutes: 45,
        allowCandidateRequirements: true,
        revealPolicy: "interviewer-controlled" as const,
      },
      requirements: DEFAULT_SCENARIO.requirements.map((requirement, index) =>
        index === 0
          ? {
              ...requirement,
              visibility: "hidden" as const,
              owner: "interviewer" as const,
            }
          : requirement,
      ),
    };
    app = await buildApp(config, new MemoryControlStore());
    const shared = await app.inject({
      method: "POST",
      url: "/api/scenarios",
      payload: {
        scenario: interviewScenario,
        architecture: DEFAULT_ARCHITECTURE,
      },
    });
    expect(shared.statusCode).toBe(201);
    expect(shared.json()).not.toHaveProperty("hostToken");
    expect(shared.json().interviewerUrl).toContain("#hostToken=");
    const hostToken = decodeURIComponent(
      new URL(shared.json().interviewerUrl).hash.replace("#hostToken=", ""),
    );
    const candidate = await app.inject({
      method: "GET",
      url: `/api/scenarios/${shared.json().id}`,
    });
    expect(candidate.statusCode).toBe(200);
    expect(candidate.json().scenario.interview.interviewerBrief).toBe("");
    expect(
      candidate
        .json()
        .scenario.requirements.some(
          (requirement: { visibility: string }) =>
            requirement.visibility === "hidden",
        ),
    ).toBe(false);

    const leakedQueryCredential = await app.inject({
      method: "GET",
      url: `/api/scenarios/${shared.json().id}?hostToken=${encodeURIComponent(hostToken)}`,
    });
    expect(leakedQueryCredential.json().role).toBe("participant");

    const interviewer = await app.inject({
      method: "GET",
      url: `/api/scenarios/${shared.json().id}`,
      headers: { "x-systemforge-host-token": hostToken },
    });
    expect(interviewer.json().role).toBe("interviewer");
    expect(interviewer.json().scenario.interview.interviewerBrief).toBe(
      "Look for durability reasoning.",
    );
  });

  it("reveals hidden criteria only after the first run when the interview policy allows it", async () => {
    const interviewScenario = {
      ...structuredClone(DEFAULT_SCENARIO),
      mode: "interview" as const,
      interview: {
        candidateBrief: "Design the service.",
        interviewerBrief: "Require zero acknowledged-write loss.",
        timeboxMinutes: 45,
        allowCandidateRequirements: true,
        revealPolicy: "after-run" as const,
      },
      requirements: [
        {
          ...structuredClone(DEFAULT_SCENARIO.requirements[0]!),
          id: "hidden-durability",
          visibility: "hidden" as const,
          owner: "interviewer" as const,
        },
      ],
    };
    app = await buildApp(config, new MemoryControlStore());
    const shared = await app.inject({
      method: "POST",
      url: "/api/scenarios",
      payload: {
        scenario: interviewScenario,
        architecture: DEFAULT_ARCHITECTURE,
      },
    });
    const id = shared.json().id as string;

    const before = await app.inject({
      method: "GET",
      url: `/api/scenarios/${id}`,
    });
    expect(before.json().revealState).toBe("hidden");
    expect(before.json().scenario.requirements).toHaveLength(0);

    const milestone = await app.inject({
      method: "POST",
      url: `/api/scenarios/${id}/runs`,
    });
    expect(milestone.statusCode).toBe(200);
    expect(milestone.json().revealState).toBe("revealed");
    expect(milestone.json().scenario.requirements[0]).toMatchObject({
      id: "hidden-durability",
      visibility: "public",
    });
    expect(milestone.json().scenario.interview.interviewerBrief).toBe("");
  });

  it("requires the interviewer bearer credential for controlled reveals", async () => {
    const interviewScenario = {
      ...structuredClone(DEFAULT_SCENARIO),
      mode: "interview" as const,
      interview: {
        candidateBrief: "Design the service.",
        interviewerBrief: "Private rubric.",
        timeboxMinutes: 45,
        allowCandidateRequirements: true,
        revealPolicy: "interviewer-controlled" as const,
      },
      requirements: DEFAULT_SCENARIO.requirements.map((requirement) => ({
        ...requirement,
        visibility: "hidden" as const,
        owner: "interviewer" as const,
      })),
    };
    app = await buildApp(config, new MemoryControlStore());
    const shared = await app.inject({
      method: "POST",
      url: "/api/scenarios",
      payload: {
        scenario: interviewScenario,
        architecture: DEFAULT_ARCHITECTURE,
      },
    });
    const id = shared.json().id as string;
    const hostToken = decodeURIComponent(
      new URL(shared.json().interviewerUrl).hash.replace("#hostToken=", ""),
    );

    const denied = await app.inject({
      method: "PATCH",
      url: `/api/scenarios/${id}/reveal`,
      headers: { "x-systemforge-host-token": crypto.randomUUID() },
      payload: { revealed: true },
    });
    expect(denied.statusCode).toBe(404);

    const revealed = await app.inject({
      method: "PATCH",
      url: `/api/scenarios/${id}/reveal`,
      headers: { "x-systemforge-host-token": hostToken },
      payload: { revealed: true },
    });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json().role).toBe("interviewer");
    expect(revealed.json().revealState).toBe("revealed");

    const candidate = await app.inject({
      method: "GET",
      url: `/api/scenarios/${id}`,
    });
    expect(candidate.json().revealState).toBe("revealed");
    expect(candidate.json().scenario.requirements).toHaveLength(
      interviewScenario.requirements.length,
    );
    expect(candidate.json().scenario.interview.interviewerBrief).toBe("");
  });

  it("supports a privacy-separated collaborative interview journal and clock", async () => {
    const interviewScenario = {
      ...structuredClone(DEFAULT_SCENARIO),
      mode: "interview" as const,
      interview: {
        candidateBrief: "Design the service.",
        interviewerBrief: "Private scoring notes.",
        timeboxMinutes: 45,
        allowCandidateRequirements: true,
        revealPolicy: "interviewer-controlled" as const,
      },
      requirements: DEFAULT_SCENARIO.requirements.map((requirement) => ({
        ...requirement,
        visibility: "hidden" as const,
        owner: "interviewer" as const,
      })),
    };
    app = await buildApp(config, new MemoryControlStore());
    const shared = await app.inject({
      method: "POST",
      url: "/api/scenarios",
      payload: {
        scenario: interviewScenario,
        architecture: DEFAULT_ARCHITECTURE,
      },
    });
    const id = shared.json().id as string;
    const hostToken = decodeURIComponent(
      new URL(shared.json().interviewerUrl).hash.replace("#hostToken=", ""),
    );

    const candidateUpdate = await app.inject({
      method: "PATCH",
      url: `/api/scenarios/${id}/collaboration`,
      payload: {
        candidateNotes: "Need to clarify ordering and durability.",
        candidateCursor: "Investigating storage",
      },
    });
    expect(candidateUpdate.statusCode).toBe(200);
    expect(candidateUpdate.json().collaboration).toMatchObject({
      candidateNotes: "Need to clarify ordering and durability.",
      candidateCursor: "Investigating storage",
    });
    expect(candidateUpdate.json().collaboration).not.toHaveProperty(
      "interviewerNotes",
    );

    const hostUpdate = await app.inject({
      method: "PATCH",
      url: `/api/scenarios/${id}/collaboration`,
      headers: { "x-systemforge-host-token": hostToken },
      payload: {
        interviewerNotes: "Candidate found durability before scaling.",
        clockAction: "start",
      },
    });
    expect(hostUpdate.statusCode).toBe(200);
    expect(hostUpdate.json().collaboration.interviewerNotes).toContain(
      "found durability",
    );
    expect(hostUpdate.json().collaboration.startedAt).toBeTruthy();

    const candidate = await app.inject({
      method: "GET",
      url: `/api/scenarios/${id}`,
    });
    expect(candidate.json().collaboration.startedAt).toBeTruthy();
    expect(candidate.json().collaboration).not.toHaveProperty(
      "interviewerNotes",
    );

    const deniedPrivateWrite = await app.inject({
      method: "PATCH",
      url: `/api/scenarios/${id}/collaboration`,
      payload: { interviewerNotes: "attempted overwrite" },
    });
    expect(deniedPrivateWrite.statusCode).toBe(400);
  });

  it("keeps never-reveal interviews private after candidate runs", async () => {
    const interviewScenario = {
      ...structuredClone(DEFAULT_SCENARIO),
      mode: "interview" as const,
      interview: {
        candidateBrief: "Design the service.",
        interviewerBrief: "Private rubric.",
        timeboxMinutes: 45,
        allowCandidateRequirements: true,
        revealPolicy: "never" as const,
      },
      requirements: DEFAULT_SCENARIO.requirements.map((requirement) => ({
        ...requirement,
        visibility: "hidden" as const,
        owner: "interviewer" as const,
      })),
    };
    app = await buildApp(config, new MemoryControlStore());
    const shared = await app.inject({
      method: "POST",
      url: "/api/scenarios",
      payload: {
        scenario: interviewScenario,
        architecture: DEFAULT_ARCHITECTURE,
      },
    });
    const milestone = await app.inject({
      method: "POST",
      url: `/api/scenarios/${shared.json().id}/runs`,
    });

    expect(milestone.json().revealState).toBe("hidden");
    expect(milestone.json().scenario.requirements).toHaveLength(0);
  });

  it("fails closed on oversized or invalid run submissions", async () => {
    app = await buildApp(config, new MemoryControlStore());
    const invalid = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { scenario: { title: "invalid" } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("invalid_request");

    const oversized = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { padding: "x".repeat(1_048_576) },
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({
      error: { code: "payload_too_large", localModeAvailable: true },
    });
  });

  it("rate limits abusive clients with retry guidance and local fallback", async () => {
    app = await buildApp(
      { ...config, rateLimitMax: 2 },
      new MemoryControlStore(),
    );
    const id = crypto.randomUUID();
    await app.inject({ method: "GET", url: `/api/runs/${id}` });
    await app.inject({ method: "GET", url: `/api/runs/${id}` });
    const limited = await app.inject({
      method: "GET",
      url: `/api/runs/${id}`,
    });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.json()).toMatchObject({
      error: { code: "rate_limited", localModeAvailable: true },
    });
  });

  it("does not let direct clients rotate spoofable Cloudflare headers around the rate limit", async () => {
    app = await buildApp(
      { ...config, trustProxy: false, rateLimitMax: 2 },
      new MemoryControlStore(),
    );
    const id = crypto.randomUUID();
    for (const address of ["198.51.100.10", "198.51.100.11"]) {
      await app.inject({
        method: "GET",
        url: `/api/runs/${id}`,
        headers: { "cf-connecting-ip": address },
      });
    }
    const limited = await app.inject({
      method: "GET",
      url: `/api/runs/${id}`,
      headers: { "cf-connecting-ip": "198.51.100.12" },
    });

    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      error: { code: "rate_limited", localModeAvailable: true },
    });
  });

  it("uses the proxy-normalized visitor address for independent production rate limits", async () => {
    app = await buildApp(
      { ...config, trustProxy: true, rateLimitMax: 2 },
      new MemoryControlStore(),
    );
    const id = crypto.randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await app.inject({
        method: "GET",
        url: `/api/runs/${id}`,
        headers: { "x-forwarded-for": "198.51.100.20" },
      });
    }
    const independent = await app.inject({
      method: "GET",
      url: `/api/runs/${id}`,
      headers: { "x-forwarded-for": "198.51.100.21" },
    });
    const limited = await app.inject({
      method: "GET",
      url: `/api/runs/${id}`,
      headers: { "x-forwarded-for": "198.51.100.20" },
    });

    expect(independent.statusCode).toBe(404);
    expect(limited.statusCode).toBe(429);
  });

  it("returns a bounded local-mode response when concurrent admission is full", async () => {
    let release!: () => void;
    const store = new MemoryControlStore();
    const queueRun = vi.spyOn(store, "queueRun").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              id: crypto.randomUUID(),
              status: "queued",
              createdAt: new Date().toISOString(),
            });
        }),
    );
    app = await buildApp({ ...config, maxConcurrentRequests: 1 }, store);
    const admitted = app.inject({
      method: "POST",
      url: "/api/runs",
      payload: submission,
    });
    await vi.waitFor(() => expect(queueRun).toHaveBeenCalledTimes(1));
    const rejected = await app.inject({
      method: "GET",
      url: `/api/runs/${crypto.randomUUID()}`,
    });
    expect(rejected.statusCode).toBe(503);
    expect(rejected.headers["retry-after"]).toBe("1");
    expect(rejected.json()).toMatchObject({
      error: {
        code: "request_capacity_exceeded",
        localModeAvailable: true,
      },
    });
    release();
    await admitted;
  });
});
