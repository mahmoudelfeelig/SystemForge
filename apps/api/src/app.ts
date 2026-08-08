import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  architectureSchema,
  candidateScenario,
  runSubmissionSchema,
  scenarioSchema,
  type ApiErrorBody,
} from "@systemforge/contracts";
import {
  ENGINE_VERSION,
  estimateSolverWorkUnits,
  MAX_SOLVER_CANDIDATES,
  SOLVER_STRATEGIES,
  type SolveArchitectureOptions,
} from "@systemforge/sim-core";
import Fastify, { type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import type { ApiConfig } from "./config";
import { runSolverInThread, type SolverRunner } from "./runSolverInThread";
import {
  QueueCapacityError,
  SharedScenarioCapacityError,
  type ControlStore,
} from "./store";

export type { SolverRunner } from "./runSolverInThread";

const solverWeightsSchema = z
  .object({
    requirements: z.number().finite().nonnegative().optional(),
    resilience: z.number().finite().nonnegative().optional(),
    latency: z.number().finite().nonnegative().optional(),
    cost: z.number().finite().nonnegative().optional(),
    complexity: z.number().finite().nonnegative().optional(),
  })
  .refine(
    (weights) =>
      Object.values(weights).length === 0 ||
      Object.values(weights).some((value) => value > 0),
    "At least one solver weight must be positive.",
  );

const solverOptionsSchema = z.object({
  maxCandidates: z.number().int().min(1).max(MAX_SOLVER_CANDIDATES).optional(),
  maxChangesPerCandidate: z.union([z.literal(1), z.literal(2)]).optional(),
  allowedStrategies: z
    .array(z.enum(SOLVER_STRATEGIES))
    .min(1)
    .max(SOLVER_STRATEGIES.length)
    .optional(),
  lockedNodeIds: z.array(z.string().min(1).max(80)).max(500).optional(),
  maximumMonthlyCostEur: z.number().finite().nonnegative().optional(),
  maximumOperationalComplexity: z.number().finite().nonnegative().optional(),
  weights: solverWeightsSchema.optional(),
});

const solveRequestSchema = z.object({
  scenario: scenarioSchema,
  architecture: architectureSchema,
  clientEngineVersion: z.string().min(1).max(32),
  options: solverOptionsSchema.optional().default({}),
});

const sharedScenarioResponse = (
  record: NonNullable<Awaited<ReturnType<ControlStore["getScenario"]>>>,
) => ({
  id: record.id,
  scenario: record.isHost
    ? record.scenario
    : candidateScenario(record.scenario, record.revealState === "revealed"),
  architecture: record.architecture,
  role: record.isHost ? ("interviewer" as const) : ("participant" as const),
  revealState: record.revealState,
});

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
  solve: SolverRunner = runSolverInThread,
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
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (request, context) => ({
      statusCode: 429,
      ...errorBody(
        "rate_limited",
        "The server is receiving too many requests. Continue locally and retry canonical features later.",
        request.id,
        Math.max(1, Math.ceil(context.ttl / 1_000)),
      ),
    }),
  });

  let concurrentRequests = 0;
  let concurrentSolves = 0;
  const admittedRequests = new WeakSet<object>();
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/health/")) return;
    if (concurrentRequests >= config.maxConcurrentRequests) {
      reply.header("retry-after", "1");
      return reply
        .code(503)
        .send(
          errorBody(
            "request_capacity_exceeded",
            "Canonical request capacity is busy. Continue locally and retry in a moment.",
            request.id,
            1,
          ),
        );
    }
    concurrentRequests += 1;
    admittedRequests.add(request);
  });
  const releaseRequest = (request: object) => {
    if (!admittedRequests.delete(request)) return;
    concurrentRequests = Math.max(0, concurrentRequests - 1);
  };
  app.addHook("onResponse", (request) => {
    releaseRequest(request);
    return Promise.resolve();
  });
  app.addHook("onError", (request) => {
    releaseRequest(request);
    return Promise.resolve();
  });

  let readinessValue = false;
  let readinessCheckedAt = Number.NEGATIVE_INFINITY;
  let readinessCheck: Promise<boolean> | null = null;
  const readiness = (): Promise<boolean> => {
    const now = Date.now();
    if (now - readinessCheckedAt < 2_000)
      return Promise.resolve(readinessValue);
    if (readinessCheck) return readinessCheck;
    readinessCheck = store
      .ready()
      .then((ready) => {
        readinessValue = ready;
        readinessCheckedAt = Date.now();
        return ready;
      })
      .finally(() => {
        readinessCheck = null;
      });
    return readinessCheck;
  };

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
      const ready = await readiness();
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
      if (submission.clientEngineVersion !== ENGINE_VERSION)
        return reply
          .code(409)
          .send(
            errorBody(
              "engine_version_mismatch",
              `This browser uses simulation engine ${submission.clientEngineVersion}, while canonical runs require ${ENGINE_VERSION}. Refresh the application before retrying; local simulation remains available.`,
              request.id,
            ),
          );
      const canonicalWorkUnits =
        (submission.scenario.workload.durationSeconds + 1) *
        (submission.architecture.nodes.length +
          submission.architecture.edges.length * 0.25);
      if (canonicalWorkUnits > config.maxCanonicalWorkUnits)
        return reply
          .code(422)
          .send(
            errorBody(
              "canonical_workload_too_large",
              `This model exceeds the canonical ${config.maxCanonicalWorkUnits.toLocaleString("en-US")} work-unit budget. Run it locally or reduce duration and topology size.`,
              request.id,
            ),
          );
      const run = await store.queueRun(
        submission,
        config.maxQueuedRuns,
        config.maxStoredRuns,
      );
      return reply.code(202).send({
        id: run.id,
        status: "queued",
        statusUrl: `${config.publicOrigin}/api/runs/${run.id}`,
      });
    },
  );

  app.post(
    "/api/solve",
    { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = solveRequestSchema.parse(request.body);
      if (body.clientEngineVersion !== ENGINE_VERSION)
        return reply
          .code(409)
          .send(
            errorBody(
              "engine_version_mismatch",
              `This browser uses simulation engine ${body.clientEngineVersion}, while canonical solves require ${ENGINE_VERSION}. Refresh the application or continue with the browser-local solver.`,
              request.id,
            ),
          );
      const maxCandidates =
        body.options.maxCandidates ?? config.maxSolverCandidates;
      if (maxCandidates > config.maxSolverCandidates)
        return reply
          .code(422)
          .send(
            errorBody(
              "solver_candidate_limit_exceeded",
              `Canonical solving accepts at most ${config.maxSolverCandidates} candidates per request. Reduce the candidate count or solve locally.`,
              request.id,
            ),
          );
      const workUnits = estimateSolverWorkUnits(
        body.scenario,
        body.architecture,
        maxCandidates,
      );
      if (workUnits > config.maxSolverWorkUnits)
        return reply
          .code(422)
          .send(
            errorBody(
              "solver_workload_too_large",
              `This solve requires ${Math.ceil(workUnits).toLocaleString("en-US")} estimated work units, above the canonical ${config.maxSolverWorkUnits.toLocaleString("en-US")} limit. Reduce duration, topology size, or candidate count, or solve locally.`,
              request.id,
            ),
          );
      const knownNodeIds = new Set(
        body.architecture.nodes.map((node) => node.id),
      );
      if (
        body.options.lockedNodeIds?.some((nodeId) => !knownNodeIds.has(nodeId))
      )
        return reply
          .code(422)
          .send(
            errorBody(
              "solver_invalid_options",
              "Every locked solver node must exist in the submitted architecture.",
              request.id,
            ),
          );
      if (concurrentSolves >= config.maxConcurrentSolves) {
        reply.header("retry-after", "2");
        return reply
          .code(503)
          .send(
            errorBody(
              "solver_capacity_exceeded",
              "Canonical solver capacity is busy. Continue with the browser-local solver and retry later.",
              request.id,
              2,
            ),
          );
      }
      const options: SolveArchitectureOptions = {
        ...body.options,
        maxCandidates,
        includeHiddenRequirements: false,
        workUnitBudget: config.maxSolverWorkUnits,
      };
      concurrentSolves += 1;
      try {
        const result = await solve(
          body.scenario,
          body.architecture,
          options,
          config.solverTimeoutMs,
          config.maxSolverResultBytes,
        );
        return { execution: "canonical" as const, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("solver_result_too_large:"))
          return reply
            .code(422)
            .send(
              errorBody(
                "solver_result_too_large",
                "The canonical solver result exceeds its response safety limit. Reduce the candidate count or solve locally.",
                request.id,
              ),
            );
        throw error;
      } finally {
        concurrentSolves = Math.max(0, concurrentSolves - 1);
      }
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
        config.maxSharedScenarios,
      );
      const url = `${config.publicOrigin}/scenario/${record.id}`;
      return reply.code(201).send({
        id: record.id,
        url,
        ...(body.scenario.mode === "interview"
          ? {
              candidateUrl: url,
              interviewerUrl: `${url}#hostToken=${encodeURIComponent(record.hostToken)}`,
            }
          : {}),
      });
    },
  );

  app.get("/api/scenarios/:id", async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const hostToken = z
      .string()
      .uuid()
      .optional()
      .parse(request.headers["x-systemforge-host-token"]);
    const record = await store.getScenario(id, hostToken);
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
    return sharedScenarioResponse(record);
  });

  app.post(
    "/api/scenarios/:id/runs",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const current = await store.getScenario(id);
      if (!current)
        return reply
          .code(404)
          .send(
            errorBody(
              "scenario_not_found",
              "This shared scenario does not exist or has expired.",
              request.id,
            ),
          );
      if (current.scenario.mode !== "interview")
        return reply
          .code(409)
          .send(
            errorBody(
              "not_an_interview",
              "Run milestones only apply to interview sessions.",
              request.id,
            ),
          );
      const record = await store.markScenarioRun(id);
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
      return sharedScenarioResponse(record);
    },
  );

  app.patch(
    "/api/scenarios/:id/reveal",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const { revealed } = z
        .object({ revealed: z.boolean() })
        .parse(request.body);
      const hostToken = z
        .string()
        .uuid()
        .parse(request.headers["x-systemforge-host-token"]);
      const current = await store.getScenario(id, hostToken);
      if (!current || !current.isHost)
        return reply
          .code(404)
          .send(
            errorBody(
              "scenario_not_found",
              "This shared scenario does not exist or has expired.",
              request.id,
            ),
          );
      if (
        current.scenario.mode !== "interview" ||
        current.scenario.interview?.revealPolicy !== "interviewer-controlled"
      )
        return reply
          .code(409)
          .send(
            errorBody(
              "reveal_policy_locked",
              "This interview does not allow interviewer-controlled reveals.",
              request.id,
            ),
          );
      const record = await store.setScenarioReveal(id, hostToken, revealed);
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
      return sharedScenarioResponse(record);
    },
  );

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
    const errorStatusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    if (errorStatusCode === 429) {
      const retryAfter = Number(reply.getHeader("retry-after")) || 60;
      reply.header("retry-after", String(retryAfter));
      return reply
        .code(429)
        .send(
          errorBody(
            "rate_limited",
            "The server is receiving too many requests. Continue locally and retry canonical features later.",
            request.id,
            retryAfter,
          ),
        );
    }
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
    if (error instanceof SharedScenarioCapacityError) {
      reply.header("retry-after", String(error.retryAfterSeconds));
      return reply
        .code(429)
        .send(
          errorBody(
            "scenario_capacity_exceeded",
            error.message,
            request.id,
            error.retryAfterSeconds,
          ),
        );
    }
    if (errorStatusCode === 413)
      return reply
        .code(413)
        .send(
          errorBody(
            "payload_too_large",
            "The request exceeds the one-megabyte canonical payload limit. Local simulation remains available.",
            request.id,
          ),
        );
    request.log.error({ error }, "request failed");
    reply.header("retry-after", "15");
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
