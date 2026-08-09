import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import {
  AI_ASSISTANT_CONTRACT_VERSION,
  architectureSchema,
  scenarioSchema,
  type AiAssistantTask,
  type AiRequirementCompileRequest,
  type AiScenarioCompileRequest,
  type Scenario,
} from "@systemforge/contracts";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  simulate,
} from "@systemforge/sim-core";
import type { FastifyInstance } from "fastify";
import { compileAiRequirements, compileAiScenario } from "../src/aiCompilation";
import { conductAiInterviewTurn, debriefCanonicalRun } from "../src/aiDebrief";
import {
  AiProviderError,
  CLOUDFLARE_AI_RESERVED_COST_CENTS_PER_REQUEST,
  CLOUDFLARE_WORKERS_AI_MODEL,
  CloudflareWorkersAiResponsesProvider,
  MAX_AI_DAILY_REQUESTS,
  MAX_AI_MONTHLY_RESERVED_COST_CENTS,
  MAX_AI_TIMEOUT_MS,
  MIN_CLOUDFLARE_AI_TIMEOUT_MS,
  OpenAiResponsesProvider,
  createConfiguredAiProvider,
  type AiProvider,
  type AiStructuredGenerationRequest,
} from "../src/aiProvider";
import {
  API_CONNECTION_TIMEOUT_MS,
  API_REQUEST_TIMEOUT_MS,
  bindAiDisconnectAbort,
  buildApp,
} from "../src/app";
import type { ApiConfig } from "../src/config";
import { MemoryControlStore } from "../src/memoryStore";

const config: ApiConfig = {
  port: 8080,
  host: "127.0.0.1",
  databaseUrl: "postgres://unused",
  publicOrigin: "https://systemforge.elfeel.me",
  trustProxy: false,
  maxQueuedRuns: 10,
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
  scenarioRateLimitMax: 10,
  scenarioRateLimitWindow: "1 day",
};

class FakeAiProvider implements AiProvider {
  readonly evidence = {
    id: "openai-responses" as const,
    model: "test-model",
  };
  readonly reservedCostCents = CLOUDFLARE_AI_RESERVED_COST_CENTS_PER_REQUEST;
  readonly requests: AiStructuredGenerationRequest[] = [];

  constructor(
    private readonly outputs: Partial<Record<AiAssistantTask, unknown>>,
  ) {}

  generateStructured(request: AiStructuredGenerationRequest): Promise<unknown> {
    this.requests.push(structuredClone(request));
    return Promise.resolve(this.outputs[request.operation]);
  }
}

const sourceSpan = (sourceText: string, excerpt: string) => {
  const start = sourceText.indexOf(excerpt);
  if (start < 0) throw new Error(`Missing test excerpt: ${excerpt}`);
  return { start, end: start + excerpt.length, excerpt };
};

const supportedDebriefHeadline =
  "Deterministic modeled evidence selected for review";
const supportedDebriefFinding = {
  frame: "Review the cited modeled frame evidence.",
  requirement: "Review the cited modeled requirement evidence.",
  event: "Review the cited modeled event evidence.",
  trace: "Review the cited modeled trace evidence.",
  analysis: "Review the cited deterministic analysis evidence.",
} as const;

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

describe("optional AI provider boundary", () => {
  it("keeps HTTP requests open beyond the maximum provider deadline", async () => {
    app = await buildApp(config, new MemoryControlStore());

    expect(API_CONNECTION_TIMEOUT_MS).toBeGreaterThan(MAX_AI_TIMEOUT_MS);
    expect(API_REQUEST_TIMEOUT_MS).toBeGreaterThan(MAX_AI_TIMEOUT_MS);
    expect(app.initialConfig.connectionTimeout).toBe(API_CONNECTION_TIMEOUT_MS);
  });

  it("stays disabled by default and fails closed on partial configuration", () => {
    expect(createConfiguredAiProvider({})).toBeNull();
    expect(() =>
      createConfiguredAiProvider({ SYSTEMFORGE_AI_ENABLED: "true" }),
    ).toThrow(/SYSTEMFORGE_AI_PROVIDER.*SYSTEMFORGE_AI_MODEL/u);
    expect(() =>
      createConfiguredAiProvider({
        SYSTEMFORGE_AI_ENABLED: "true",
        SYSTEMFORGE_AI_PROVIDER: "cloudflare-workers-ai-responses",
        SYSTEMFORGE_AI_MODEL: "invalid model",
      }),
    ).toThrow(/provider credentials are invalid/u);
  });

  it("uses bounded Cloudflare structured chat without gateway logging, caching, or retries", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: JSON.stringify({ ok: true }) },
            },
          ],
        }),
      ),
    );
    const provider = new CloudflareWorkersAiResponsesProvider(
      "0123456789abcdef0123456789abcdef",
      "cloudflare-token",
      "systemforge-production",
      fetchImplementation,
    );

    await expect(
      provider.generateStructured({
        operation: "compile-requirements",
        schemaName: "test_schema",
        instructions: "Return the requested object.",
        input: { brief: "Keep the system bounded." },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      }),
    ).resolves.toEqual({ ok: true });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/chat/completions",
    );
    expect(init?.headers).toMatchObject({
      authorization: "Bearer cloudflare-token",
      "cf-aig-gateway-id": "systemforge-production",
      "cf-aig-collect-log": "false",
      "cf-aig-skip-cache": "true",
      "cf-aig-max-attempts": "1",
      "cf-aig-request-timeout": String(MIN_CLOUDFLARE_AI_TIMEOUT_MS - 1_000),
    });
    if (typeof init?.body !== "string")
      throw new Error("Expected a serialized provider request body.");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: CLOUDFLARE_WORKERS_AI_MODEL,
      stream: false,
      max_tokens: 2_000,
      temperature: 0,
      messages: [
        { role: "system", content: "Return the requested object." },
        {
          role: "user",
          content: JSON.stringify({ brief: "Keep the system bounded." }),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          additionalProperties: false,
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      },
    });
    expect(body.store).toBeUndefined();
    expect(body.tools).toBeUndefined();
  });

  it("requires the pinned Cloudflare model and complete server-only configuration", () => {
    const environment = {
      SYSTEMFORGE_AI_ENABLED: "true",
      SYSTEMFORGE_AI_PROVIDER: "cloudflare-workers-ai-responses",
      SYSTEMFORGE_AI_MODEL: CLOUDFLARE_WORKERS_AI_MODEL,
      CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      CLOUDFLARE_AI_API_TOKEN: "cloudflare-token",
      CLOUDFLARE_AI_GATEWAY_ID: "systemforge-production",
    };
    expect(createConfiguredAiProvider(environment)?.evidence).toEqual({
      id: "cloudflare-workers-ai-responses",
      model: CLOUDFLARE_WORKERS_AI_MODEL,
    });
    expect(() =>
      createConfiguredAiProvider({
        ...environment,
        CLOUDFLARE_AI_API_TOKEN: "",
      }),
    ).toThrow(/Cloudflare AI credentials are invalid/u);
  });

  it("uses the fixed Responses endpoint, server-only authorization, no tools, strict JSON schema, and store false", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: JSON.stringify({ ok: true }) },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = new OpenAiResponsesProvider(
      "server-secret",
      "operator-selected-model",
      fetchImplementation,
    );

    await expect(
      provider.generateStructured({
        operation: "compile-requirements",
        schemaName: "test_schema",
        instructions: "Return JSON.",
        input: { sourceText: "untrusted" },
        outputSchema: { type: "object" },
      }),
    ).resolves.toEqual({ ok: true });

    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer server-secret",
    });
    if (typeof init?.body !== "string")
      throw new Error("Expected a serialized provider request body.");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "operator-selected-model",
      store: false,
      text: { format: { type: "json_schema", strict: true } },
    });
    expect(body.tools).toBeUndefined();
  });

  it("rejects oversized provider output before it becomes an application response", async () => {
    const provider = new OpenAiResponsesProvider("server-secret", "model", () =>
      Promise.resolve(
        new Response("x".repeat(32_001), {
          status: 200,
          headers: { "content-length": "32001" },
        }),
      ),
    );
    await expect(
      provider.generateStructured({
        operation: "compile-requirements",
        schemaName: "test",
        instructions: "test",
        input: {},
        outputSchema: {},
      }),
    ).rejects.toMatchObject({
      code: "ai_output_rejected",
    });
  });

  it("enforces the response limit in UTF-8 bytes without relying on Content-Length", async () => {
    const provider = new OpenAiResponsesProvider("server-secret", "model", () =>
      Promise.resolve(new Response("€".repeat(11_000), { status: 200 })),
    );

    await expect(
      provider.generateStructured({
        operation: "compile-requirements",
        schemaName: "test",
        instructions: "test",
        input: {},
        outputSchema: {},
      }),
    ).rejects.toMatchObject({
      code: "ai_output_rejected",
      message: expect.stringMatching(/oversized response/u),
    });
  });

  it("honors pre-aborted callers and distinguishes caller cancellation from timeout", async () => {
    const request: AiStructuredGenerationRequest = {
      operation: "compile-requirements",
      schemaName: "test",
      instructions: "test",
      input: {},
      outputSchema: {},
    };
    const unusedFetch = vi.fn<typeof fetch>();
    const preAborted = new AbortController();
    preAborted.abort();
    const preAbortedProvider = new OpenAiResponsesProvider(
      "server-secret",
      "model",
      unusedFetch,
    );

    await expect(
      preAbortedProvider.generateStructured(request, preAborted.signal),
    ).rejects.toMatchObject({
      code: "ai_request_cancelled",
      message: expect.stringMatching(/cancelled by the caller/u),
    });
    expect(unusedFetch).not.toHaveBeenCalled();

    const abortableFetch = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new Error("Provider request aborted."));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new Error("Provider request aborted.")),
            { once: true },
          );
        }),
    );
    const callerController = new AbortController();
    const callerProvider = new OpenAiResponsesProvider(
      "server-secret",
      "model",
      abortableFetch,
      1_000,
    );
    const callerRequest = callerProvider.generateStructured(
      request,
      callerController.signal,
    );
    callerController.abort();
    await expect(callerRequest).rejects.toMatchObject({
      code: "ai_request_cancelled",
      message: expect.stringMatching(/cancelled by the caller/u),
    });

    const timeoutProvider = new OpenAiResponsesProvider(
      "server-secret",
      "model",
      abortableFetch,
      1,
    );
    await expect(
      timeoutProvider.generateStructured(request),
    ).rejects.toMatchObject({
      code: "ai_provider_timeout",
      message: expect.stringMatching(/bounded timeout/u),
    });
  });
});

describe("source-grounded AI compilation", () => {
  it("derives numeric targets from exact source spans and forces private ownership from the caller scope", async () => {
    const sourceText =
      "Availability must stay at or above 99.95% and p95 latency must stay below 400 ms.";
    const provider = new FakeAiProvider({
      "compile-requirements": {
        requirements: [
          {
            label: "Availability target",
            metric: "availability",
            operator: "gte",
            metricSource: sourceSpan(sourceText, "Availability"),
            operatorSource: sourceSpan(sourceText, "at or above"),
            targetSource: sourceSpan(sourceText, "99.95%"),
          },
          {
            label: "Tail latency target",
            metric: "p95LatencyMs",
            operator: "lte",
            metricSource: sourceSpan(sourceText, "p95 latency"),
            operatorSource: sourceSpan(sourceText, "below"),
            targetSource: sourceSpan(sourceText, "400 ms"),
          },
        ],
        unresolvedQuestions: [],
        assumptions: [],
      },
    });
    const request: AiRequirementCompileRequest = {
      contractVersion: AI_ASSISTANT_CONTRACT_VERSION,
      sourceText,
      scope: "interview-private",
      context: {
        scenario: {
          ...structuredClone(DEFAULT_SCENARIO),
          mode: "interview",
          interview: {
            candidateBrief: "Design the system.",
            interviewerBrief: "private",
            timeboxMinutes: 45,
            allowCandidateRequirements: true,
            revealPolicy: "never",
          },
          requirements: [],
        },
        architecture: DEFAULT_ARCHITECTURE,
      },
    };

    const response = await compileAiRequirements(provider, request);

    expect(response.requirements).toMatchObject([
      {
        target: 99.95,
        unit: "%",
        visibility: "hidden",
        owner: "interviewer",
      },
      {
        target: 400,
        unit: "ms",
        visibility: "hidden",
        owner: "interviewer",
      },
    ]);
    expect(JSON.stringify(provider.requests[0]?.input)).not.toContain(
      "interviewerBrief",
    );
  });

  it("rejects a hallucinated target span instead of returning a partial proposal", async () => {
    const sourceText = "Keep p95 latency below the stated limit.";
    const provider = new FakeAiProvider({
      "compile-requirements": {
        requirements: [
          {
            label: "Latency target",
            metric: "p95LatencyMs",
            operator: "lte",
            metricSource: sourceSpan(sourceText, "p95 latency"),
            operatorSource: sourceSpan(sourceText, "below"),
            targetSource: { start: 0, end: 6, excerpt: "400 ms" },
          },
        ],
        unresolvedQuestions: [],
        assumptions: [],
      },
    });

    await expect(
      compileAiRequirements(provider, {
        contractVersion: 1,
        sourceText,
        scope: "custom-public",
        context: {
          scenario: DEFAULT_SCENARIO,
          architecture: DEFAULT_ARCHITECTURE,
        },
      }),
    ).rejects.toMatchObject({ code: "ai_output_rejected" });
  });

  it("rejects provider-selected metrics and comparators that contradict their cited phrases", async () => {
    const sourceText =
      "Availability must stay at or above 99.95% during the modeled run.";
    const baseOutput = {
      unresolvedQuestions: [],
      assumptions: [],
    };
    const request: AiRequirementCompileRequest = {
      contractVersion: 1,
      sourceText,
      scope: "custom-public",
      context: {
        scenario: DEFAULT_SCENARIO,
        architecture: DEFAULT_ARCHITECTURE,
      },
    };
    const wrongMetric = new FakeAiProvider({
      "compile-requirements": {
        ...baseOutput,
        requirements: [
          {
            label: "Availability target",
            metric: "errorRate",
            operator: "gte",
            metricSource: sourceSpan(sourceText, "Availability"),
            operatorSource: sourceSpan(sourceText, "at or above"),
            targetSource: sourceSpan(sourceText, "99.95%"),
          },
        ],
      },
    });
    const wrongComparator = new FakeAiProvider({
      "compile-requirements": {
        ...baseOutput,
        requirements: [
          {
            label: "Availability target",
            metric: "availability",
            operator: "lte",
            metricSource: sourceSpan(sourceText, "Availability"),
            operatorSource: sourceSpan(sourceText, "at or above"),
            targetSource: sourceSpan(sourceText, "99.95%"),
          },
        ],
      },
    });

    await expect(
      compileAiRequirements(wrongMetric, request),
    ).rejects.toMatchObject({ code: "ai_output_rejected" });
    await expect(
      compileAiRequirements(wrongComparator, request),
    ).rejects.toMatchObject({ code: "ai_output_rejected" });
  });

  it.each([
    {
      label: "daily currency period",
      sourceText: "Monthly cost must stay below 100 EUR/day.",
      metric: "monthlyCostEur" as const,
      metricPhrase: "Monthly cost",
      target: "100 EUR/day",
    },
    {
      label: "incompatible count suffix",
      sourceText: "Data loss must stay below 10 seconds.",
      metric: "dataLoss" as const,
      metricPhrase: "Data loss",
      target: "10 seconds",
    },
  ])(
    "rejects $label instead of relabeling the source unit",
    async (testCase) => {
      const provider = new FakeAiProvider({
        "compile-requirements": {
          requirements: [
            {
              label: "Bounded requirement",
              metric: testCase.metric,
              operator: "lte",
              metricSource: sourceSpan(
                testCase.sourceText,
                testCase.metricPhrase,
              ),
              operatorSource: sourceSpan(testCase.sourceText, "below"),
              targetSource: sourceSpan(testCase.sourceText, testCase.target),
            },
          ],
          unresolvedQuestions: [],
          assumptions: [],
        },
      });

      await expect(
        compileAiRequirements(provider, {
          contractVersion: 1,
          sourceText: testCase.sourceText,
          scope: "custom-public",
          context: {
            scenario: DEFAULT_SCENARIO,
            architecture: DEFAULT_ARCHITECTURE,
          },
        }),
      ).rejects.toMatchObject({ code: "ai_output_rejected" });
    },
  );

  it("normalizes the exact visible grouped-thousands example without inventing values", async () => {
    const sourceText =
      "Sustain 12,000 rps for 10 minutes. Keep p95 latency below 300 ms and availability above 99.9%.";
    const baseScenario = scenarioSchema.parse({
      ...structuredClone(DEFAULT_SCENARIO),
      mode: "custom",
    });
    const provider = new FakeAiProvider({
      "author-scenario": {
        title: "Grouped literal scenario",
        summary: "Use only the explicit workload and objective values.",
        candidateBrief: "",
        workload: [
          {
            field: "baseRps",
            valueSource: sourceSpan(sourceText, "12,000 rps"),
          },
          {
            field: "peakRps",
            valueSource: sourceSpan(sourceText, "12,000 rps"),
          },
          {
            field: "durationSeconds",
            valueSource: sourceSpan(sourceText, "10 minutes"),
          },
        ],
        incidents: [],
        requirements: [
          {
            label: "Tail latency",
            metric: "p95LatencyMs",
            operator: "lte",
            metricSource: sourceSpan(sourceText, "p95 latency"),
            operatorSource: sourceSpan(sourceText, "below"),
            targetSource: sourceSpan(sourceText, "300 ms"),
            scope: "custom-public",
          },
          {
            label: "Availability",
            metric: "availability",
            operator: "gte",
            metricSource: sourceSpan(sourceText, "availability"),
            operatorSource: sourceSpan(sourceText, "above"),
            targetSource: sourceSpan(sourceText, "99.9%"),
            scope: "custom-public",
          },
        ],
        unresolvedQuestions: [],
        assumptions: [],
      },
    });

    const response = await compileAiScenario(provider, {
      contractVersion: 1,
      sourceText,
      mode: "custom",
      baseScenario,
      architecture: DEFAULT_ARCHITECTURE,
    });

    expect(response.scenario.workload).toMatchObject({
      baseRps: 12_000,
      peakRps: 12_000,
      durationSeconds: 600,
    });
    expect(response.scenario.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Tail latency", target: 300 }),
        expect.objectContaining({ label: "Availability", target: 99.9 }),
      ]),
    );
  });

  it("normalizes explicit k and M workload literals", async () => {
    const sourceText = "Sustain 12k rps with 40M concurrent users.";
    const baseScenario = scenarioSchema.parse({
      ...structuredClone(DEFAULT_SCENARIO),
      mode: "custom",
    });
    const provider = new FakeAiProvider({
      "author-scenario": {
        title: "Scaled literal scenario",
        summary: "Use the explicit scaled workload values.",
        candidateBrief: "",
        workload: [
          {
            field: "baseRps",
            valueSource: sourceSpan(sourceText, "12k rps"),
          },
          {
            field: "peakRps",
            valueSource: sourceSpan(sourceText, "12k rps"),
          },
          {
            field: "concurrentUsers",
            valueSource: sourceSpan(sourceText, "40M concurrent users"),
          },
        ],
        incidents: [],
        requirements: [],
        unresolvedQuestions: [],
        assumptions: [],
      },
    });

    const response = await compileAiScenario(provider, {
      contractVersion: 1,
      sourceText,
      mode: "custom",
      baseScenario,
      architecture: DEFAULT_ARCHITECTURE,
    });

    expect(response.scenario.workload).toMatchObject({
      baseRps: 12_000,
      peakRps: 12_000,
      concurrentUsers: 40_000_000,
    });
  });

  it("normalizes a prefix-EUR grouped monthly cost literal", async () => {
    const sourceText = "Monthly cost must stay below €38,291 per month.";
    const provider = new FakeAiProvider({
      "compile-requirements": {
        requirements: [
          {
            label: "Monthly budget",
            metric: "monthlyCostEur",
            operator: "lte",
            metricSource: sourceSpan(sourceText, "Monthly cost"),
            operatorSource: sourceSpan(sourceText, "below"),
            targetSource: sourceSpan(sourceText, "€38,291 per month"),
          },
        ],
        unresolvedQuestions: [],
        assumptions: [],
      },
    });

    const response = await compileAiRequirements(provider, {
      contractVersion: 1,
      sourceText,
      scope: "custom-public",
      context: {
        scenario: DEFAULT_SCENARIO,
        architecture: DEFAULT_ARCHITECTURE,
      },
    });

    expect(response.requirements).toEqual([
      expect.objectContaining({ target: 38_291, unit: "EUR/month" }),
    ]);
  });

  it.each(["12m rps", "12,00 rps"])(
    "rejects unsupported or ambiguous workload literal %s",
    async (literal) => {
      const sourceText = `Sustain ${literal} for the modeled workload.`;
      const baseScenario = scenarioSchema.parse({
        ...structuredClone(DEFAULT_SCENARIO),
        mode: "custom",
      });
      const provider = new FakeAiProvider({
        "author-scenario": {
          title: "Unsupported literal scenario",
          summary: "The unsupported literal must not be guessed.",
          candidateBrief: "",
          workload: [
            { field: "baseRps", valueSource: sourceSpan(sourceText, literal) },
          ],
          incidents: [],
          requirements: [],
          unresolvedQuestions: [],
          assumptions: [],
        },
      });

      await expect(
        compileAiScenario(provider, {
          contractVersion: 1,
          sourceText,
          mode: "custom",
          baseScenario,
          architecture: DEFAULT_ARCHITECTURE,
        }),
      ).rejects.toMatchObject({ code: "ai_output_rejected" });
    },
  );

  it("rejects numeric claims in compilation assumptions", async () => {
    const sourceText = "Keep the objective qualitative until it is specified.";
    const provider = new FakeAiProvider({
      "compile-requirements": {
        requirements: [],
        unresolvedQuestions: [],
        assumptions: ["Assume availability is 50%"],
      },
    });

    await expect(
      compileAiRequirements(provider, {
        contractVersion: 1,
        sourceText,
        scope: "custom-public",
        context: {
          scenario: DEFAULT_SCENARIO,
          architecture: DEFAULT_ARCHITECTURE,
        },
      }),
    ).rejects.toMatchObject({ code: "ai_output_rejected" });
  });

  it("rejects invented numeric claims in generated compilation prose", async () => {
    const sourceText = "Keep p95 latency below 400 ms during the modeled run.";
    const provider = new FakeAiProvider({
      "compile-requirements": {
        requirements: [
          {
            label: "Keep p95 latency below 50 ms",
            metric: "p95LatencyMs",
            operator: "lte",
            metricSource: sourceSpan(sourceText, "p95 latency"),
            operatorSource: sourceSpan(sourceText, "below"),
            targetSource: sourceSpan(sourceText, "400 ms"),
          },
        ],
        unresolvedQuestions: [],
        assumptions: [],
      },
    });

    await expect(
      compileAiRequirements(provider, {
        contractVersion: 1,
        sourceText,
        scope: "custom-public",
        context: {
          scenario: DEFAULT_SCENARIO,
          architecture: DEFAULT_ARCHITECTURE,
        },
      }),
    ).rejects.toMatchObject({ code: "ai_output_rejected" });

    for (const label of [
      "Half the requests must meet the latency objective",
      "Eleven requests must meet the latency objective",
      "Dozens of requests must meet the latency objective",
      "Hundreds of requests must meet the latency objective",
      "Thousands of requests must meet the latency objective",
      "Most requests must meet the latency objective",
      "A majority of requests must meet the latency objective",
      "A minority of requests must meet the latency objective",
      "Several requests must meet the latency objective",
      "Many requests must meet the latency objective",
      "Few requests must meet the latency objective",
      "Every request must meet the latency objective",
      "Each request must meet the latency objective",
    ]) {
      const wordedProvider = new FakeAiProvider({
        "compile-requirements": {
          requirements: [
            {
              label,
              metric: "p95LatencyMs",
              operator: "lte",
              metricSource: sourceSpan(sourceText, "p95 latency"),
              operatorSource: sourceSpan(sourceText, "below"),
              targetSource: sourceSpan(sourceText, "400 ms"),
            },
          ],
          unresolvedQuestions: [],
          assumptions: [],
        },
      });
      await expect(
        compileAiRequirements(wordedProvider, {
          contractVersion: 1,
          sourceText,
          scope: "custom-public",
          context: {
            scenario: DEFAULT_SCENARIO,
            architecture: DEFAULT_ARCHITECTURE,
          },
        }),
      ).rejects.toMatchObject({ code: "ai_output_rejected" });
    }

    const currencySourceText =
      "Monthly cost must stay below €100 per month during the modeled run.";
    const currencyProvider = new FakeAiProvider({
      "compile-requirements": {
        requirements: [
          {
            label: "Keep monthly cost below $50 per month",
            metric: "monthlyCostEur",
            operator: "lte",
            metricSource: sourceSpan(currencySourceText, "Monthly cost"),
            operatorSource: sourceSpan(currencySourceText, "below"),
            targetSource: sourceSpan(currencySourceText, "€100 per month"),
          },
        ],
        unresolvedQuestions: [],
        assumptions: [],
      },
    });

    await expect(
      compileAiRequirements(currencyProvider, {
        contractVersion: 1,
        sourceText: currencySourceText,
        scope: "custom-public",
        context: {
          scenario: DEFAULT_SCENARIO,
          architecture: DEFAULT_ARCHITECTURE,
        },
      }),
    ).rejects.toMatchObject({ code: "ai_output_rejected" });
  });

  it("compiles a full scenario draft without replacing private interview fields or bypassing scenario validation", async () => {
    const sourceText =
      "Sustain 1200 rps normally and 3000 rps at peak with 70% reads for 60 seconds, 5000 users, and an 800 ms timeout. Start a 2x spike at 30 seconds for 15 seconds. Keep p95 below 400 ms.";
    const baseScenario = scenarioSchema.parse({
      ...structuredClone(DEFAULT_SCENARIO),
      id: "interview-ai-draft",
      mode: "interview",
      requirements: [],
      incidents: [],
      interview: {
        candidateBrief: "Original candidate brief",
        interviewerBrief: "PRIVATE-RUBRIC-SENTINEL",
        timeboxMinutes: 45,
        allowCandidateRequirements: true,
        revealPolicy: "never",
      },
    });
    const provider = new FakeAiProvider({
      "author-scenario": {
        title: "Global checkout pressure test",
        summary:
          "Evaluate a checkout path under a bounded demand increase and explicit tail-latency objective.",
        candidateBrief: "Design the checkout path and explain the trade-offs.",
        workload: [
          { field: "baseRps", valueSource: sourceSpan(sourceText, "1200 rps") },
          { field: "peakRps", valueSource: sourceSpan(sourceText, "3000 rps") },
          { field: "readRatio", valueSource: sourceSpan(sourceText, "70%") },
          {
            field: "durationSeconds",
            valueSource: sourceSpan(sourceText, "60 seconds"),
          },
          {
            field: "concurrentUsers",
            valueSource: sourceSpan(sourceText, "5000 users"),
          },
          {
            field: "clientTimeoutMs",
            valueSource: sourceSpan(sourceText, "800 ms"),
          },
        ],
        incidents: [
          {
            kind: "traffic-spike",
            label: "Demand spike",
            magnitudeSource: sourceSpan(sourceText, "2x"),
            atSecondSource: sourceSpan(sourceText, "30 seconds"),
            durationSource: sourceSpan(sourceText, "15 seconds"),
          },
        ],
        requirements: [
          {
            label: "Tail latency",
            metric: "p95LatencyMs",
            operator: "lte",
            metricSource: sourceSpan(sourceText, "p95"),
            operatorSource: sourceSpan(sourceText, "below"),
            targetSource: sourceSpan(sourceText, "400 ms"),
            scope: "interview-public",
          },
        ],
        unresolvedQuestions: [],
        assumptions: [],
      },
    });
    const request: AiScenarioCompileRequest = {
      contractVersion: AI_ASSISTANT_CONTRACT_VERSION,
      sourceText,
      mode: "interview",
      baseScenario,
      architecture: DEFAULT_ARCHITECTURE,
    };

    const response = await compileAiScenario(provider, request);

    expect(response.scenario.workload).toMatchObject({
      baseRps: 1_200,
      peakRps: 3_000,
      readRatio: 0.7,
      durationSeconds: 60,
      concurrentUsers: 5_000,
      clientTimeoutMs: 800,
    });
    expect(response.scenario.interview?.interviewerBrief).toBe(
      "PRIVATE-RUBRIC-SENTINEL",
    );
    expect(
      response.scenario.incidents
        .slice(0, baseScenario.incidents.length)
        .map((incident) => incident.id),
    ).toEqual(baseScenario.incidents.map((incident) => incident.id));
    expect(
      response.scenario.incidents.find(
        (incident) => incident.label === "Demand spike",
      ),
    ).toMatchObject({
      atSecond: 30,
      durationSeconds: 15,
      magnitude: 2,
    });
    expect(scenarioSchema.safeParse(response.scenario).success).toBe(true);
    expect(JSON.stringify(provider.requests[0]?.input)).not.toContain(
      "PRIVATE-RUBRIC-SENTINEL",
    );
  });

  it("preserves base incidents and requirements when the brief does not replace them", async () => {
    const sourceText = "Rename the scenario without changing its objectives.";
    const baseScenario = scenarioSchema.parse({
      ...structuredClone(DEFAULT_SCENARIO),
      mode: "custom",
    });
    const provider = new FakeAiProvider({
      "author-scenario": {
        title: "Renamed scenario",
        summary: baseScenario.summary,
        candidateBrief: "",
        workload: [],
        incidents: [],
        requirements: [],
        unresolvedQuestions: [],
        assumptions: [],
      },
    });

    const response = await compileAiScenario(provider, {
      contractVersion: 1,
      sourceText,
      mode: "custom",
      baseScenario,
      architecture: DEFAULT_ARCHITECTURE,
    });

    expect(response.scenario.incidents).toEqual(baseScenario.incidents);
    expect(response.scenario.requirements).toEqual(baseScenario.requirements);
  });

  it("permits exact retained base prose containing numeric values", async () => {
    const sourceText = "Rename the exercise without changing retained details.";
    const baseScenario = scenarioSchema.parse({
      ...structuredClone(DEFAULT_SCENARIO),
      mode: "custom",
      title: "Checkout phase 2",
      summary: "Retain the existing 90 second operating context.",
    });
    const provider = new FakeAiProvider({
      "author-scenario": {
        title: baseScenario.title,
        summary: baseScenario.summary,
        candidateBrief: "",
        workload: [],
        incidents: [],
        requirements: [],
        unresolvedQuestions: [],
        assumptions: [],
      },
    });

    await expect(
      compileAiScenario(provider, {
        contractVersion: 1,
        sourceText,
        mode: "custom",
        baseScenario,
        architecture: DEFAULT_ARCHITECTURE,
      }),
    ).resolves.toMatchObject({
      scenario: {
        title: "Checkout phase 2",
        summary: "Retain the existing 90 second operating context.",
      },
    });
  });

  it("does not let retained numeric prose move into another generated field", async () => {
    const sourceText = "Rename the exercise without changing retained details.";
    const baseScenario = scenarioSchema.parse({
      ...structuredClone(DEFAULT_SCENARIO),
      mode: "custom",
      title: "Checkout phase 2",
      summary: "Retain the existing 90 second operating context.",
    });
    const provider = new FakeAiProvider({
      "author-scenario": {
        title: baseScenario.title,
        summary: baseScenario.summary,
        candidateBrief: "",
        workload: [],
        incidents: [],
        requirements: [],
        unresolvedQuestions: [],
        assumptions: [baseScenario.summary],
      },
    });

    await expect(
      compileAiScenario(provider, {
        contractVersion: 1,
        sourceText,
        mode: "custom",
        baseScenario,
        architecture: DEFAULT_ARCHITECTURE,
      }),
    ).rejects.toMatchObject({ code: "ai_output_rejected" });
  });
});

describe("evidence-grounded debrief and interview privacy", () => {
  const privateScenario = (): Scenario =>
    scenarioSchema.parse({
      ...structuredClone(DEFAULT_SCENARIO),
      id: "private-interview",
      mode: "interview",
      requirements: [
        {
          ...DEFAULT_SCENARIO.requirements[0]!,
          id: "hidden-requirement",
          label: "PRIVATE-REQUIREMENT-SENTINEL",
          visibility: "hidden",
          owner: "interviewer",
        },
      ],
      interview: {
        candidateBrief: "Design the checkout service.",
        interviewerBrief: "PRIVATE-BRIEF-SENTINEL",
        timeboxMinutes: 45,
        allowCandidateRequirements: true,
        revealPolicy: "never",
      },
    });

  it("projects candidate-safe run context and returns exact cited evidence separately from digit-free commentary", async () => {
    const scenario = privateScenario();
    const store = new MemoryControlStore();
    const shared = await store.shareScenario(
      scenario,
      DEFAULT_ARCHITECTURE,
      10,
    );
    const runId = crypto.randomUUID();
    const result = simulate(scenario, DEFAULT_ARCHITECTURE);
    result.events = [
      {
        id: "child-event",
        second: 12,
        kind: "test-causal-event",
        severity: "warning",
        title: "Deterministic child event",
        detail: "The modeled path inherited pressure from its parent event.",
        parentIds: ["parent-event"],
      },
    ];
    result.traces = [
      {
        traceId: "trace-causal-path",
        second: 12,
        requestClass: "checkout",
        modeledRps: 1200,
        entryNodeId: DEFAULT_ARCHITECTURE.nodes[0]!.id,
        terminalNodeId: DEFAULT_ARCHITECTURE.nodes[1]!.id,
        truncated: false,
        spans: [
          {
            spanId: "span-edge",
            kind: "edge",
            name: "Deterministic edge span",
            edgeId: DEFAULT_ARCHITECTURE.edges[0]!.id,
            sourceNodeId: DEFAULT_ARCHITECTURE.edges[0]!.source,
            targetNodeId: DEFAULT_ARCHITECTURE.edges[0]!.target,
            attemptedRps: 1200,
            throughputRps: 1180,
            retryRps: 10,
            lostRps: 10,
            latencyMs: 24,
            asynchronous: false,
            status: "degraded",
          },
        ],
      },
    ];
    store.runs.set(runId, {
      id: runId,
      status: "completed",
      result,
      digest: "run-digest",
      createdAt: new Date().toISOString(),
    });
    store.runSubmissions.set(runId, {
      scenario,
      architecture: DEFAULT_ARCHITECTURE,
      clientEngineVersion: result.engineVersion,
      sharedScenarioId: shared.id,
    });
    const provider = new FakeAiProvider({
      "debrief-run": {
        headline: supportedDebriefHeadline,
        observations: [
          {
            finding: supportedDebriefFinding.frame,
            evidenceIds: ["run-score"],
          },
          {
            finding: supportedDebriefFinding.event,
            evidenceIds: ["event-1"],
          },
          {
            finding: supportedDebriefFinding.analysis,
            evidenceIds: ["analysis-bottleneck"],
          },
          {
            finding: supportedDebriefFinding.trace,
            evidenceIds: ["trace-1-path"],
          },
        ],
        nextTests: [
          "Compare a bounded architecture change against the current modeled evidence.",
        ],
        assumptions: [],
      },
    });

    const response = await debriefCanonicalRun(provider, store, {
      contractVersion: 1,
      runId,
    });

    const providerInput = JSON.stringify(provider.requests[0]?.input);
    expect(providerInput).not.toContain("PRIVATE-BRIEF-SENTINEL");
    expect(providerInput).not.toContain("PRIVATE-REQUIREMENT-SENTINEL");
    expect(response.privacyScope).toBe("public");
    expect(response.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "run-score", value: "0 of 0" }),
        expect.objectContaining({
          id: "event-1",
          value: expect.stringContaining("parent-event"),
        }),
        expect.objectContaining({
          id: "analysis-bottleneck",
          source: "analysis",
        }),
        expect.objectContaining({
          id: "trace-1-path",
          source: "trace",
          value: expect.stringContaining("span-edge"),
        }),
      ]),
    );
    expect(response.boundary).toMatch(/modeled-evidence/u);
  });

  it("rejects a completed run whose public scenario does not match its referenced share", async () => {
    const sharedScenario = privateScenario();
    const submittedScenario = scenarioSchema.parse({
      ...structuredClone(sharedScenario),
      title: "Different public scenario",
    });
    const store = new MemoryControlStore();
    const shared = await store.shareScenario(
      sharedScenario,
      DEFAULT_ARCHITECTURE,
      10,
    );
    const runId = crypto.randomUUID();
    const result = simulate(submittedScenario, DEFAULT_ARCHITECTURE);
    store.runs.set(runId, {
      id: runId,
      status: "completed",
      result,
      digest: "run-digest",
      createdAt: new Date().toISOString(),
    });
    store.runSubmissions.set(runId, {
      scenario: submittedScenario,
      architecture: DEFAULT_ARCHITECTURE,
      clientEngineVersion: result.engineVersion,
      sharedScenarioId: shared.id,
    });
    const provider = new FakeAiProvider({});

    await expect(
      debriefCanonicalRun(provider, store, { contractVersion: 1, runId }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "ai_run_scenario_mismatch",
    });
    expect(provider.requests).toHaveLength(0);
  });

  it("allows candidate-derived requirements only when the bound share permits them", async () => {
    const sharedScenario = privateScenario();
    const submittedScenario = scenarioSchema.parse({
      ...structuredClone(sharedScenario),
      requirements: [
        ...sharedScenario.requirements,
        {
          ...DEFAULT_SCENARIO.requirements[0]!,
          id: "candidate-derived-requirement",
          label: "Candidate objective",
          visibility: "derived",
          owner: "candidate",
        },
      ],
    });
    const store = new MemoryControlStore();
    const shared = await store.shareScenario(
      sharedScenario,
      DEFAULT_ARCHITECTURE,
      10,
    );
    const runId = crypto.randomUUID();
    const result = simulate(submittedScenario, DEFAULT_ARCHITECTURE);
    store.runs.set(runId, {
      id: runId,
      status: "completed",
      result,
      digest: "run-digest",
      createdAt: new Date().toISOString(),
    });
    store.runSubmissions.set(runId, {
      scenario: submittedScenario,
      architecture: DEFAULT_ARCHITECTURE,
      clientEngineVersion: result.engineVersion,
      sharedScenarioId: shared.id,
    });
    const provider = new FakeAiProvider({
      "debrief-run": {
        headline: supportedDebriefHeadline,
        observations: [
          {
            finding: supportedDebriefFinding.frame,
            evidenceIds: ["run-score"],
          },
          {
            finding: supportedDebriefFinding.requirement,
            evidenceIds: ["requirement-1"],
          },
        ],
        nextTests: [],
        assumptions: [],
      },
    });

    const response = await debriefCanonicalRun(provider, store, {
      contractVersion: 1,
      runId,
    });

    expect(response.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "run-score",
          value: expect.stringMatching(/of 1$/u),
        }),
        expect.objectContaining({
          id: "requirement-1",
          label: "Candidate objective",
        }),
      ]),
    );

    const disallowedScenario = scenarioSchema.parse({
      ...structuredClone(sharedScenario),
      interview: {
        ...sharedScenario.interview!,
        allowCandidateRequirements: false,
      },
    });
    const disallowedStore = new MemoryControlStore();
    const disallowedShare = await disallowedStore.shareScenario(
      disallowedScenario,
      DEFAULT_ARCHITECTURE,
      10,
    );
    const disallowedSubmission = scenarioSchema.parse({
      ...structuredClone(disallowedScenario),
      requirements: [
        ...disallowedScenario.requirements,
        submittedScenario.requirements.at(-1)!,
      ],
    });
    const disallowedRunId = crypto.randomUUID();
    const disallowedResult = simulate(
      disallowedSubmission,
      DEFAULT_ARCHITECTURE,
    );
    disallowedStore.runs.set(disallowedRunId, {
      id: disallowedRunId,
      status: "completed",
      result: disallowedResult,
      digest: "disallowed-run-digest",
      createdAt: new Date().toISOString(),
    });
    disallowedStore.runSubmissions.set(disallowedRunId, {
      scenario: disallowedSubmission,
      architecture: DEFAULT_ARCHITECTURE,
      clientEngineVersion: disallowedResult.engineVersion,
      sharedScenarioId: disallowedShare.id,
    });

    await expect(
      debriefCanonicalRun(provider, disallowedStore, {
        contractVersion: 1,
        runId: disallowedRunId,
      }),
    ).rejects.toMatchObject({ code: "ai_run_scenario_mismatch" });
  });

  it("allows a verified interviewer token to use private run context without returning it to participants", async () => {
    const scenario = privateScenario();
    const store = new MemoryControlStore();
    const shared = await store.shareScenario(
      scenario,
      DEFAULT_ARCHITECTURE,
      10,
    );
    const runId = crypto.randomUUID();
    const result = simulate(scenario, DEFAULT_ARCHITECTURE);
    store.runs.set(runId, {
      id: runId,
      status: "completed",
      result,
      digest: "run-digest",
      createdAt: new Date().toISOString(),
    });
    store.runSubmissions.set(runId, {
      scenario,
      architecture: DEFAULT_ARCHITECTURE,
      clientEngineVersion: result.engineVersion,
      sharedScenarioId: shared.id,
    });
    const provider = new FakeAiProvider({
      "debrief-run": {
        headline: supportedDebriefHeadline,
        observations: [
          {
            finding: supportedDebriefFinding.requirement,
            evidenceIds: ["requirement-1"],
          },
        ],
        nextTests: [],
        assumptions: [],
      },
    });

    const response = await debriefCanonicalRun(
      provider,
      store,
      { contractVersion: 1, runId },
      shared.hostToken,
    );

    expect(JSON.stringify(provider.requests[0]?.input)).toContain(
      "PRIVATE-BRIEF-SENTINEL",
    );
    expect(response.privacyScope).toBe("interviewer");
  });

  it("rejects numeric model prose even when evidence references are valid", async () => {
    const store = new MemoryControlStore();
    const runId = crypto.randomUUID();
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    store.runs.set(runId, {
      id: runId,
      status: "completed",
      result,
      digest: "digest",
      createdAt: new Date().toISOString(),
    });
    store.runSubmissions.set(runId, {
      scenario: DEFAULT_SCENARIO,
      architecture: DEFAULT_ARCHITECTURE,
      clientEngineVersion: result.engineVersion,
    });
    const provider = new FakeAiProvider({
      "debrief-run": {
        headline: "Availability fell to 50%",
        observations: [
          { finding: "The run failed", evidenceIds: ["run-score"] },
        ],
        nextTests: [],
        assumptions: [],
      },
    });

    await expect(
      debriefCanonicalRun(provider, store, {
        contractVersion: 1,
        runId,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("rejects unsupported digit-free quantitative debrief claims", async () => {
    const store = new MemoryControlStore();
    const runId = crypto.randomUUID();
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    store.runs.set(runId, {
      id: runId,
      status: "completed",
      result,
      digest: "digest",
      createdAt: new Date().toISOString(),
    });
    store.runSubmissions.set(runId, {
      scenario: DEFAULT_SCENARIO,
      architecture: DEFAULT_ARCHITECTURE,
      clientEngineVersion: result.engineVersion,
    });
    const provider = new FakeAiProvider({
      "debrief-run": {
        headline: supportedDebriefHeadline,
        observations: [
          {
            finding: "Half the requests failed",
            evidenceIds: ["run-score"],
          },
        ],
        nextTests: [],
        assumptions: [],
      },
    });

    await expect(
      debriefCanonicalRun(provider, store, {
        contractVersion: 1,
        runId,
      }),
    ).rejects.toMatchObject({ code: "ai_output_rejected" });

    const mismatchedEvidenceProvider = new FakeAiProvider({
      "debrief-run": {
        headline: supportedDebriefHeadline,
        observations: [
          {
            finding: supportedDebriefFinding.event,
            evidenceIds: ["run-score"],
          },
        ],
        nextTests: [],
        assumptions: [],
      },
    });
    await expect(
      debriefCanonicalRun(mismatchedEvidenceProvider, store, {
        contractVersion: 1,
        runId,
      }),
    ).rejects.toMatchObject({ code: "ai_output_rejected" });
  });

  it("rejects numeric claims hidden in the assumptions field", async () => {
    const store = new MemoryControlStore();
    const runId = crypto.randomUUID();
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    store.runs.set(runId, {
      id: runId,
      status: "completed",
      result,
      digest: "digest",
      createdAt: new Date().toISOString(),
    });
    store.runSubmissions.set(runId, {
      scenario: DEFAULT_SCENARIO,
      architecture: DEFAULT_ARCHITECTURE,
      clientEngineVersion: result.engineVersion,
    });
    const provider = new FakeAiProvider({
      "debrief-run": {
        headline: supportedDebriefHeadline,
        observations: [
          {
            finding: supportedDebriefFinding.frame,
            evidenceIds: ["run-score"],
          },
        ],
        nextTests: [],
        assumptions: ["Availability was 50%"],
      },
    });

    await expect(
      debriefCanonicalRun(provider, store, {
        contractVersion: 1,
        runId,
      }),
    ).rejects.toMatchObject({ code: "ai_output_rejected" });
  });

  it("conducts a candidate-visible interview turn without private scenario fields", async () => {
    const architecture = architectureSchema.parse({
      ...structuredClone(DEFAULT_ARCHITECTURE),
      id: "bounded-interview-architecture",
      nodes: Array.from({ length: 65 }, (_, index) => ({
        ...structuredClone(DEFAULT_ARCHITECTURE.nodes[0]!),
        id: `bounded-node-${index}`,
        name: `Bounded node ${index}`,
      })),
      edges: Array.from({ length: 129 }, (_, index) => ({
        ...structuredClone(DEFAULT_ARCHITECTURE.edges[0]!),
        id: `bounded-edge-${index}`,
        source: "bounded-node-0",
        target: `bounded-node-${(index % 64) + 1}`,
      })),
    });
    const provider = new FakeAiProvider({
      "conduct-interview": {
        question: "Which failure boundary would you clarify first?",
        purpose: "Explore how the candidate discovers reliability constraints",
        assumptions: [],
      },
    });
    const response = await conductAiInterviewTurn(provider, {
      contractVersion: 1,
      scenario: privateScenario(),
      architecture,
      candidateNotes: "I would start with the write path.",
      candidatePhase: "Evaluating failure boundaries",
      previousQuestions: [],
    });

    expect(response.question).toMatch(/failure boundary/u);
    expect(JSON.stringify(provider.requests[0]?.input)).not.toContain(
      "PRIVATE-BRIEF-SENTINEL",
    );
    expect(JSON.stringify(provider.requests[0]?.input)).not.toContain(
      "PRIVATE-REQUIREMENT-SENTINEL",
    );
    expect(provider.requests[0]?.input).toMatchObject({
      candidatePhase: "Evaluating failure boundaries",
      architecture: {
        nodes: architecture.nodes
          .slice(0, 64)
          .map(({ id, name, kind }) => ({ id, name, kind })),
        edges: architecture.edges
          .slice(0, 128)
          .map(({ id, source, target }) => ({ id, source, target })),
      },
    });
    const providerInput = provider.requests[0]?.input as {
      architecture: { nodes: unknown[]; edges: unknown[] };
    };
    expect(providerInput.architecture.nodes).toHaveLength(64);
    expect(providerInput.architecture.edges).toHaveLength(128);
    expect(JSON.stringify(provider.requests[0]?.input)).not.toContain(
      "monthlyCostEur",
    );
  });
});

describe("AI HTTP surface", () => {
  it("pre-aborts already-closed requests and removes the close listener before normal response completion", () => {
    for (const state of [
      { aborted: true, socketDestroyed: false },
      { aborted: false, socketDestroyed: true },
    ]) {
      const controller = new AbortController();
      const requestRaw = Object.assign(new EventEmitter(), {
        aborted: state.aborted,
      });
      const replyRaw = new EventEmitter();
      const release = bindAiDisconnectAbort(
        {
          raw: requestRaw,
          socket: { destroyed: state.socketDestroyed },
        },
        { raw: replyRaw },
        controller,
      );
      expect(controller.signal.aborted).toBe(true);
      release();
    }

    const normalController = new AbortController();
    const normalReplyRaw = new EventEmitter();
    const releaseNormal = bindAiDisconnectAbort(
      {
        raw: Object.assign(new EventEmitter(), { aborted: false }),
        socket: { destroyed: false },
      },
      { raw: normalReplyRaw },
      normalController,
    );
    expect(normalController.signal.aborted).toBe(false);
    releaseNormal();
    normalReplyRaw.emit("close");
    expect(normalController.signal.aborted).toBe(false);
  });

  it("aborts provider work when the client disconnects after sending the request body", async () => {
    let startedResolve!: () => void;
    let abortedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      abortedResolve = resolve;
    });
    let calls = 0;
    let normallyCompletedSignal: AbortSignal | undefined;
    const provider: AiProvider = {
      evidence: { id: "openai-responses", model: "test-model" },
      generateStructured(_request, signal) {
        calls += 1;
        if (calls > 1) {
          normallyCompletedSignal = signal;
          return Promise.resolve({
            question: "Which failure boundary would you clarify?",
            purpose: "Invite explicit discovery before topology design.",
            assumptions: [],
          });
        }
        startedResolve();
        return new Promise((_resolve, reject) => {
          const rejectCancelled = () => {
            abortedResolve();
            reject(
              new AiProviderError(
                "ai_request_cancelled",
                "The AI request was cancelled by the caller.",
              ),
            );
          };
          if (signal?.aborted) rejectCancelled();
          else
            signal?.addEventListener("abort", rejectCancelled, { once: true });
        });
      },
    };
    app = await buildApp(config, new MemoryControlStore(), undefined, provider);
    const origin = new URL(await app.listen({ host: "127.0.0.1", port: 0 }));
    const interviewPayload = {
      contractVersion: 1,
      scenario: DEFAULT_SCENARIO,
      architecture: DEFAULT_ARCHITECTURE,
      candidateNotes: "I am comparing failure boundaries.",
      candidatePhase: "Comparing alternatives",
      previousQuestions: [],
    };
    const payload = JSON.stringify(interviewPayload);
    const client = httpRequest({
      hostname: origin.hostname,
      port: origin.port,
      path: "/api/ai/interview",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    });
    client.on("error", () => undefined);
    client.end(payload);

    await started;
    client.destroy();
    await Promise.race([
      aborted,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () =>
            reject(new Error("Provider work was not aborted on disconnect.")),
          2_000,
        ),
      ),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const nextStatus = await new Promise<number>((resolve, reject) => {
      const nextClient = httpRequest(
        {
          hostname: origin.hostname,
          port: origin.port,
          path: "/api/ai/interview",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
            connection: "close",
          },
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        },
      );
      nextClient.once("error", reject);
      nextClient.end(payload);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(nextStatus).toBe(200);
    expect(calls).toBe(2);
    expect(normallyCompletedSignal?.aborted).toBe(false);
  });

  it("advertises a disabled optional capability without exposing model or credentials", async () => {
    app = await buildApp(config, new MemoryControlStore());

    const capabilities = await app.inject({
      method: "GET",
      url: "/api/ai/capabilities",
    });
    const unavailable = await app.inject({
      method: "POST",
      url: "/api/ai/compile/requirements",
      payload: {},
    });

    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toMatchObject({
      contractVersion: 1,
      enabled: false,
      provider: null,
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      error: { code: "ai_unavailable", localModeAvailable: true },
    });
  });

  it("fails closed after the global daily AI request budget is reserved", async () => {
    const sourceText = "Keep p95 latency below 400 ms.";
    const provider = new FakeAiProvider({
      "compile-requirements": {
        requirements: [
          {
            label: "Tail latency",
            metric: "p95LatencyMs",
            operator: "lte",
            metricSource: sourceSpan(sourceText, "p95 latency"),
            operatorSource: sourceSpan(sourceText, "below"),
            targetSource: sourceSpan(sourceText, "400 ms"),
          },
        ],
        unresolvedQuestions: [],
        assumptions: [],
      },
    });
    const store = new MemoryControlStore();
    for (let index = 0; index < MAX_AI_DAILY_REQUESTS; index += 1) {
      await store.reserveAiUsage({
        providerId: provider.evidence.id,
        model: provider.evidence.model,
        reservedCostCents: CLOUDFLARE_AI_RESERVED_COST_CENTS_PER_REQUEST,
        maximumDailyRequests: MAX_AI_DAILY_REQUESTS,
        maximumMonthlyCostCents: MAX_AI_MONTHLY_RESERVED_COST_CENTS,
      });
    }
    app = await buildApp(config, store, undefined, provider);

    const response = await app.inject({
      method: "POST",
      url: "/api/ai/compile/requirements",
      payload: {
        contractVersion: 1,
        sourceText,
        scope: "custom-public",
        context: {
          scenario: DEFAULT_SCENARIO,
          architecture: DEFAULT_ARCHITECTURE,
        },
      },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      error: { code: "ai_budget_exhausted", localModeAvailable: true },
    });
    expect(provider.requests).toHaveLength(0);
  });

  it("reserves failed provider calls and blocks before the fixed monthly ceiling", async () => {
    const store = new MemoryControlStore();
    const reservation = {
      providerId: "cloudflare-workers-ai-responses" as const,
      model: CLOUDFLARE_WORKERS_AI_MODEL,
      reservedCostCents: 5,
      maximumDailyRequests: 100,
      maximumMonthlyCostCents: 10,
    };
    await expect(store.reserveAiUsage(reservation)).resolves.toMatchObject({
      monthlyReservedCostCents: 5,
    });
    await expect(store.reserveAiUsage(reservation)).resolves.toMatchObject({
      monthlyReservedCostCents: 10,
    });
    await expect(store.reserveAiUsage(reservation)).rejects.toMatchObject({
      name: "AiUsageBudgetExceededError",
    });
  });

  it("returns validated proposals and strips full simulation results from public polling", async () => {
    const sourceText = "Keep p95 latency below 400 ms.";
    const provider = new FakeAiProvider({
      "compile-requirements": {
        requirements: [
          {
            label: "Tail latency",
            metric: "p95LatencyMs",
            operator: "lte",
            metricSource: sourceSpan(sourceText, "p95 latency"),
            operatorSource: sourceSpan(sourceText, "below"),
            targetSource: sourceSpan(sourceText, "400 ms"),
          },
        ],
        unresolvedQuestions: [],
        assumptions: [],
      },
    });
    const store = new MemoryControlStore();
    const runId = crypto.randomUUID();
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    store.runs.set(runId, {
      id: runId,
      status: "completed",
      result,
      digest: "digest",
      createdAt: new Date().toISOString(),
    });
    app = await buildApp(config, store, undefined, provider);

    const compiled = await app.inject({
      method: "POST",
      url: "/api/ai/compile/requirements",
      payload: {
        contractVersion: 1,
        sourceText,
        scope: "custom-public",
        context: {
          scenario: DEFAULT_SCENARIO,
          architecture: DEFAULT_ARCHITECTURE,
        },
      },
    });
    const polled = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}`,
    });

    expect(compiled.statusCode).toBe(200);
    expect(compiled.json()).toMatchObject({
      task: "compile-requirements",
      requirements: [{ target: 400, unit: "ms" }],
    });
    expect(polled.json().result).toEqual({
      engineVersion: result.engineVersion,
      digest: "digest",
    });
    expect(polled.body).not.toContain("frames");
  });

  it("classifies malformed provider structured output as an upstream 502", async () => {
    const sourceText = "Keep p95 latency below 400 ms.";
    const provider = new FakeAiProvider({
      "compile-requirements": {
        requirements: [
          {
            label: "Incomplete provider intent",
            metric: "p95LatencyMs",
            operator: "lte",
            targetSource: sourceSpan(sourceText, "400 ms"),
          },
        ],
        unresolvedQuestions: [],
        assumptions: [],
      },
    });
    app = await buildApp(config, new MemoryControlStore(), undefined, provider);

    const response = await app.inject({
      method: "POST",
      url: "/api/ai/compile/requirements",
      payload: {
        contractVersion: 1,
        sourceText,
        scope: "custom-public",
        context: {
          scenario: DEFAULT_SCENARIO,
          architecture: DEFAULT_ARCHITECTURE,
        },
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: { code: "ai_output_rejected" },
    });
  });

  it("maps malformed debrief and interview provider output to 502", async () => {
    const store = new MemoryControlStore();
    const runId = crypto.randomUUID();
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    store.runs.set(runId, {
      id: runId,
      status: "completed",
      result,
      digest: "digest",
      createdAt: new Date().toISOString(),
    });
    store.runSubmissions.set(runId, {
      scenario: DEFAULT_SCENARIO,
      architecture: DEFAULT_ARCHITECTURE,
      clientEngineVersion: result.engineVersion,
    });
    const provider = new FakeAiProvider({
      "debrief-run": { observations: [] },
      "conduct-interview": { question: "What would you test next?" },
    });
    app = await buildApp(config, store, undefined, provider);

    const debrief = await app.inject({
      method: "POST",
      url: "/api/ai/debrief",
      payload: { contractVersion: 1, runId },
    });
    const interview = await app.inject({
      method: "POST",
      url: "/api/ai/interview",
      payload: {
        contractVersion: 1,
        scenario: DEFAULT_SCENARIO,
        architecture: DEFAULT_ARCHITECTURE,
        candidateNotes: "I am comparing failure boundaries.",
        candidatePhase: "Comparing alternatives",
        previousQuestions: [],
      },
    });

    expect(debrief.statusCode).toBe(502);
    expect(debrief.json()).toMatchObject({
      error: { code: "ai_output_rejected" },
    });
    expect(interview.statusCode).toBe(502);
    expect(interview.json()).toMatchObject({
      error: { code: "ai_output_rejected" },
    });
  });
});
