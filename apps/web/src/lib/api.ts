import type {
  ApiErrorBody,
  Architecture,
  RunSubmission,
  Scenario,
} from "@systemforge/contracts";
import {
  ENGINE_VERSION,
  type SolveArchitectureOptions,
  type SolveArchitectureResult,
} from "@systemforge/sim-core";

export type ApiAvailability = "checking" | "online" | "offline" | "busy";

export interface CanonicalRunReceipt {
  id: string;
  status: "queued";
  statusUrl: string;
}

export interface CanonicalRunStatus {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  result?: { engineVersion: string; digest?: string };
  digest?: string;
  failureCode?: string;
  failureMessage?: string;
  createdAt: string;
}

export interface ScenarioShareReceipt {
  id: string;
  url: string;
  candidateUrl?: string;
  interviewerUrl?: string;
}

export interface SharedScenario {
  id: string;
  scenario: Scenario;
  architecture: Architecture;
  role: "interviewer" | "participant";
  revealState: "hidden" | "revealed";
  collaboration: InterviewCollaboration;
}

export interface InterviewCollaboration {
  candidateNotes: string;
  candidateCursor: string;
  startedAt: string | null;
  updatedAt: string;
  interviewerNotes?: string;
}

export interface InterviewCollaborationPatch {
  candidateNotes?: string;
  candidateCursor?: string;
  interviewerNotes?: string;
  clockAction?: "start" | "reset";
}

export interface CanonicalSolveResponse {
  execution: "canonical";
  result: SolveArchitectureResult;
}

const canonicalReleaseEnabled =
  import.meta.env.MODE === "test" ||
  import.meta.env.VITE_CANONICAL_RELEASE_ENABLED === "true";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!canonicalReleaseEnabled) {
    throw new Error(
      "Canonical services are release-locked. Use the browser-local workflow.",
    );
  }
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
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
}

export async function checkApi(signal?: AbortSignal): Promise<ApiAvailability> {
  if (!canonicalReleaseEnabled) return "offline";
  try {
    const response = await fetch("/api/health/ready", {
      signal,
      headers: { accept: "application/json" },
    });
    if (response.status === 429 || response.status === 503) return "busy";
    return response.ok ? "online" : "offline";
  } catch {
    return "offline";
  }
}

export function submitCanonicalRun(
  submission: RunSubmission,
): Promise<CanonicalRunReceipt> {
  return request<CanonicalRunReceipt>("/api/runs", {
    method: "POST",
    body: JSON.stringify(submission),
  });
}

export function solveCanonicalArchitecture(
  scenario: Scenario,
  architecture: Architecture,
  options: SolveArchitectureOptions = {},
): Promise<CanonicalSolveResponse> {
  return request<CanonicalSolveResponse>("/api/solve", {
    method: "POST",
    body: JSON.stringify({
      scenario,
      architecture,
      clientEngineVersion: ENGINE_VERSION,
      options,
    }),
  });
}

export function fetchCanonicalRun(id: string): Promise<CanonicalRunStatus> {
  return request<CanonicalRunStatus>(`/api/runs/${encodeURIComponent(id)}`);
}

export function shareScenario(
  scenario: Scenario,
  architecture: Architecture,
): Promise<ScenarioShareReceipt> {
  return request<ScenarioShareReceipt>("/api/scenarios", {
    method: "POST",
    body: JSON.stringify({ scenario, architecture }),
  });
}

export function fetchSharedScenario(
  id: string,
  hostToken?: string,
  signal?: AbortSignal,
): Promise<SharedScenario> {
  return request<SharedScenario>(
    `/api/scenarios/${encodeURIComponent(id)}`,
    hostToken || signal
      ? {
          ...(hostToken
            ? { headers: { authorization: `Bearer ${hostToken}` } }
            : {}),
          ...(signal ? { signal } : {}),
        }
      : undefined,
  );
}

export function recordSharedScenarioRun(
  id: string,
  runId: string,
): Promise<SharedScenario> {
  return request<SharedScenario>(
    `/api/scenarios/${encodeURIComponent(id)}/runs`,
    { method: "POST", body: JSON.stringify({ runId }) },
  );
}

export function setSharedScenarioReveal(
  id: string,
  hostToken: string,
  revealed: boolean,
  signal?: AbortSignal,
): Promise<SharedScenario> {
  return request<SharedScenario>(
    `/api/scenarios/${encodeURIComponent(id)}/reveal`,
    {
      method: "PATCH",
      headers: { authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ revealed }),
      ...(signal ? { signal } : {}),
    },
  );
}

export function updateInterviewCollaboration(
  id: string,
  patch: InterviewCollaborationPatch,
  hostToken?: string,
  signal?: AbortSignal,
): Promise<SharedScenario> {
  return request<SharedScenario>(
    `/api/scenarios/${encodeURIComponent(id)}/collaboration`,
    {
      method: "PATCH",
      ...(hostToken
        ? { headers: { authorization: `Bearer ${hostToken}` } }
        : {}),
      body: JSON.stringify(patch),
      ...(signal ? { signal } : {}),
    },
  );
}
