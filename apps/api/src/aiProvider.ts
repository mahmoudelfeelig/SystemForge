import type {
  AiAssistantProviderEvidence,
  AiAssistantTask,
} from "@systemforge/contracts";
import type { ZodType } from "zod";

export const MAX_AI_PROVIDER_RESPONSE_BYTES = 32_000;
export const MAX_AI_PROVIDER_REQUEST_BYTES = 96_000;
export const DEFAULT_AI_TIMEOUT_MS = 12_000;
export const MIN_CLOUDFLARE_AI_TIMEOUT_MS = 30_000;
export const MAX_AI_TIMEOUT_MS = 30_000;
export const MAX_AI_DAILY_REQUESTS = 12;
export const MAX_AI_MONTHLY_RESERVED_COST_CENTS = 400;
export const CLOUDFLARE_AI_RESERVED_COST_CENTS_PER_REQUEST = 5;
export const CLOUDFLARE_WORKERS_AI_MODEL =
  "@cf/meta/llama-3.1-8b-instruct-fast";
export const LEGACY_CLOUDFLARE_WORKERS_AI_MODEL = "@cf/openai/gpt-oss-20b";

type JsonSchema = Record<string, unknown>;

export interface AiStructuredGenerationRequest {
  operation: AiAssistantTask;
  schemaName: string;
  instructions: string;
  input: unknown;
  outputSchema: JsonSchema;
}

export interface AiProvider {
  evidence: AiAssistantProviderEvidence;
  reservedCostCents?: number;
  generateStructured(
    request: AiStructuredGenerationRequest,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export class AiProviderError extends Error {
  constructor(
    readonly code:
      | "ai_provider_unavailable"
      | "ai_provider_timeout"
      | "ai_request_cancelled"
      | "ai_output_rejected",
    message: string,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export const parseAiProviderOutput = <Output>(
  schema: ZodType<Output>,
  value: unknown,
): Output => {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new AiProviderError(
      "ai_output_rejected",
      "The configured AI provider returned structured output that does not match the requested schema.",
    );
  return parsed.data;
};

interface OpenAiResponsesBody {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
}

interface OpenAiChatCompletionsBody {
  choices?: Array<{
    message?: { content?: string | null };
  }>;
}

type StructuredApiFormat = "responses" | "chat-completions";

interface ResponsesApiProviderConfiguration {
  endpoint: string;
  evidence: AiAssistantProviderEvidence;
  headers: Record<string, string>;
  reservedCostCents: number;
  format?: StructuredApiFormat;
}

const extractOutputText = (body: OpenAiResponsesBody): string | null => {
  const text = (body.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === "output_text")
    .map((content) => content.text ?? "")
    .join("");
  return text || null;
};

const extractChatCompletionText = (
  body: OpenAiChatCompletionsBody,
): string | null => {
  const text = (body.choices ?? [])
    .map((choice) => choice.message?.content ?? "")
    .join("");
  return text || null;
};

const oversizedResponseError = (): AiProviderError =>
  new AiProviderError(
    "ai_output_rejected",
    "The configured AI provider returned an oversized response.",
  );

const readBoundedResponseText = async (response: Response): Promise<string> => {
  const declaredLengthHeader = response.headers.get("content-length");
  if (declaredLengthHeader && /^\d+$/u.test(declaredLengthHeader)) {
    const declaredLength = Number(declaredLengthHeader);
    if (declaredLength > MAX_AI_PROVIDER_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw oversizedResponseError();
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_AI_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw oversizedResponseError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AiProviderError(
      "ai_output_rejected",
      "The configured AI provider returned invalid UTF-8.",
    );
  }
};

const cancelledRequestError = (): AiProviderError =>
  new AiProviderError(
    "ai_request_cancelled",
    "The AI request was cancelled by the caller.",
  );

class ResponsesApiProvider implements AiProvider {
  readonly evidence: AiAssistantProviderEvidence;
  readonly reservedCostCents: number;

  constructor(
    private readonly configuration: ResponsesApiProviderConfiguration,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_AI_TIMEOUT_MS,
  ) {
    this.evidence = configuration.evidence;
    this.reservedCostCents = configuration.reservedCostCents;
  }

  async generateStructured(
    request: AiStructuredGenerationRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw cancelledRequestError();
    const timeoutController = new AbortController();
    let abortKind: "caller" | "timeout" | null = null;
    const abortForTimeout = () => {
      if (abortKind) return;
      abortKind = "timeout";
      timeoutController.abort();
    };
    const timeout = setTimeout(abortForTimeout, this.timeoutMs);
    const abortForCaller = () => {
      if (abortKind) return;
      abortKind = "caller";
      timeoutController.abort();
    };
    signal?.addEventListener("abort", abortForCaller, { once: true });
    try {
      const format = this.configuration.format ?? "responses";
      const requestBody = JSON.stringify(
        format === "chat-completions"
          ? {
              model: this.evidence.model,
              stream: false,
              max_tokens: 2_000,
              temperature: 0,
              messages: [
                { role: "system", content: request.instructions },
                { role: "user", content: JSON.stringify(request.input) },
              ],
              response_format: {
                type: "json_schema",
                json_schema: request.outputSchema,
              },
            }
          : {
              model: this.evidence.model,
              store: false,
              max_output_tokens: 2_000,
              instructions: request.instructions,
              input: JSON.stringify(request.input),
              text: {
                format: {
                  type: "json_schema",
                  name: request.schemaName,
                  strict: true,
                  schema: request.outputSchema,
                },
              },
            },
      );
      if (
        new TextEncoder().encode(requestBody).byteLength >
        MAX_AI_PROVIDER_REQUEST_BYTES
      )
        throw new AiProviderError(
          "ai_output_rejected",
          "The bounded AI provider request exceeds the maximum request size.",
        );
      const response = await this.fetchImplementation(
        this.configuration.endpoint,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...this.configuration.headers,
          },
          body: requestBody,
          signal: timeoutController.signal,
        },
      );
      const raw = await readBoundedResponseText(response);
      if (!response.ok)
        throw new AiProviderError(
          "ai_provider_unavailable",
          `The configured AI provider returned HTTP ${response.status}.`,
        );
      let responseBody: OpenAiResponsesBody | OpenAiChatCompletionsBody;
      try {
        responseBody = JSON.parse(raw) as
          OpenAiResponsesBody | OpenAiChatCompletionsBody;
      } catch {
        throw new AiProviderError(
          "ai_output_rejected",
          "The configured AI provider returned invalid JSON.",
        );
      }
      const outputText =
        format === "chat-completions"
          ? extractChatCompletionText(responseBody as OpenAiChatCompletionsBody)
          : extractOutputText(responseBody as OpenAiResponsesBody);
      if (!outputText)
        throw new AiProviderError(
          "ai_output_rejected",
          "The configured AI provider returned no structured output.",
        );
      try {
        return JSON.parse(outputText) as unknown;
      } catch {
        throw new AiProviderError(
          "ai_output_rejected",
          "The configured AI provider returned malformed structured output.",
        );
      }
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if (abortKind === "caller" || signal?.aborted)
        throw cancelledRequestError();
      if (abortKind === "timeout")
        throw new AiProviderError(
          "ai_provider_timeout",
          "The configured AI provider did not respond within the bounded timeout.",
        );
      throw new AiProviderError(
        "ai_provider_unavailable",
        "The configured AI provider could not be reached.",
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortForCaller);
    }
  }
}

export class OpenAiResponsesProvider extends ResponsesApiProvider {
  constructor(
    apiKey: string,
    model: string,
    fetchImplementation: typeof fetch = fetch,
    timeoutMs = DEFAULT_AI_TIMEOUT_MS,
  ) {
    super(
      {
        endpoint: "https://api.openai.com/v1/responses",
        evidence: { id: "openai-responses", model },
        headers: { authorization: `Bearer ${apiKey}` },
        reservedCostCents: MAX_AI_MONTHLY_RESERVED_COST_CENTS,
      },
      fetchImplementation,
      timeoutMs,
    );
  }
}

export class CloudflareWorkersAiResponsesProvider extends ResponsesApiProvider {
  constructor(
    accountId: string,
    apiToken: string,
    gatewayId: string,
    fetchImplementation: typeof fetch = fetch,
    timeoutMs = DEFAULT_AI_TIMEOUT_MS,
  ) {
    const effectiveTimeoutMs = Math.max(
      MIN_CLOUDFLARE_AI_TIMEOUT_MS,
      timeoutMs,
    );
    super(
      {
        endpoint: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`,
        evidence: {
          id: "cloudflare-workers-ai-responses",
          model: CLOUDFLARE_WORKERS_AI_MODEL,
        },
        headers: {
          authorization: `Bearer ${apiToken}`,
          "cf-aig-gateway-id": gatewayId,
          "cf-aig-collect-log": "false",
          "cf-aig-skip-cache": "true",
          "cf-aig-max-attempts": "1",
          "cf-aig-request-timeout": String(effectiveTimeoutMs - 1_000),
        },
        reservedCostCents: CLOUDFLARE_AI_RESERVED_COST_CENTS_PER_REQUEST,
        format: "chat-completions",
      },
      fetchImplementation,
      effectiveTimeoutMs,
    );
  }
}

export const createConfiguredAiProvider = (
  environment: NodeJS.ProcessEnv = process.env,
  fetchImplementation: typeof fetch = fetch,
): AiProvider | null => {
  if (environment.SYSTEMFORGE_AI_ENABLED !== "true") return null;
  const providerId = environment.SYSTEMFORGE_AI_PROVIDER?.trim();
  const model = environment.SYSTEMFORGE_AI_MODEL?.trim();
  if (!providerId || !model)
    throw new Error(
      "SYSTEMFORGE_AI_ENABLED requires SYSTEMFORGE_AI_PROVIDER and SYSTEMFORGE_AI_MODEL.",
    );
  if (!/^[A-Za-z0-9@/._:-]{1,160}$/u.test(model))
    throw new Error("The configured AI provider credentials are invalid.");
  const parsedTimeout = Number.parseInt(
    environment.SYSTEMFORGE_AI_TIMEOUT_MS ?? "",
    10,
  );
  const timeoutMs = Number.isFinite(parsedTimeout)
    ? Math.max(1_000, Math.min(MAX_AI_TIMEOUT_MS, parsedTimeout))
    : DEFAULT_AI_TIMEOUT_MS;
  if (providerId === "cloudflare-workers-ai-responses") {
    const accountId = environment.CLOUDFLARE_ACCOUNT_ID?.trim();
    const apiToken = environment.CLOUDFLARE_AI_API_TOKEN?.trim();
    const gatewayId = environment.CLOUDFLARE_AI_GATEWAY_ID?.trim();
    if (
      !accountId ||
      !/^[0-9a-f]{32}$/u.test(accountId) ||
      !apiToken ||
      apiToken.length > 512 ||
      /[\r\n]/u.test(apiToken) ||
      !gatewayId ||
      !/^[a-z0-9-]{1,64}$/u.test(gatewayId) ||
      ![
        CLOUDFLARE_WORKERS_AI_MODEL,
        LEGACY_CLOUDFLARE_WORKERS_AI_MODEL,
      ].includes(model)
    )
      throw new Error("The configured Cloudflare AI credentials are invalid.");
    return new CloudflareWorkersAiResponsesProvider(
      accountId,
      apiToken,
      gatewayId,
      fetchImplementation,
      timeoutMs,
    );
  }
  if (providerId === "openai-responses") {
    const apiKey = environment.OPENAI_API_KEY?.trim();
    if (!apiKey || apiKey.length > 512 || /[\r\n]/u.test(apiKey))
      throw new Error("The configured OpenAI credentials are invalid.");
    return new OpenAiResponsesProvider(
      apiKey,
      model,
      fetchImplementation,
      timeoutMs,
    );
  }
  throw new Error("SYSTEMFORGE_AI_PROVIDER is not supported.");
};
