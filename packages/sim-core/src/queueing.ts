import type { DeterministicRandom } from "./prng";

export type ArrivalPattern = "steady" | "poisson" | "bursty";

export interface QueueCohort {
  enqueuedSecond: number;
  count: number;
}

export interface QueueAdvanceResult {
  processed: number;
  depth: number;
  oldestAgeMs: number;
}

export interface QueueingDelayInput {
  arrivalRateRps: number;
  capacityRps: number;
  parallelServers: number;
  serviceTimeMs: number;
  arrivalScv: number;
  serviceScv?: number;
  timeoutMs: number;
}

export interface QueueingDelayEstimate {
  utilization: number;
  waitMs: number;
  stable: boolean;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const BURST_LOG_RATE_SIGMA = 0.34;
const BURST_RATE_SCV = Math.exp(BURST_LOG_RATE_SIGMA ** 2) - 1;

const standardNormal = (random: DeterministicRandom): number => {
  const first = Math.max(Number.EPSILON, random.next());
  const second = random.next();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
};

/**
 * Draws a Poisson count. Knuth's exact method is retained for small means;
 * the continuity-corrected normal approximation avoids work proportional to
 * production-sized request rates and is accurate once the mean is large.
 */
export const samplePoissonCount = (
  expectedCount: number,
  random: DeterministicRandom,
): number => {
  if (!Number.isFinite(expectedCount) || expectedCount < 0)
    throw new Error("invalid_arrival_mean");
  if (expectedCount === 0) return 0;
  if (expectedCount < 30) {
    const limit = Math.exp(-expectedCount);
    let product = 1;
    let count = 0;
    do {
      count += 1;
      product *= random.next();
    } while (product > limit);
    return count - 1;
  }
  return Math.max(
    0,
    Math.floor(
      expectedCount + Math.sqrt(expectedCount) * standardNormal(random) + 0.5,
    ),
  );
};

/**
 * Produces one aggregate second of arrivals. Bursty traffic is modeled as a
 * Poisson process with a log-normal intensity multiplier, which preserves the
 * requested mean while making variance exceed the mean.
 */
export const sampleArrivalCount = (
  expectedCount: number,
  pattern: ArrivalPattern,
  random: DeterministicRandom,
): number => {
  if (pattern === "steady") return Math.max(0, Math.round(expectedCount));
  if (pattern === "poisson") return samplePoissonCount(expectedCount, random);
  const intensityMultiplier = Math.exp(
    BURST_LOG_RATE_SIGMA * standardNormal(random) -
      (BURST_LOG_RATE_SIGMA * BURST_LOG_RATE_SIGMA) / 2,
  );
  return samplePoissonCount(expectedCount * intensityMultiplier, random);
};

export const arrivalSquaredCoefficientOfVariation = (
  pattern: ArrivalPattern,
): number =>
  pattern === "steady" ? 0 : pattern === "poisson" ? 1 : 1 + BURST_RATE_SCV;

/**
 * Allen-Cunneen-style G/G/c waiting-time approximation. It is used only for
 * resource wait, not as a claim that a real service has exponential service
 * times or a stationary workload. Unstable queues are capped at the client
 * timeout because work beyond that boundary is represented as timeout/error.
 */
export const estimateQueueingDelay = ({
  arrivalRateRps,
  capacityRps,
  parallelServers,
  serviceTimeMs,
  arrivalScv,
  serviceScv = 1,
  timeoutMs,
}: QueueingDelayInput): QueueingDelayEstimate => {
  const utilization =
    capacityRps <= 0 ? Number.POSITIVE_INFINITY : arrivalRateRps / capacityRps;
  if (arrivalRateRps <= 0 || serviceTimeMs <= 0)
    return { utilization, waitMs: 0, stable: utilization < 1 };

  const variability = Math.max(0, (arrivalScv + serviceScv) / 2);
  const servers = Math.max(1, Math.floor(parallelServers));
  if (utilization >= 1) {
    const overload = utilization - 1;
    return {
      utilization,
      waitMs: Math.min(
        timeoutMs,
        serviceTimeMs * (1 + 12 * overload) + timeoutMs * clamp(overload, 0, 1),
      ),
      stable: false,
    };
  }

  const exponent = Math.sqrt(2 * (servers + 1)) - 1;
  const waitMs =
    variability *
    (utilization ** exponent /
      (servers * Math.max(0.000_001, 1 - utilization))) *
    serviceTimeMs;
  return {
    utilization,
    waitMs: clamp(waitMs, 0, timeoutMs),
    stable: true,
  };
};

/** Mutates a bounded FIFO cohort list and returns exact aggregate queue age. */
export const advanceFifoQueue = (
  cohorts: QueueCohort[],
  second: number,
  arrivals: number,
  serviceCapacity: number,
): QueueAdvanceResult => {
  const safeArrivals = Math.max(0, arrivals);
  if (safeArrivals > 0) {
    const prior = cohorts.at(-1);
    if (prior?.enqueuedSecond === second) prior.count += safeArrivals;
    else cohorts.push({ enqueuedSecond: second, count: safeArrivals });
  }

  let remainingCapacity = Math.max(0, serviceCapacity);
  let processed = 0;
  while (remainingCapacity > 0 && cohorts.length > 0) {
    const cohort = cohorts[0]!;
    const drained = Math.min(cohort.count, remainingCapacity);
    cohort.count -= drained;
    remainingCapacity -= drained;
    processed += drained;
    if (cohort.count <= 0.000_001) cohorts.shift();
  }

  const depth = cohorts.reduce((total, cohort) => total + cohort.count, 0);
  const oldestAgeMs = cohorts.length
    ? Math.max(0, second - cohorts[0]!.enqueuedSecond) * 1_000
    : 0;
  return { processed, depth, oldestAgeMs };
};
