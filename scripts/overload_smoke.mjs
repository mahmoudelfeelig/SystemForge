import { randomUUID } from "node:crypto";

const apiOrigin = process.env.OVERLOAD_API_ORIGIN ?? "http://127.0.0.1:8080";
const webOrigin =
  process.env.OVERLOAD_WEB_ORIGIN ?? "http://systemforge-web:8080";
const burstVisitor = process.env.OVERLOAD_BURST_VISITOR ?? "198.51.100.61";
const independentVisitor =
  process.env.OVERLOAD_INDEPENDENT_VISITOR ?? "198.51.100.62";

const boundedInteger = (name, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(minimum, Math.min(maximum, value));
};

const burstRequestCount = boundedInteger(
  "OVERLOAD_BURST_REQUESTS",
  256,
  16,
  2_000,
);
const webProbeCount = boundedInteger("OVERLOAD_WEB_PROBES", 48, 4, 256);
const minimumAdmitted = boundedInteger(
  "OVERLOAD_EXPECT_MIN_ADMITTED",
  1,
  0,
  burstRequestCount,
);
const minimumOverloaded = boundedInteger(
  "OVERLOAD_EXPECT_MIN_OVERLOAD",
  1,
  0,
  burstRequestCount,
);
const requestTimeoutMs = boundedInteger(
  "OVERLOAD_REQUEST_TIMEOUT_MS",
  10_000,
  1_000,
  30_000,
);

const fetchWithTimeout = (url, init = {}) =>
  fetch(url, {
    signal: AbortSignal.timeout(requestTimeoutMs),
    ...init,
  });

const responseBody = async (response) => {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
};

const requireHealthy = async (path) => {
  const response = await fetchWithTimeout(`${apiOrigin}${path}`);
  if (!response.ok)
    throw new Error(
      `${path} returned ${response.status} during overload smoke.`,
    );
};

const requireWebShell = async () => {
  const response = await fetchWithTimeout(`${webOrigin}/`);
  const body = await response.text();
  if (!response.ok || !body.includes("SystemForge"))
    throw new Error(
      `The local-capable web shell failed during overload smoke with ${response.status}.`,
    );
  if (
    response.headers.get("cache-control") !==
    "public, max-age=0, must-revalidate"
  )
    throw new Error("The web shell lost its browser revalidation policy.");
  if (
    response.headers.get("cloudflare-cdn-cache-control") !==
    "public, max-age=300, stale-while-revalidate=60, stale-if-error=86400"
  )
    throw new Error("The web shell lost its Cloudflare stale-on-error policy.");
};

await Promise.all([
  requireHealthy("/api/health/live"),
  requireHealthy("/api/health/ready"),
  requireWebShell(),
]);

const [apiResponses] = await Promise.all([
  Promise.all(
    Array.from({ length: burstRequestCount }, async () => {
      const response = await fetchWithTimeout(
        `${apiOrigin}/api/runs/${randomUUID()}`,
        { headers: { "x-forwarded-for": burstVisitor } },
      );
      const body = await responseBody(response);
      if (response.status === 404) return { outcome: "admitted" };
      if (response.status !== 429 && response.status !== 503)
        throw new Error(
          `Burst request returned unexpected ${response.status}: ${JSON.stringify(body).slice(0, 300)}`,
        );
      const expectedCode =
        response.status === 429 ? "rate_limited" : "request_capacity_exceeded";
      if (
        body?.error?.code !== expectedCode ||
        body?.error?.localModeAvailable !== true ||
        !Number.isFinite(Number(body?.error?.retryAfterSeconds)) ||
        Number(body.error.retryAfterSeconds) < 1 ||
        !Number.isFinite(Number(response.headers.get("retry-after"))) ||
        Number(response.headers.get("retry-after")) < 1
      )
        throw new Error(
          `Overload response ${response.status} did not preserve retry and local-mode guidance: ${JSON.stringify(body).slice(0, 300)}`,
        );
      return {
        outcome: response.status === 429 ? "rate-limited" : "capacity-limited",
      };
    }),
  ),
  Promise.all(Array.from({ length: webProbeCount }, () => requireWebShell())),
]);

const admitted = apiResponses.filter(
  ({ outcome }) => outcome === "admitted",
).length;
const rateLimited = apiResponses.filter(
  ({ outcome }) => outcome === "rate-limited",
).length;
const capacityLimited = apiResponses.filter(
  ({ outcome }) => outcome === "capacity-limited",
).length;
const overloaded = rateLimited + capacityLimited;

if (admitted < minimumAdmitted)
  throw new Error(
    `Only ${admitted} burst requests reached the API; expected at least ${minimumAdmitted}.`,
  );
if (overloaded < minimumOverloaded)
  throw new Error(
    `No meaningful overload boundary was observed: ${overloaded} limited of ${burstRequestCount}.`,
  );

await Promise.all([
  requireHealthy("/api/health/live"),
  requireHealthy("/api/health/ready"),
  requireWebShell(),
]);

const independent = await fetchWithTimeout(
  `${apiOrigin}/api/runs/${randomUUID()}`,
  { headers: { "x-forwarded-for": independentVisitor } },
);
if (independent.status !== 404)
  throw new Error(
    `An independent visitor received ${independent.status} after another visitor's burst.`,
  );

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    burstRequests: burstRequestCount,
    admitted,
    rateLimited,
    capacityLimited,
    webProbes: webProbeCount,
  })}\n`,
);
