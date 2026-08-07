const apiOrigin = process.env.SMOKE_API_ORIGIN ?? "http://127.0.0.1:8080";
const webOrigin = process.env.SMOKE_WEB_ORIGIN ?? "http://systemforge-web:8080";

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

await request(`${apiOrigin}/api/health/ready`);

const shared = await request(`${apiOrigin}/api/scenarios`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ scenario, architecture }),
});
if (!shared.body?.id || !shared.body?.hostToken || !shared.body?.candidateUrl)
  throw new Error("Scenario sharing did not return interview credentials.");

const candidate = await request(`${apiOrigin}/api/scenarios/${shared.body.id}`);
if (candidate.body?.scenario?.requirements?.length !== 0)
  throw new Error("Candidate response leaked a hidden requirement.");
if (candidate.body?.scenario?.interview?.interviewerBrief !== "")
  throw new Error("Candidate response leaked interviewer notes.");

const host = await request(
  `${apiOrigin}/api/scenarios/${shared.body.id}?hostToken=${encodeURIComponent(shared.body.hostToken)}`,
);
if (host.body?.scenario?.requirements?.[0]?.id !== "hidden-latency")
  throw new Error("Interviewer response did not retain private criteria.");

const queued = await request(`${apiOrigin}/api/runs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    scenario,
    architecture,
    clientEngineVersion: "0.1.0",
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

if (!completed?.digest || completed.result?.engineVersion !== "0.1.0")
  throw new Error(
    "Canonical worker did not complete with a deterministic digest.",
  );
process.stdout.write(
  `${JSON.stringify({ ok: true, scenarioId: shared.body.id, runId: queued.body.id, digest: completed.digest })}\n`,
);
