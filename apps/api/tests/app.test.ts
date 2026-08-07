import { afterEach, describe, expect, it } from "vitest";
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
  });
});
