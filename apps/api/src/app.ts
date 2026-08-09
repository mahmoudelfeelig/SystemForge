import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  analyzeTopologyExecutionBounds,
  architectureSchema,
  candidateScenario,
  estimateSimulationExecutionWorkUnits,
  estimateSimulationOutputMetricCells,
  estimateSimulationResultBytes,
  MAX_TOPOLOGY_FANOUT_AMPLIFICATION,
  MAX_SIMULATION_OUTPUT_METRIC_CELLS,
  MAX_SIMULATION_ESTIMATED_RESULT_BYTES,
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
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z, ZodError } from "zod";
import { compileAiRequirements, compileAiScenario } from "./aiCompilation";
import {
  AiRequestError,
  conductAiInterviewTurn,
  debriefCanonicalRun,
} from "./aiDebrief";
import {
  AiProviderError,
  CLOUDFLARE_AI_RESERVED_COST_CENTS_PER_REQUEST,
  MAX_AI_DAILY_REQUESTS,
  MAX_AI_MONTHLY_RESERVED_COST_CENTS,
  MAX_AI_TIMEOUT_MS,
  type AiProvider,
} from "./aiProvider";
import type { ApiConfig } from "./config";
import { runSolverInThread, type SolverRunner } from "./runSolverInThread";
import {
  AiUsageBudgetExceededError,
  QueueCapacityError,
  SharedScenarioCapacityError,
  type ControlStore,
} from "./store";
import { runMatchesSharedScenario } from "./sharedScenarioBinding";

export type { SolverRunner } from "./runSolverInThread";

export const API_REQUEST_TIMEOUT_MS = MAX_AI_TIMEOUT_MS + 6_000;
export const API_CONNECTION_TIMEOUT_MS = MAX_AI_TIMEOUT_MS + 6_000;

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

const scenarioRunMilestoneSchema = z.object({ runId: z.uuid() }).strict();

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
  collaboration: record.collaboration,
});

const participantCollaborationSchema = z
  .object({
    candidateNotes: z.string().max(4_000).optional(),
    candidateCursor: z.string().max(120).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0);

const hostCollaborationSchema = z
  .object({
    candidateNotes: z.string().max(4_000).optional(),
    candidateCursor: z.string().max(120).optional(),
    interviewerNotes: z.string().max(4_000).optional(),
    clockAction: z.enum(["start", "reset"]).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0);

const hostTokenSchema = z.string().uuid();

const interviewerBearerToken = (
  authorization: string | undefined,
): string | undefined => {
  if (!authorization) return undefined;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) return undefined;
  const parsed = hostTokenSchema.safeParse(match[1]);
  return parsed.success ? parsed.data : undefined;
};

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

interface AiDisconnectRequest {
  raw: {
    aborted: boolean;
    once(event: "aborted", listener: () => void): unknown;
    off(event: "aborted", listener: () => void): unknown;
  };
  socket: { destroyed: boolean };
}

interface AiDisconnectReply {
  raw: {
    once(event: "close", listener: () => void): unknown;
    off(event: "close", listener: () => void): unknown;
  };
}

export const bindAiDisconnectAbort = (
  request: AiDisconnectRequest,
  reply: AiDisconnectReply,
  controller: AbortController,
): (() => void) => {
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  if (request.raw.aborted || request.socket.destroyed) abort();
  return () => {
    request.raw.off("aborted", abort);
    reply.raw.off("close", abort);
  };
};

export async function buildApp(
  config: ApiConfig,
  store: ControlStore,
  solve: SolverRunner = runSolverInThread,
  aiProvider: AiProvider | null = null,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    trustProxy: config.trustProxy,
    bodyLimit: 1_048_576,
    requestTimeout: API_REQUEST_TIMEOUT_MS,
    connectionTimeout: API_CONNECTION_TIMEOUT_MS,
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
  let concurrentAiRequests = 0;
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

  app.get("/api/ai/capabilities", { config: { rateLimit: false } }, () => ({
    contractVersion: 1 as const,
    enabled: aiProvider !== null,
    tasks: [
      "compile-requirements",
      "author-scenario",
      "debrief-run",
      "conduct-interview",
    ] as const,
    provider: aiProvider ? { id: aiProvider.evidence.id } : null,
    boundaries: [
      "AI output is advisory and schema-validated before it reaches the interface.",
      "Drafts require explicit review and apply actions.",
      "Debriefs cite deterministic modeled evidence and are not production telemetry.",
      "Candidate interview prompts exclude private rubric fields.",
      "AI cannot execute, score, or replace deterministic simulation physics.",
    ],
  }));

  const executeAiRequest = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    operation: (provider: AiProvider, signal: AbortSignal) => Promise<T>,
  ): Promise<T | FastifyReply> => {
    if (!aiProvider)
      return reply
        .code(503)
        .send(
          errorBody(
            "ai_unavailable",
            "Optional AI assistance is not configured. Manual authoring and deterministic local simulation remain available.",
            request.id,
          ),
        );
    if (concurrentAiRequests >= 1) {
      reply.header("retry-after", "2");
      return reply
        .code(503)
        .send(
          errorBody(
            "ai_capacity_exceeded",
            "The bounded AI assistance slot is busy. Continue manually or retry in a moment.",
            request.id,
            2,
          ),
        );
    }
    concurrentAiRequests += 1;
    const controller = new AbortController();
    const releaseDisconnectAbort = bindAiDisconnectAbort(
      request,
      reply,
      controller,
    );
    const budgetedProvider: AiProvider = {
      evidence: aiProvider.evidence,
      reservedCostCents: aiProvider.reservedCostCents,
      async generateStructured(providerRequest, signal) {
        await store.reserveAiUsage({
          providerId: aiProvider.evidence.id,
          model: aiProvider.evidence.model,
          reservedCostCents:
            aiProvider.reservedCostCents ??
            CLOUDFLARE_AI_RESERVED_COST_CENTS_PER_REQUEST,
          maximumDailyRequests: MAX_AI_DAILY_REQUESTS,
          maximumMonthlyCostCents: MAX_AI_MONTHLY_RESERVED_COST_CENTS,
        });
        return aiProvider.generateStructured(providerRequest, signal);
      },
    };
    try {
      try {
        if (request.raw.aborted || request.socket.destroyed) controller.abort();
        return await operation(budgetedProvider, controller.signal);
      } catch (error) {
        if (!(error instanceof AiUsageBudgetExceededError)) throw error;
        reply.header("retry-after", String(error.retryAfterSeconds));
        return reply
          .code(429)
          .send(
            errorBody(
              "ai_budget_exhausted",
              "The bounded AI request or spending budget is exhausted. Manual authoring and deterministic local simulation remain available.",
              request.id,
              error.retryAfterSeconds,
            ),
          );
      }
    } finally {
      concurrentAiRequests = Math.max(0, concurrentAiRequests - 1);
      releaseDisconnectAbort();
    }
  };

  app.post(
    "/api/ai/compile/requirements",
    { config: { rateLimit: { max: 6, timeWindow: "10 minutes" } } },
    (request, reply) =>
      executeAiRequest(request, reply, (provider, signal) =>
        compileAiRequirements(provider, request.body, signal),
      ),
  );

  app.post(
    "/api/ai/compile/scenario",
    { config: { rateLimit: { max: 4, timeWindow: "10 minutes" } } },
    (request, reply) =>
      executeAiRequest(request, reply, (provider, signal) =>
        compileAiScenario(provider, request.body, signal),
      ),
  );

  app.post(
    "/api/ai/debrief",
    { config: { rateLimit: { max: 3, timeWindow: "10 minutes" } } },
    (request, reply) => {
      const hostToken = interviewerBearerToken(request.headers.authorization);
      return executeAiRequest(request, reply, (provider, signal) =>
        debriefCanonicalRun(provider, store, request.body, hostToken, signal),
      );
    },
  );

  app.post(
    "/api/ai/interview",
    { config: { rateLimit: { max: 6, timeWindow: "10 minutes" } } },
    (request, reply) =>
      executeAiRequest(request, reply, (provider, signal) =>
        conductAiInterviewTurn(provider, request.body, signal),
      ),
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
      const topologyBounds = analyzeTopologyExecutionBounds(
        submission.architecture,
      );
      if (topologyBounds.reachableCycleNodeIds.length > 0)
        return reply
          .code(422)
          .send(
            errorBody(
              "canonical_topology_cycle",
              `Canonical runs reject reachable feedback cycles. Remove the cycle through ${topologyBounds.reachableCycleNodeIds.join(", ")} and retry.`,
              request.id,
            ),
          );
      if (
        !Number.isFinite(topologyBounds.fanoutAmplification) ||
        topologyBounds.fanoutAmplification > MAX_TOPOLOGY_FANOUT_AMPLIFICATION
      )
        return reply
          .code(422)
          .send(
            errorBody(
              "canonical_topology_amplification",
              `Canonical runs reject synchronous fan-out above ${MAX_TOPOLOGY_FANOUT_AMPLIFICATION.toLocaleString("en-US")}. Partition the route or set complete traffic shares and retry.`,
              request.id,
            ),
          );
      const canonicalWorkUnits = estimateSimulationExecutionWorkUnits(
        submission.scenario,
        submission.architecture,
      );
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
      const canonicalOutputMetricCells = estimateSimulationOutputMetricCells(
        submission.scenario,
        submission.architecture,
      );
      if (canonicalOutputMetricCells > MAX_SIMULATION_OUTPUT_METRIC_CELLS)
        return reply
          .code(422)
          .send(
            errorBody(
              "canonical_result_too_large",
              `This model would emit ${canonicalOutputMetricCells.toLocaleString("en-US")} frame-metric cells, above the canonical ${MAX_SIMULATION_OUTPUT_METRIC_CELLS.toLocaleString("en-US")} result-size limit. Reduce duration or topology size.`,
              request.id,
            ),
          );
      const canonicalEstimatedResultBytes = estimateSimulationResultBytes(
        submission.scenario,
        submission.architecture,
      );
      if (canonicalEstimatedResultBytes > MAX_SIMULATION_ESTIMATED_RESULT_BYTES)
        return reply
          .code(422)
          .send(
            errorBody(
              "canonical_result_bytes_too_large",
              `This model's estimated ${canonicalEstimatedResultBytes.toLocaleString("en-US")}-byte result exceeds the canonical ${MAX_SIMULATION_ESTIMATED_RESULT_BYTES.toLocaleString("en-US")}-byte retention limit. Reduce duration or topology size.`,
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
      const solveTopologyBounds = analyzeTopologyExecutionBounds(
        body.architecture,
      );
      if (
        solveTopologyBounds.reachableCycleNodeIds.length > 0 ||
        !Number.isFinite(solveTopologyBounds.fanoutAmplification) ||
        solveTopologyBounds.fanoutAmplification >
          MAX_TOPOLOGY_FANOUT_AMPLIFICATION
      )
        return reply
          .code(422)
          .send(
            errorBody(
              "solver_invalid_topology",
              "Canonical solving requires an acyclic topology within the synchronous fan-out safety limit.",
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
      const baselineWorkUnits = estimateSolverWorkUnits(
        body.scenario,
        body.architecture,
        0,
      );
      if (baselineWorkUnits > config.maxSolverWorkUnits)
        return reply
          .code(422)
          .send(
            errorBody(
              "solver_workload_too_large",
              `The baseline requires ${Math.ceil(baselineWorkUnits).toLocaleString("en-US")} estimated work units, above the canonical ${config.maxSolverWorkUnits.toLocaleString("en-US")} limit. Reduce duration or topology size, or solve locally.`,
              request.id,
            ),
          );
      const solverOutputMetricCells = estimateSimulationOutputMetricCells(
        body.scenario,
        body.architecture,
      );
      if (solverOutputMetricCells > MAX_SIMULATION_OUTPUT_METRIC_CELLS)
        return reply
          .code(422)
          .send(
            errorBody(
              "solver_result_shape_too_large",
              `Each candidate would emit ${solverOutputMetricCells.toLocaleString("en-US")} frame-metric cells, above the canonical ${MAX_SIMULATION_OUTPUT_METRIC_CELLS.toLocaleString("en-US")} result-size limit. Reduce duration or topology size.`,
              request.id,
            ),
          );
      const solverEstimatedResultBytes = estimateSimulationResultBytes(
        body.scenario,
        body.architecture,
      );
      if (solverEstimatedResultBytes > MAX_SIMULATION_ESTIMATED_RESULT_BYTES)
        return reply
          .code(422)
          .send(
            errorBody(
              "solver_result_bytes_too_large",
              `Each candidate's estimated ${solverEstimatedResultBytes.toLocaleString("en-US")}-byte result exceeds the canonical ${MAX_SIMULATION_ESTIMATED_RESULT_BYTES.toLocaleString("en-US")}-byte retention limit. Reduce duration or topology size.`,
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
    return {
      ...run,
      ...(run.result
        ? {
            result: {
              engineVersion: run.result.engineVersion,
              ...(run.digest ? { digest: run.digest } : {}),
            },
          }
        : {}),
    };
  });

  app.post(
    "/api/scenarios",
    {
      config: {
        rateLimit: {
          max: config.scenarioRateLimitMax,
          timeWindow: config.scenarioRateLimitWindow,
        },
      },
    },
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
    const hostToken = interviewerBearerToken(request.headers.authorization);
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
      const { runId } = scenarioRunMilestoneSchema.parse(request.body);
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
      const run = await store.getRun(runId);
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
      if (run.status !== "completed")
        return reply
          .code(409)
          .send(
            errorBody(
              "run_not_completed",
              "The interview milestone requires a completed server run.",
              request.id,
            ),
          );
      const runSubmission = await store.getRunSubmission(runId);
      if (
        !runSubmission ||
        runSubmission.sharedScenarioId !== id ||
        !runMatchesSharedScenario(runSubmission.scenario, current.scenario)
      )
        return reply
          .code(409)
          .send(
            errorBody(
              "run_scenario_mismatch",
              "The completed server run was not submitted for this shared interview scenario.",
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
    "/api/scenarios/:id/collaboration",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const hostToken = interviewerBearerToken(request.headers.authorization);
      const current = await store.getScenario(id, hostToken);
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
              "Collaboration state only applies to interview sessions.",
              request.id,
            ),
          );
      const patch = current.isHost
        ? hostCollaborationSchema.parse(request.body)
        : participantCollaborationSchema.parse(request.body);
      const updated = await store.updateScenarioCollaboration(
        id,
        hostToken,
        patch,
      );
      if (!updated)
        return reply
          .code(404)
          .send(
            errorBody(
              "scenario_not_found",
              "This shared scenario does not exist or has expired.",
              request.id,
            ),
          );
      return sharedScenarioResponse(updated);
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
      const hostToken = interviewerBearerToken(request.headers.authorization);
      if (!hostToken)
        return reply
          .code(404)
          .send(
            errorBody(
              "scenario_not_found",
              "This shared scenario does not exist or has expired.",
              request.id,
            ),
          );
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
    if (error instanceof AiRequestError)
      return reply
        .code(error.statusCode)
        .send(errorBody(error.code, error.message, request.id));
    if (error instanceof AiProviderError) {
      const status =
        error.code === "ai_output_rejected"
          ? 502
          : error.code === "ai_request_cancelled"
            ? 499
            : 503;
      if (status === 503) reply.header("retry-after", "15");
      return reply
        .code(status)
        .send(
          errorBody(
            error.code,
            error.message,
            request.id,
            status === 503 ? 15 : undefined,
          ),
        );
    }
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
