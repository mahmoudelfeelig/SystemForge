import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const apiOrigin = process.env.SMOKE_API_ORIGIN ?? "http://127.0.0.1:8080";
const webOrigin = process.env.SMOKE_WEB_ORIGIN ?? "http://systemforge-web:8080";
const expectedEngineVersion = "0.7.0";
const requestedLeaseRecoveryTimeout = Number.parseInt(
  process.env.SMOKE_LEASE_RECOVERY_TIMEOUT_MS ?? "75000",
  10,
);
const leaseRecoveryTimeoutMs = Number.isFinite(requestedLeaseRecoveryTimeout)
  ? Math.max(10_000, Math.min(120_000, requestedLeaseRecoveryTimeout))
  : 75_000;
const verifyStorageCap = process.env.SMOKE_VERIFY_STORAGE_CAP === "true";
const verifyResultCap = process.env.SMOKE_VERIFY_RESULT_CAP === "true";

const scenario = {
  schemaVersion: 1,
  id: "production-smoke",
  title: "Production smoke interview",
  summary:
    "A short canonical run that verifies private interview criteria and the worker queue.",
  mode: "interview",
  seed: 47,
  workload: {
    baseRps: 100,
    peakRps: 100,
    readRatio: 0.8,
    durationSeconds: 15,
    regions: [{ name: "Europe", trafficShare: 1, roundTripMs: 20 }],
  },
  requirements: [
    {
      id: "hidden-latency",
      label: "p99 latency remains below 500 ms",
      metric: "p99LatencyMs",
      operator: "lte",
      target: 500,
      unit: "ms",
      visibility: "hidden",
      owner: "interviewer",
    },
  ],
  incidents: [],
  interview: {
    candidateBrief:
      "Design a reliable regional API and ask for its constraints.",
    interviewerBrief: "The candidate should identify the latency objective.",
    timeboxMinutes: 30,
    allowCandidateRequirements: true,
    revealPolicy: "interviewer-controlled",
  },
};

const architecture = {
  schemaVersion: 1,
  id: "production-smoke-architecture",
  name: "Production smoke architecture",
  nodes: [
    {
      id: "api",
      kind: "api",
      name: "API",
      position: { x: 0, y: 0 },
      config: { capacityRps: 1_000, baseLatencyMs: 10 },
    },
    {
      id: "database",
      kind: "database",
      name: "PostgreSQL",
      position: { x: 180, y: 0 },
      config: { capacityRps: 1_000, baseLatencyMs: 12, replicas: 1 },
    },
  ],
  edges: [{ id: "api-database", source: "api", target: "database" }],
};

const request = async (url, options = {}) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5_000),
    ...options,
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok)
    throw new Error(
      `${url} returned ${response.status}: ${text.slice(0, 300)}`,
    );
  return { response, body };
};

const web = await request(`${webOrigin}/`);
if (typeof web.body !== "string" || !web.body.includes("SystemForge"))
  throw new Error("The production web shell did not contain the product name.");
if (
  web.response.headers.get("cache-control") !==
  "public, max-age=0, must-revalidate, no-transform"
)
  throw new Error("The browser shell cache policy was not fail-safe.");
if (
  web.response.headers.get("cloudflare-cdn-cache-control") !==
  "public, max-age=300, stale-while-revalidate=60, stale-if-error=86400"
)
  throw new Error("The Cloudflare stale-shell cache policy was not active.");

await request(`${apiOrigin}/api/health/ready`);

const shared = await request(`${apiOrigin}/api/scenarios`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ scenario, architecture }),
});
if (
  !shared.body?.id ||
  !shared.body?.candidateUrl ||
  !shared.body?.interviewerUrl
)
  throw new Error("Scenario sharing did not return interview credentials.");

const candidate = await request(`${apiOrigin}/api/scenarios/${shared.body.id}`);
if (candidate.body?.scenario?.requirements?.length !== 0)
  throw new Error("Candidate response leaked a hidden requirement.");
if (candidate.body?.scenario?.interview?.interviewerBrief !== "")
  throw new Error("Candidate response leaked interviewer notes.");

const interviewerToken = new URL(shared.body.interviewerUrl).hash
  .slice(1)
  .replace(/^hostToken=/, "");
const host = await request(`${apiOrigin}/api/scenarios/${shared.body.id}`, {
  headers: {
    authorization: `Bearer ${decodeURIComponent(interviewerToken)}`,
  },
});
if (host.body?.scenario?.requirements?.[0]?.id !== "hidden-latency")
  throw new Error("Interviewer response did not retain private criteria.");

const revealed = await request(
  `${apiOrigin}/api/scenarios/${shared.body.id}/reveal`,
  {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${decodeURIComponent(interviewerToken)}`,
    },
    body: JSON.stringify({ revealed: true }),
  },
);
if (revealed.body?.revealState !== "revealed")
  throw new Error("Interviewer-controlled reveal did not persist.");
const candidateAfterReveal = await request(
  `${apiOrigin}/api/scenarios/${shared.body.id}`,
);
if (
  candidateAfterReveal.body?.scenario?.requirements?.[0]?.id !==
    "hidden-latency" ||
  candidateAfterReveal.body?.scenario?.interview?.interviewerBrief !== ""
)
  throw new Error(
    "Candidate reveal did not expose criteria while retaining note privacy.",
  );

await request(`${apiOrigin}/api/scenarios/${shared.body.id}/reveal`, {
  method: "PATCH",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${decodeURIComponent(interviewerToken)}`,
  },
  body: JSON.stringify({ revealed: false }),
});
const candidateAfterConceal = await request(
  `${apiOrigin}/api/scenarios/${shared.body.id}`,
);
if (candidateAfterConceal.body?.scenario?.requirements?.length !== 0)
  throw new Error("Concealed candidate criteria remained visible.");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for smoke checks.");
const database = new Pool({ connectionString: databaseUrl, max: 1 });
const storedCredential = await database.query(
  `SELECT host_token_hash,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'shared_scenarios'
              AND column_name = 'host_token'
          ) AS raw_token_column_exists
   FROM shared_scenarios
   WHERE id = $1`,
  [shared.body.id],
);
let rawTokenCount = 0;
if (storedCredential.rows[0]?.raw_token_column_exists) {
  const legacyTokens = await database.query(
    "SELECT count(*)::int AS count FROM shared_scenarios WHERE host_token IS NOT NULL",
  );
  rawTokenCount = legacyTokens.rows[0]?.count ?? 0;
}
if (
  !/^[a-f0-9]{64}$/.test(storedCredential.rows[0]?.host_token_hash ?? "") ||
  rawTokenCount !== 0
)
  throw new Error("Interviewer credentials were not stored as digests only.");

const mismatchedEngine = await fetch(`${apiOrigin}/api/runs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    scenario,
    architecture,
    clientEngineVersion: "0.0.0-smoke-mismatch",
  }),
  signal: AbortSignal.timeout(5_000),
});
const mismatchedEngineBody = await mismatchedEngine.json();
if (
  mismatchedEngine.status !== 409 ||
  mismatchedEngineBody?.error?.code !== "engine_version_mismatch" ||
  mismatchedEngineBody?.error?.localModeAvailable !== true
)
  throw new Error(
    "The API did not reject an incompatible browser engine with a local fallback.",
  );

const solved = await request(`${apiOrigin}/api/solve`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    scenario,
    architecture,
    clientEngineVersion: expectedEngineVersion,
    options: {
      maxCandidates: 2,
      includeHiddenRequirements: true,
    },
  }),
});
if (
  solved.body?.execution !== "canonical" ||
  solved.body?.result?.engineVersion !== expectedEngineVersion ||
  solved.body?.result?.solverVersion !== "0.1.0" ||
  solved.body?.result?.excludedHiddenRequirementCount !== 1 ||
  solved.body?.result?.options?.includeHiddenRequirements !== false
)
  throw new Error(
    "The isolated canonical solver did not enforce its public hidden-requirement boundary.",
  );

const queued = await request(`${apiOrigin}/api/runs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    scenario,
    architecture,
    clientEngineVersion: expectedEngineVersion,
  }),
});
if (queued.response.status !== 202 || !queued.body?.id)
  throw new Error("Canonical run was not queued.");

let completed = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  const run = await request(`${apiOrigin}/api/runs/${queued.body.id}`);
  if (run.body?.status === "failed")
    throw new Error(
      `Canonical run failed: ${run.body.failureMessage ?? "unknown"}`,
    );
  if (run.body?.status === "completed") {
    completed = run.body;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

if (
  !completed?.digest ||
  completed.result?.engineVersion !== expectedEngineVersion
)
  throw new Error(
    "Canonical worker did not complete with a deterministic digest.",
  );

const abandonedRunId = randomUUID();
await database.query(
  `INSERT INTO simulation_runs (
     id, status, submission, attempts, lease_expires_at, started_at
   ) VALUES ($1, 'running', $2::jsonb, 3, now() - interval '1 second', now())`,
  [
    abandonedRunId,
    JSON.stringify({
      scenario,
      architecture,
      clientEngineVersion: expectedEngineVersion,
    }),
  ],
);
let abandonedRun = null;
for (
  let attempt = 0;
  attempt < Math.ceil(leaseRecoveryTimeoutMs / 500);
  attempt += 1
) {
  const status = await request(`${apiOrigin}/api/runs/${abandonedRunId}`);
  if (status.body?.status === "failed") {
    abandonedRun = status.body;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (abandonedRun?.failureCode !== "lease_exhausted")
  throw new Error("An exhausted canonical lease was not failed closed.");

let replacementRunId = null;
if (verifyStorageCap) {
  const storageCap = Number.parseInt(process.env.MAX_STORED_RUNS ?? "", 10);
  if (!Number.isFinite(storageCap) || storageCap < 1)
    throw new Error(
      "MAX_STORED_RUNS is required when verifying the durable storage cap.",
    );
  const replacement = await request(`${apiOrigin}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scenario,
      architecture,
      clientEngineVersion: expectedEngineVersion,
    }),
  });
  replacementRunId = replacement.body?.id ?? null;
  if (!replacementRunId)
    throw new Error("The storage-cap replacement run was not accepted.");
  const evicted = await fetch(`${apiOrigin}/api/runs/${queued.body.id}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (evicted.status !== 404)
    throw new Error("The oldest terminal run was not evicted at the cap.");
  const stored = await database.query(
    "SELECT count(*)::int AS count FROM simulation_runs",
  );
  if ((stored.rows[0]?.count ?? Number.POSITIVE_INFINITY) > storageCap)
    throw new Error("Durable canonical run storage exceeded its hard cap.");
}
let resultCapRunId = null;
if (verifyResultCap) {
  const resultHeavyScenario = {
    ...scenario,
    id: "production-smoke-result-cap",
    title: "Canonical result-cap smoke",
    workload: { ...scenario.workload, durationSeconds: 600 },
  };
  const resultCapRun = await request(`${apiOrigin}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scenario: resultHeavyScenario,
      architecture,
      clientEngineVersion: expectedEngineVersion,
    }),
  });
  resultCapRunId = resultCapRun.body?.id ?? null;
  if (!resultCapRunId)
    throw new Error("The canonical result-cap probe was not accepted.");
  let resultCapFailure = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = await request(`${apiOrigin}/api/runs/${resultCapRunId}`);
    if (status.body?.status === "completed")
      throw new Error("An oversized canonical result was persisted.");
    if (status.body?.status === "failed") {
      resultCapFailure = status.body;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (resultCapFailure?.failureCode !== "result_too_large")
    throw new Error(
      "The canonical serialized-result ceiling was not enforced.",
    );
}
await database.end();
process.stdout.write(
  `${JSON.stringify({ ok: true, scenarioId: shared.body.id, runId: queued.body.id, digest: completed.digest, exhaustedRunId: abandonedRunId, ...(replacementRunId ? { replacementRunId } : {}), ...(resultCapRunId ? { resultCapRunId } : {}) })}\n`,
);
