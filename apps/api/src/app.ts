import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  architectureSchema,
  candidateScenario,
  runSubmissionSchema,
  scenarioSchema,
  type ApiErrorBody,
} from "@systemforge/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import type { ApiConfig } from "./config";
import { QueueCapacityError, type ControlStore } from "./store";

const errorBody = (
  code: string,
  message: string,
  requestId?: string,
  retryAfterSeconds?: number,
): ApiErrorBody => ({
  error: {
    code,
    message,
    ...(requestId ? { requestId } : {}),
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    localModeAvailable: true,
  },
});

export async function buildApp(
  config: ApiConfig,
  store: ControlStore,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    trustProxy: config.trustProxy,
    bodyLimit: 1_048_576,
    requestTimeout: 15_000,
    connectionTimeout: 8_000,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindow,
    hook: "onRequest",
    keyGenerator: (request) => {
      const connectingIp = request.headers["cf-connecting-ip"];
      return (
        (Array.isArray(connectingIp) ? connectingIp[0] : connectingIp) ??
        request.ip
      );
    },
    errorResponseBuilder: (request, context) =>
      errorBody(
        "rate_limited",
        "The server is receiving too many requests. Continue locally and retry canonical features later.",
        request.id,
        Math.max(1, Math.ceil(context.ttl / 1_000)),
      ),
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    return payload;
  });

  app.get("/api/health/live", { config: { rateLimit: false } }, () => ({
    status: "ok",
    service: "systemforge-api",
  }));
  app.get(
    "/api/health/ready",
    { config: { rateLimit: false } },
    async (_request, reply) => {
      const ready = await store.ready();
      if (!ready)
        return reply
          .code(503)
          .send(
            errorBody(
              "service_unavailable",
              "Canonical features are temporarily unavailable. Local simulation remains ready.",
            ),
          );
      return { status: "ready" };
    },
  );

  app.post(
    "/api/runs",
    { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const submission = runSubmissionSchema.parse(request.body);
      const run = await store.queueRun(submission, config.maxQueuedRuns);
      return reply.code(202).send({
        id: run.id,
        status: "queued",
        statusUrl: `${config.publicOrigin}/api/runs/${run.id}`,
      });
    },
  );

  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const run = await store.getRun(id);
    if (!run)
      return reply
        .code(404)
        .send(
          errorBody(
            "run_not_found",
            "This canonical run does not exist or has expired.",
            request.id,
          ),
        );
    return run;
  });

  app.post(
    "/api/scenarios",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = z
        .object({ scenario: scenarioSchema, architecture: architectureSchema })
        .parse(request.body);
      const record = await store.shareScenario(
        body.scenario,
        body.architecture,
      );
      const url = `${config.publicOrigin}/scenario/${record.id}`;
      return reply.code(201).send({
        id: record.id,
        url,
        ...(body.scenario.mode === "interview"
          ? {
              candidateUrl: `${url}?role=candidate`,
              hostToken: record.hostToken,
            }
          : {}),
      });
    },
  );

  app.get("/api/scenarios/:id", async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { hostToken } = z
      .object({ hostToken: z.string().optional() })
      .parse(request.query);
    const record = await store.getScenario(id);
    if (!record)
      return reply
        .code(404)
        .send(
          errorBody(
            "scenario_not_found",
            "This shared scenario does not exist or has expired.",
            request.id,
          ),
        );
    const isHost = hostToken === record.hostToken;
    return {
      id: record.id,
      scenario: isHost ? record.scenario : candidateScenario(record.scenario),
      architecture: record.architecture,
      role: isHost ? "interviewer" : "participant",
    };
  });

  app.setNotFoundHandler(async (request, reply) =>
    reply
      .code(404)
      .send(
        errorBody(
          "route_not_found",
          "The requested API route does not exist.",
          request.id,
        ),
      ),
  );
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ZodError)
      return reply
        .code(400)
        .send(
          errorBody(
            "invalid_request",
            "The request does not match the current SystemForge schema.",
            request.id,
          ),
        );
    if (error instanceof QueueCapacityError) {
      reply.header("retry-after", String(error.retryAfterSeconds));
      return reply
        .code(429)
        .send(
          errorBody(
            "canonical_capacity_exceeded",
            error.message,
            request.id,
            error.retryAfterSeconds,
          ),
        );
    }
    request.log.error({ error }, "request failed");
    return reply
      .code(503)
      .send(
        errorBody(
          "service_unavailable",
          "The server could not complete this request. Local simulation remains available.",
          request.id,
          15,
        ),
      );
  });

  app.addHook("onClose", async () => store.close());
  return app;
}
