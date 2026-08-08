export interface ApiConfig {
  port: number;
  host: string;
  databaseUrl: string;
  publicOrigin: string;
  trustProxy: boolean;
  maxQueuedRuns: number;
  maxStoredRuns: number;
  maxSharedScenarios: number;
  maxCanonicalWorkUnits: number;
  maxConcurrentRequests: number;
  rateLimitMax: number;
  rateLimitWindow: string;
}

const integer = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
};

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ApiConfig {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const maxQueuedRuns = integer(environment.MAX_QUEUED_RUNS, 250, 1, 100_000);
  return {
    port: integer(environment.PORT, 8080, 1, 65_535),
    host: environment.HOST ?? "0.0.0.0",
    databaseUrl,
    publicOrigin: (
      environment.PUBLIC_ORIGIN ?? "http://localhost:4173"
    ).replace(/\/$/, ""),
    trustProxy: environment.TRUST_PROXY === "true",
    maxQueuedRuns,
    maxStoredRuns: Math.max(
      maxQueuedRuns,
      integer(environment.MAX_STORED_RUNS, 250, 1, 1_000_000),
    ),
    maxSharedScenarios: integer(
      environment.MAX_SHARED_SCENARIOS,
      2_000,
      100,
      1_000_000,
    ),
    maxCanonicalWorkUnits: integer(
      environment.MAX_CANONICAL_WORK_UNITS,
      30_000,
      1_000,
      10_000_000,
    ),
    maxConcurrentRequests: integer(
      environment.MAX_CONCURRENT_REQUESTS,
      96,
      8,
      10_000,
    ),
    rateLimitMax: integer(environment.RATE_LIMIT_MAX, 120, 10, 100_000),
    rateLimitWindow: environment.RATE_LIMIT_WINDOW ?? "1 minute",
  };
}
