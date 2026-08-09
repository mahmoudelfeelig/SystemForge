import {
  AI_ASSISTANT_CONTRACT_VERSION,
  candidateScenario,
  type AiAssistantCapabilities,
  type AiInterviewTurnRequest,
  type AiInterviewTurnResponse,
  type AiRequirementCompileRequest,
  type AiRequirementCompileResponse,
  type AiRunDebriefRequest,
  type AiRunDebriefResponse,
  type AiScenarioCompileRequest,
  type AiScenarioCompileResponse,
  type ApiErrorBody,
} from "@systemforge/contracts";

const canonicalReleaseEnabled =
  import.meta.env.MODE === "test" ||
  import.meta.env.VITE_CANONICAL_RELEASE_ENABLED === "true";

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  if (!canonicalReleaseEnabled)
    throw new Error(
      "Optional AI assistance is unavailable while canonical services are release-locked.",
    );
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    const body = (await response
      .json()
      .catch(() => null)) as ApiErrorBody | null;
    const error = new Error(
      body?.error.message ?? `Request failed with status ${response.status}.`,
    );
    Object.assign(error, {
      code: body?.error.code,
      retryAfterSeconds: body?.error.retryAfterSeconds,
      status: response.status,
    });
    throw error;
  }
  return (await response.json()) as T;
};

export const fetchAiCapabilities = (
  signal?: AbortSignal,
): Promise<AiAssistantCapabilities> =>
  request<AiAssistantCapabilities>("/api/ai/capabilities", { signal });

export const compileRequirementsWithAi = (
  input: Omit<AiRequirementCompileRequest, "contractVersion">,
  signal?: AbortSignal,
): Promise<AiRequirementCompileResponse> =>
  request<AiRequirementCompileResponse>("/api/ai/compile/requirements", {
    method: "POST",
    body: JSON.stringify({
      contractVersion: AI_ASSISTANT_CONTRACT_VERSION,
      ...input,
    }),
    signal,
  });

export const compileScenarioWithAi = (
  input: Omit<AiScenarioCompileRequest, "contractVersion">,
  signal?: AbortSignal,
): Promise<AiScenarioCompileResponse> =>
  request<AiScenarioCompileResponse>("/api/ai/compile/scenario", {
    method: "POST",
    body: JSON.stringify({
      contractVersion: AI_ASSISTANT_CONTRACT_VERSION,
      ...input,
    }),
    signal,
  });

export const debriefCanonicalRunWithAi = (
  input: Omit<AiRunDebriefRequest, "contractVersion">,
  hostToken?: string,
  signal?: AbortSignal,
): Promise<AiRunDebriefResponse> =>
  request<AiRunDebriefResponse>("/api/ai/debrief", {
    method: "POST",
    ...(hostToken ? { headers: { authorization: `Bearer ${hostToken}` } } : {}),
    body: JSON.stringify({
      contractVersion: AI_ASSISTANT_CONTRACT_VERSION,
      ...input,
    }),
    signal,
  });

export const conductInterviewWithAi = (
  input: Omit<AiInterviewTurnRequest, "contractVersion" | "scenario"> & {
    scenario: AiInterviewTurnRequest["scenario"];
  },
  signal?: AbortSignal,
): Promise<AiInterviewTurnResponse> =>
  request<AiInterviewTurnResponse>("/api/ai/interview", {
    method: "POST",
    body: JSON.stringify({
      contractVersion: AI_ASSISTANT_CONTRACT_VERSION,
      ...input,
      scenario: candidateScenario(input.scenario),
    }),
    signal,
  });
