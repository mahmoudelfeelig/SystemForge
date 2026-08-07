import {
  architectureSchema,
  scenarioSchema,
  type Architecture,
  type CausalEvent,
  type MetricFrame,
  type Requirement,
  type RequirementResult,
  type Scenario,
  type SimulationResult,
} from "@systemforge/contracts";
import { DeterministicRandom } from "./prng";

export const ENGINE_VERSION = "0.1.0";

const rounded = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const requirementPassed = (
  requirement: Requirement,
  actual: number,
): boolean => {
  if (requirement.operator === "lte") return actual <= requirement.target;
  if (requirement.operator === "gte") return actual >= requirement.target;
  return actual === requirement.target;
};

const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index] ?? 0;
};

const evaluateRequirements = (
  scenario: Scenario,
  frames: MetricFrame[],
): RequirementResult[] => {
  const availability =
    frames.reduce((total, frame) => total + frame.availability, 0) /
    Math.max(1, frames.length);
  const metricValues: Record<Requirement["metric"], number> = {
    availability: rounded(availability, 4),
    p50LatencyMs: rounded(
      percentile(
        frames.map((frame) => frame.p50LatencyMs),
        0.95,
      ),
    ),
    p95LatencyMs: rounded(
      percentile(
        frames.map((frame) => frame.p95LatencyMs),
        0.95,
      ),
    ),
    p99LatencyMs: rounded(
      percentile(
        frames.map((frame) => frame.p99LatencyMs),
        0.99,
      ),
    ),
    errorRate: rounded(
      percentile(
        frames.map((frame) => frame.errorRate),
        0.95,
      ),
      4,
    ),
    monthlyCostEur: rounded(
      Math.max(...frames.map((frame) => frame.monthlyCostEur)),
    ),
    dataLoss: rounded(
      frames.reduce((total, frame) => total + frame.dataLoss, 0),
    ),
    consistencyViolations: rounded(
      frames.reduce((total, frame) => total + frame.consistencyViolations, 0),
    ),
    throughputRps: rounded(
      percentile(
        frames.map((frame) => frame.throughputRps),
        0.5,
      ),
    ),
    queueDepth: rounded(Math.max(...frames.map((frame) => frame.queueDepth))),
  };
  return scenario.requirements.map((requirement) => {
    const actual = metricValues[requirement.metric];
    return {
      requirement,
      actual,
      passed: requirementPassed(requirement, actual),
    };
  });
};

export function simulate(
  inputScenario: Scenario,
  inputArchitecture: Architecture,
): SimulationResult {
  const scenario = scenarioSchema.parse(inputScenario);
  const architecture = architectureSchema.parse(inputArchitecture);
  const random = new DeterministicRandom(scenario.seed);
  const node = (kind: Architecture["nodes"][number]["kind"]) =>
    architecture.nodes.find((candidate) => candidate.kind === kind);
  const api = node("api");
  const cache = node("cache");
  const database = node("database");
  const queue = node("queue");
  const worker = node("worker");
  const pathLatency =
    architecture.nodes.reduce(
      (total, candidate) => total + candidate.config.baseLatencyMs,
      0,
    ) / 3;
  const monthlyCost = architecture.nodes.reduce(
    (total, candidate) =>
      total + candidate.config.monthlyCostEur * candidate.config.instances,
    0,
  );
  const frames: MetricFrame[] = [];
  const events: CausalEvent[] = [];
  const emitted = new Set<string>();
  let trafficMultiplier = 1;
  let cacheAvailable = true;
  let databaseMultiplier = 1;
  let consumerMultiplier = 1;
  let queueDepth = 0;
  let retryAmplification = 1;
  let lastCausalId = "";

  const emit = (
    id: string,
    second: number,
    kind: string,
    severity: CausalEvent["severity"],
    title: string,
    detail: string,
    entityId?: string,
  ): void => {
    if (emitted.has(id)) return;
    emitted.add(id);
    const parentIds = lastCausalId ? [lastCausalId] : [];
    events.push({
      id,
      second,
      kind,
      severity,
      title,
      detail,
      entityId,
      parentIds,
    });
    lastCausalId = id;
  };

  for (
    let second = 0;
    second <= scenario.workload.durationSeconds;
    second += 1
  ) {
    for (const incident of scenario.incidents.filter(
      (candidate) => candidate.atSecond === second,
    )) {
      if (incident.kind === "traffic-spike")
        trafficMultiplier = incident.magnitude;
      if (incident.kind === "cache-failure") cacheAvailable = false;
      if (incident.kind === "cache-recovery") cacheAvailable = true;
      if (incident.kind === "database-degradation")
        databaseMultiplier = Math.max(0.05, 1 / incident.magnitude);
      if (incident.kind === "database-recovery") databaseMultiplier = 1;
      if (incident.kind === "queue-consumer-slowdown")
        consumerMultiplier = Math.max(0.05, 1 / incident.magnitude);
      emit(
        `incident-${incident.id}`,
        second,
        incident.kind,
        incident.kind.includes("recovery") ? "info" : "warning",
        incident.label,
        `Scenario incident changed ${incident.kind.replaceAll("-", " ")} behavior.`,
      );
    }

    const ramp =
      0.84 +
      0.16 * Math.sin((second / scenario.workload.durationSeconds) * Math.PI);
    const requestedRps =
      scenario.workload.baseRps *
      ramp *
      trafficMultiplier *
      retryAmplification *
      random.between(0.97, 1.03);
    const apiCapacity = api ? api.config.instances * api.config.capacityRps : 1;
    const cacheCapacity =
      cache && cacheAvailable
        ? cache.config.instances * cache.config.capacityRps
        : 0;
    const cacheHitRate =
      cacheAvailable && cache ? cache.config.cacheHitRate : 0;
    const readRps = requestedRps * scenario.workload.readRatio;
    const writeRps = requestedRps - readRps;
    const cacheableReads = Math.min(readRps * cacheHitRate, cacheCapacity);
    const databaseDemand = readRps - cacheableReads + writeRps;
    const databaseCapacity = database
      ? database.config.instances *
        database.config.capacityRps *
        databaseMultiplier
      : 1;
    const queueDemand = queue ? writeRps * 0.35 : 0;
    const consumerCapacity = worker
      ? worker.config.instances * worker.config.capacityRps * consumerMultiplier
      : queueDemand;
    queueDepth = Math.max(0, queueDepth + queueDemand - consumerCapacity);
    const apiSaturation = requestedRps / Math.max(1, apiCapacity);
    const databaseSaturation = databaseDemand / Math.max(1, databaseCapacity);
    const queueSaturation = queue
      ? queueDemand /
        Math.max(1, queue.config.instances * queue.config.capacityRps)
      : 0;
    const dominantSaturation = Math.max(
      apiSaturation,
      databaseSaturation,
      queueSaturation,
      0.25,
    );
    const overload = Math.max(0, dominantSaturation - 0.88);
    const errorRate = Math.min(0.95, overload ** 2 * 0.42);
    const nextRetryAmplification = 1 + Math.min(1.8, errorRate * 3.2);
    const congestionLatency = pathLatency * (1 + dominantSaturation ** 3.2);
    const queueLatency = queue
      ? (queueDepth / Math.max(1, consumerCapacity)) * 1_000
      : 0;
    const p50LatencyMs = congestionLatency * random.between(0.91, 1.09);
    const p95LatencyMs =
      p50LatencyMs * (1.7 + dominantSaturation * 0.36) + queueLatency * 0.2;
    const p99LatencyMs = p95LatencyMs * (1.48 + errorRate * 2.4);
    const throughputRps = requestedRps * (1 - errorRate);
    const dataLoss =
      !database || (databaseSaturation > 2.2 && database.config.replicas === 0)
        ? writeRps * errorRate * 0.01
        : 0;
    const consistencyViolations =
      database?.config.consistency === "eventual" && databaseSaturation > 1
        ? Math.floor((databaseSaturation - 1) * writeRps * 0.0004)
        : 0;

    if (!cacheAvailable)
      emit(
        "cache-miss-collapse",
        second,
        "cache-miss-collapse",
        "warning",
        "Cache hit rate collapsed",
        `${Math.round(readRps)} reads/s are bypassing the unavailable cache.`,
        cache?.id,
      );
    if (databaseSaturation > 1)
      emit(
        "database-overload",
        second,
        "resource-saturation",
        "critical",
        "Database capacity exceeded",
        `Database demand is ${rounded(databaseSaturation * 100)}% of modeled capacity.`,
        database?.id,
      );
    if (databaseSaturation > 1.18)
      emit(
        "connection-exhaustion",
        second,
        "connection-exhaustion",
        "critical",
        "Database connections exhausted",
        "Requests are waiting longer than the configured connection budget.",
        database?.id,
      );
    if (nextRetryAmplification > 1.2)
      emit(
        "retry-storm",
        second,
        "retry-storm",
        "critical",
        "Retry amplification detected",
        `Clients are generating ${rounded(nextRetryAmplification)}x effective traffic.`,
        api?.id,
      );

    retryAmplification = nextRetryAmplification;
    const nodeUtilization: Record<string, number> = {};
    for (const candidate of architecture.nodes) {
      let utilization =
        requestedRps /
        Math.max(1, candidate.config.instances * candidate.config.capacityRps);
      if (candidate.kind === "cache")
        utilization = cacheAvailable ? readRps / Math.max(1, cacheCapacity) : 0;
      if (candidate.kind === "database") utilization = databaseSaturation;
      if (candidate.kind === "queue") utilization = queueSaturation;
      if (candidate.kind === "worker")
        utilization = queueDemand / Math.max(1, consumerCapacity);
      nodeUtilization[candidate.id] = rounded(Math.min(1.99, utilization), 4);
    }

    frames.push({
      second,
      rps: rounded(requestedRps),
      throughputRps: rounded(throughputRps),
      p50LatencyMs: rounded(p50LatencyMs),
      p95LatencyMs: rounded(p95LatencyMs),
      p99LatencyMs: rounded(p99LatencyMs),
      errorRate: rounded(errorRate * 100, 4),
      availability: rounded((1 - errorRate) * 100, 5),
      queueDepth: rounded(queueDepth),
      retryAmplification: rounded(retryAmplification, 3),
      monthlyCostEur: rounded(monthlyCost),
      dataLoss: rounded(dataLoss),
      consistencyViolations,
      nodeUtilization,
    });
  }

  const requirements = evaluateRequirements(scenario, frames);
  return {
    engineVersion: ENGINE_VERSION,
    seed: scenario.seed,
    frames,
    events,
    requirements,
    score: {
      passed: requirements.filter((result) => result.passed).length,
      total: requirements.length,
    },
  };
}
