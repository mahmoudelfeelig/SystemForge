import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { JobStore } from "./jobStore";
import { runInThread } from "./runThread";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};
const integer = (
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
};

const databaseUrl = required("DATABASE_URL");
const concurrency = integer("MAX_RUNNING_RUNS", 4, 1, 32);
const pollMilliseconds = integer("WORKER_POLL_MS", 500, 100, 30_000);
const timeoutMilliseconds = integer(
  "WORKER_JOB_TIMEOUT_MS",
  30_000,
  1_000,
  300_000,
);
const maximumResultBytes = integer(
  "MAX_CANONICAL_RESULT_BYTES",
  8_500_000,
  100_000,
  100_000_000,
);
const retentionDays = integer("RUN_RETENTION_DAYS", 30, 1, 365);
const maintenanceMilliseconds = integer(
  "WORKER_MAINTENANCE_MS",
  60_000,
  1_000,
  3_600_000,
);
const leaseSeconds = Math.ceil(timeoutMilliseconds / 1_000) + 15;
const store = new JobStore(databaseUrl, concurrency + 2);
const workerId = hostname();
let stopping = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;

const log = (
  level: "info" | "error",
  message: string,
  details: Record<string, unknown> = {},
) => {
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...details })}\n`,
  );
};

const runLoop = async (slot: number) => {
  while (!stopping) {
    let job;
    try {
      job = await store.claim(leaseSeconds);
    } catch (error) {
      log("error", "job claim failed", {
        slot,
        error: error instanceof Error ? error.message : String(error),
      });
      await delay(Math.min(5_000, pollMilliseconds * 4));
      continue;
    }
    if (!job) {
      await delay(pollMilliseconds);
      continue;
    }
    try {
      const canonical = await runInThread(
        job.submission,
        timeoutMilliseconds,
        maximumResultBytes,
      );
      await store.complete(job.id, canonical.result, canonical.digest);
      log("info", "canonical run completed", {
        slot,
        runId: job.id,
        digest: canonical.digest,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "canonical_run_failed";
      await store.fail(
        job.id,
        message === "canonical_run_timeout"
          ? "timeout"
          : message.startsWith("canonical_result_too_large:")
            ? "result_too_large"
            : message.startsWith("engine_version_mismatch:")
              ? "engine_version_mismatch"
              : "simulation_error",
        message,
      );
      log("error", "canonical run failed", {
        slot,
        runId: job.id,
        error: message,
      });
    }
  }
};

if (!(await store.ready())) throw new Error("Database schema is not ready.");
await store.maintain(retentionDays);
await store.heartbeat(workerId);
heartbeatTimer = setInterval(() => {
  void store.heartbeat(workerId).catch((error: unknown) => {
    log("error", "worker heartbeat failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}, 5_000);
heartbeatTimer.unref();
maintenanceTimer = setInterval(() => {
  void store
    .maintain(retentionDays)
    .then((expiredJobs) => {
      if (expiredJobs > 0)
        log("error", "expired canonical leases were failed closed", {
          expiredJobs,
        });
    })
    .catch((error: unknown) => {
      log("error", "worker maintenance failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}, maintenanceMilliseconds);
maintenanceTimer.unref();
log("info", "canonical worker started", {
  concurrency,
  timeoutMilliseconds,
  maximumResultBytes,
});
const loops = Array.from({ length: concurrency }, (_, slot) => runLoop(slot));

const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  log("info", "worker shutdown started", { signal });
  await Promise.race([
    Promise.allSettled(loops),
    delay(timeoutMilliseconds + 5_000),
  ]);
  await store.removeHeartbeat(workerId);
  await store.close();
  process.exit(0);
};

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
await Promise.all(loops);
