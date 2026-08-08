import {
  architectureSchema,
  scenarioSchema,
  type Architecture,
  type ArchitectureNode,
  type CausalEvent,
  type Incident,
  type MetricFrame,
  type NodeMetricSnapshot,
  type Requirement,
  type RequirementResult,
  type Scenario,
  type SimulationResult,
} from "@systemforge/contracts";
import { DeterministicRandom } from "./prng";

export const ENGINE_VERSION = "0.3.0";

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const rounded = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const average = (values: number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;

const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index] ?? 0;
};

const requirementPassed = (
  requirement: Requirement,
  actual: number,
): boolean => {
  if (requirement.operator === "lte") return actual <= requirement.target;
  if (requirement.operator === "gte") return actual >= requirement.target;
  return actual === requirement.target;
};

const evaluateRequirements = (
  scenario: Scenario,
  frames: MetricFrame[],
): RequirementResult[] => {
  const metricValues: Record<Requirement["metric"], number> = {
    availability: rounded(
      average(frames.map((frame) => frame.availability)),
      4,
    ),
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
    maxQueueAgeMs: rounded(
      Math.max(...frames.map((frame) => frame.maxQueueAgeMs)),
    ),
    durabilityPercent: rounded(
      Math.min(...frames.map((frame) => frame.durabilityPercent)),
      6,
    ),
    replicaLagMs: rounded(
      Math.max(...frames.map((frame) => frame.replicaLagMs)),
    ),
    recoveryTimeSeconds: rounded(
      Math.max(...frames.map((frame) => frame.recoveryTimeSeconds)),
    ),
    residencyViolations: rounded(
      frames.reduce((total, frame) => total + frame.residencyViolations, 0),
    ),
    operationalComplexity: rounded(
      Math.max(...frames.map((frame) => frame.operationalComplexity)),
    ),
  };

  return scenario.requirements.map((requirement) => ({
    requirement,
    actual: metricValues[requirement.metric],
    passed: requirementPassed(requirement, metricValues[requirement.metric]),
  }));
};

interface RuntimeNodeState {
  activeInstances: number;
  pendingInstances: number;
  pendingReadyAt: number;
  lastScaleSecond: number;
  queueDepth: number;
  memoryLeakMb: number;
}

interface WorkloadProfile {
  readRatio: number;
  payloadKb: number;
  computeMs: number;
  databaseQueries: number;
  cacheableShare: number;
  criticalShare: number;
}

interface EdgeRuntimeProfile {
  trafficShare: number;
  synchronousBaseLatencyMs: number;
  synchronousJitterMs: number;
  packetLossRate: number;
  bandwidthMbps: number;
  allAsynchronous: boolean;
}

const USER_CONCURRENCY_KINDS = new Set<ArchitectureNode["kind"]>([
  "cdn",
  "load-balancer",
  "api",
]);

type RequestMixItem = NonNullable<Scenario["workload"]["requestMix"]>[number];

const workloadProfile = (scenario: Scenario): WorkloadProfile => {
  const mix = scenario.workload.requestMix;
  if (!mix || mix.length === 0) {
    return {
      readRatio: scenario.workload.readRatio,
      payloadKb: 8,
      computeMs: 4,
      databaseQueries: 1,
      cacheableShare: scenario.workload.readRatio,
      criticalShare: 0.28,
    };
  }
  const totalShare = Math.max(
    0.000_001,
    mix.reduce((total, request) => total + request.share, 0),
  );
  const weighted = (selector: (request: RequestMixItem) => number) =>
    mix.reduce(
      (total, request) => total + selector(request) * request.share,
      0,
    ) / totalShare;
  return {
    readRatio: clamp(
      weighted((request) => request.readRatio),
      0,
      1,
    ),
    payloadKb: weighted((request) => request.payloadKb),
    computeMs: weighted((request) => request.computeMs),
    databaseQueries: weighted((request) => request.databaseQueries),
    cacheableShare: clamp(
      weighted((request) => (request.cacheable ? request.readRatio : 0)) /
        Math.max(
          0.000_001,
          weighted((request) => request.readRatio),
        ),
      0,
      1,
    ),
    criticalShare: weighted((request) => (request.critical ? 1 : 0)),
  };
};

const defaultIncidentDuration = (
  incident: Incident,
  scenario: Scenario,
): number => {
  if (incident.durationSeconds) return incident.durationSeconds;
  if (
    incident.kind === "traffic-spike" ||
    incident.kind === "memory-leak" ||
    incident.kind === "cache-failure" ||
    incident.kind === "database-degradation"
  )
    return Math.max(1, scenario.workload.durationSeconds - incident.atSecond);
  if (incident.kind.includes("recovery")) return 1;
  if (incident.kind === "gc-pause" || incident.kind === "leader-election")
    return 8;
  return 30;
};

const incidentAffectsNode = (
  incident: Incident,
  node: ArchitectureNode,
): boolean => {
  if (incident.targetId && incident.targetId !== node.id) return false;
  if (
    incident.region &&
    incident.region !== node.config.behavior?.topology?.region
  )
    return false;
  if (incident.zone && incident.zone !== node.config.behavior?.topology?.zone)
    return false;
  if (
    incident.failureDomain &&
    incident.failureDomain !== node.config.behavior?.topology?.failureDomain
  )
    return false;
  return true;
};

const incidentDetail = (incident: Incident): string => {
  const target = incident.targetId
    ? ` on ${incident.targetId}`
    : incident.region
      ? ` in ${incident.region}`
      : incident.zone
        ? ` in ${incident.zone}`
        : incident.failureDomain
          ? ` in ${incident.failureDomain}`
          : "";
  return `${incident.kind.replaceAll("-", " ")}${target} entered the event schedule at ${incident.atSecond}s with ${incident.magnitude}x magnitude.`;
};

const rootRecommendation = (kind: Incident["kind"]): string[] => {
  if (kind === "ddos" || kind === "bot-attack")
    return [
      "Combine edge filtering with bounded origin capacity.",
      "Use load shedding so legitimate local work remains responsive.",
    ];
  if (kind.includes("cache") || kind === "hot-key")
    return [
      "Add cache redundancy and staggered TTLs.",
      "Protect the durable store with request coalescing and admission control.",
    ];
  if (
    kind.includes("database") ||
    kind === "disk-saturation" ||
    kind === "hot-shard"
  )
    return [
      "Separate read and write pressure before increasing raw capacity.",
      "Inspect connection, IOPS, lock and partition saturation independently.",
    ];
  if (kind.includes("network") || kind === "packet-loss")
    return [
      "Bound retries and apply jittered backoff.",
      "Design degraded behavior for partial connectivity.",
    ];
  return ["Inspect the causal path before changing component capacity."];
};

const reachableNodes = (architecture: Architecture): Set<string> => {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of architecture.nodes) incoming.set(node.id, 0);
  for (const edge of architecture.edges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, [
      ...(outgoing.get(edge.source) ?? []),
      edge.target,
    ]);
  }
  const explicitSources = architecture.nodes.filter(
    (node) => node.kind === "users" || node.kind === "region",
  );
  const sources =
    explicitSources.length > 0
      ? explicitSources
      : architecture.nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0);
  if (sources.length === 0)
    return new Set(architecture.nodes.map((node) => node.id));
  const reached = new Set<string>();
  const pending = sources.map((node) => node.id);
  while (pending.length > 0) {
    const id = pending.shift();
    if (!id || reached.has(id)) continue;
    reached.add(id);
    for (const target of outgoing.get(id) ?? []) pending.push(target);
  }
  return reached;
};

const operationalComplexity = (architecture: Architecture): number => {
  const kinds = new Set(architecture.nodes.map((node) => node.kind)).size;
  const regions = new Set(
    architecture.nodes
      .map((node) => node.config.behavior?.topology?.region)
      .filter(Boolean),
  ).size;
  const componentWeight = architecture.nodes.reduce((total, node) => {
    const behavior = node.config.behavior;
    const replicaWeight = Math.log2(node.config.replicas + 1) * 1.4;
    const partitionWeight = Math.log2(
      (behavior?.storage?.partitions ?? behavior?.messaging?.partitions ?? 1) +
        1,
    );
    const managedDiscount = behavior?.operations?.managed ? 0.6 : 1;
    return (
      total +
      managedDiscount *
        (behavior?.operations?.complexityWeight ??
          1.5 + replicaWeight + partitionWeight)
    );
  }, 0);
  return rounded(
    clamp(componentWeight + kinds * 1.2 + Math.max(0, regions - 1) * 5, 0, 100),
  );
};

const stateForUtilization = (
  utilization: number,
  offline: boolean,
): NodeMetricSnapshot["state"] => {
  if (offline) return "offline";
  if (utilization >= 1) return "critical";
  if (utilization >= 0.72) return "warning";
  return "healthy";
};

export function simulate(
  inputScenario: Scenario,
  inputArchitecture: Architecture,
): SimulationResult {
  const scenario = scenarioSchema.parse(inputScenario);
  const architecture = architectureSchema.parse(inputArchitecture);
  const random = new DeterministicRandom(scenario.seed);
  const profile = workloadProfile(scenario);
  const reachable = reachableNodes(architecture);
  const frames: MetricFrame[] = [];
  const events: CausalEvent[] = [];
  const emitted = new Set<string>();
  const runtime = new Map<string, RuntimeNodeState>(
    architecture.nodes.map((node) => [
      node.id,
      {
        activeInstances: node.config.instances,
        pendingInstances: 0,
        pendingReadyAt: Number.POSITIVE_INFINITY,
        lastScaleSecond: Number.NEGATIVE_INFINITY,
        queueDepth: 0,
        memoryLeakMb: 0,
      },
    ]),
  );
  const incomingEdges = new Map<string, Architecture["edges"]>();
  for (const edge of architecture.edges)
    incomingEdges.set(edge.target, [
      ...(incomingEdges.get(edge.target) ?? []),
      edge,
    ]);
  const edgeProfiles = new Map<string, EdgeRuntimeProfile>();
  for (const node of architecture.nodes) {
    const incoming = incomingEdges.get(node.id) ?? [];
    const explicitShares = incoming
      .map((edge) => edge.config?.trafficShare)
      .filter((share): share is number => share !== undefined);
    const synchronous = incoming.filter((edge) => !edge.config?.asynchronous);
    edgeProfiles.set(node.id, {
      trafficShare:
        explicitShares.length > 0
          ? clamp(
              explicitShares.reduce((total, share) => total + share, 0),
              0,
              1,
            )
          : 1,
      synchronousBaseLatencyMs: average(
        synchronous.map((edge) => edge.config?.baseLatencyMs ?? 0),
      ),
      synchronousJitterMs: average(
        synchronous.map((edge) => edge.config?.jitterMs ?? 0),
      ),
      packetLossRate:
        1 -
        incoming.reduce(
          (survival, edge) =>
            survival * (1 - (edge.config?.packetLossRate ?? 0)),
          1,
        ),
      bandwidthMbps: incoming.reduce(
        (total, edge) => total + (edge.config?.bandwidthMbps ?? 0),
        0,
      ),
      allAsynchronous:
        incoming.length > 0 &&
        incoming.every((edge) => edge.config?.asynchronous),
    });
  }
  const asynchronousTargets = new Set(
    architecture.nodes
      .filter((node) => edgeProfiles.get(node.id)?.allAsynchronous)
      .map((node) => node.id),
  );
  const incidentsAt = new Map<number, Incident[]>();
  for (const incident of scenario.incidents) {
    incidentsAt.set(incident.atSecond, [
      ...(incidentsAt.get(incident.atSecond) ?? []),
      incident,
    ]);
  }
  const complexity = operationalComplexity(architecture);
  const reachableNodesByKind = new Map<
    ArchitectureNode["kind"],
    ArchitectureNode[]
  >();
  for (const node of architecture.nodes) {
    if (!reachable.has(node.id)) continue;
    reachableNodesByKind.set(node.kind, [
      ...(reachableNodesByKind.get(node.kind) ?? []),
      node,
    ]);
  }
  const countKind = (kind: ArchitectureNode["kind"]): number =>
    Math.max(1, reachableNodesByKind.get(kind)?.length ?? 0);
  const nodesOfKind = (kind: ArchitectureNode["kind"]) =>
    reachableNodesByKind.get(kind) ?? [];
  let retryAmplification = 1;
  let cumulativeWrites = 0;
  let cumulativeLoss = 0;

  const emit = (event: CausalEvent): void => {
    if (emitted.has(event.id)) return;
    emitted.add(event.id);
    events.push(event);
  };

  for (
    let second = 0;
    second <= scenario.workload.durationSeconds;
    second += 1
  ) {
    for (const incident of incidentsAt.get(second) ?? []) {
      emit({
        id: `incident-${incident.id}`,
        second,
        kind: incident.kind,
        severity: incident.kind.includes("recovery") ? "info" : "warning",
        title: incident.label,
        detail: incidentDetail(incident),
        entityId: incident.targetId,
        parentIds: [],
        effects: [
          {
            metric: "scheduled-event",
            delta: incident.magnitude,
            label: `${incident.magnitude}x magnitude`,
          },
        ],
        recommendations: rootRecommendation(incident.kind),
      });
    }

    const activeIncidents = scenario.incidents.filter((incident) => {
      if (incident.kind.includes("recovery")) return false;
      const end =
        incident.atSecond + defaultIncidentDuration(incident, scenario);
      return second >= incident.atSecond && second < end;
    });
    const latestToggle = (
      node: ArchitectureNode,
      down: Incident["kind"],
      up: Incident["kind"],
    ): Incident | undefined => {
      let latest: Incident | undefined;
      for (const incident of scenario.incidents) {
        if (
          incident.atSecond <= second &&
          (incident.kind === down || incident.kind === up) &&
          incidentAffectsNode(incident, node) &&
          (!latest || incident.atSecond >= latest.atSecond)
        )
          latest = incident;
      }
      return latest;
    };

    const arrivalPattern = scenario.workload.arrivalPattern ?? "bursty";
    const phase = second / scenario.workload.durationSeconds;
    const peakIntensity =
      arrivalPattern === "steady"
        ? 0
        : arrivalPattern === "poisson"
          ? 0.12 + 0.08 * Math.sin(phase * Math.PI) ** 2
          : Math.sin(phase * Math.PI) ** 6;
    const scheduledRps =
      scenario.workload.baseRps +
      (scenario.workload.peakRps - scenario.workload.baseRps) * peakIntensity;
    const arrivalNoise =
      arrivalPattern === "steady"
        ? random.between(0.995, 1.005)
        : arrivalPattern === "poisson"
          ? average(Array.from({ length: 5 }, () => random.between(0.82, 1.18)))
          : random.between(0.94, 1.08) * (1 + 0.08 * Math.sin(second / 4));
    let trafficMultiplier = 1;
    let maliciousTrafficShare = 0;
    let payloadMultiplier = 1;
    for (const incident of activeIncidents) {
      if (
        incident.kind === "traffic-spike" ||
        incident.kind === "thundering-herd"
      )
        trafficMultiplier *= incident.magnitude;
      if (incident.kind === "bot-attack") {
        trafficMultiplier *= incident.magnitude;
        maliciousTrafficShare = Math.max(maliciousTrafficShare, 0.45);
      }
      if (incident.kind === "ddos") {
        trafficMultiplier *= incident.magnitude;
        maliciousTrafficShare = Math.max(maliciousTrafficShare, 0.82);
      }
      if (incident.kind === "large-payload")
        payloadMultiplier *= incident.magnitude;
    }
    const requestedRps =
      scheduledRps * arrivalNoise * trafficMultiplier * retryAmplification;
    const readRps = requestedRps * profile.readRatio;
    const writeRps = requestedRps - readRps;
    cumulativeWrites += writeRps;

    const cacheNodes = nodesOfKind("cache");
    const cacheHitRate =
      cacheNodes.length === 0
        ? 0
        : average(
            cacheNodes.map((node) => {
              const toggle = latestToggle(
                node,
                "cache-failure",
                "cache-recovery",
              );
              if (toggle?.kind === "cache-failure") return 0;
              let hitRate = node.config.cacheHitRate;
              const relevant = activeIncidents.filter((incident) =>
                incidentAffectsNode(incident, node),
              );
              for (const incident of relevant) {
                if (incident.kind === "cache-eviction-storm")
                  hitRate /= incident.magnitude;
                if (incident.kind === "cache-stampede") hitRate *= 0.2;
                if (incident.kind === "hot-key")
                  hitRate *= 1 - clamp(incident.magnitude / 100, 0.05, 0.7);
              }
              const cache = node.config.behavior?.cache;
              const warmup = cache?.warmupSeconds ?? 0;
              if (second < warmup) hitRate *= second / Math.max(1, warmup);
              const ttlSeconds = cache?.ttlSeconds ?? 300;
              if (ttlSeconds === 0) return 0;
              const workingSetGb =
                (readRps *
                  profile.cacheableShare *
                  profile.payloadKb *
                  ttlSeconds) /
                1_000_000;
              const capacityGb =
                (cache?.capacityGb ?? 32) *
                (runtime.get(node.id)?.activeInstances ?? 1);
              const pressure = workingSetGb / Math.max(0.001, capacityGb);
              if (pressure > 1) {
                const policyFactor =
                  cache?.evictionPolicy === "lfu"
                    ? 0.93
                    : cache?.evictionPolicy === "fifo"
                      ? 0.72
                      : cache?.evictionPolicy === "random"
                        ? 0.6
                        : 0.85;
                hitRate *= policyFactor / Math.sqrt(pressure);
              }
              hitRate *= 1 - (cache?.hotKeyFraction ?? 0) * 0.35;
              return clamp(hitRate, 0, 1);
            }),
          );
    const cacheCapacity = cacheNodes.reduce((total, node) => {
      const state = runtime.get(node.id)!;
      const hotKey = node.config.behavior?.cache?.hotKeyFraction ?? 0;
      return (
        total +
        node.config.capacityRps * state.activeInstances * (1 - hotKey * 0.65)
      );
    }, 0);
    const cacheableReads = readRps * profile.cacheableShare;
    const cacheHits = Math.min(cacheableReads * cacheHitRate, cacheCapacity);
    const databaseReadRps = Math.max(0, readRps - cacheHits);
    const databaseDemand =
      (databaseReadRps + writeRps) * Math.max(0.1, profile.databaseQueries);
    const queueDemand = writeRps * (0.2 + profile.criticalShare * 0.35);

    if (cacheNodes.length > 0 && cacheHitRate < 0.1)
      emit({
        id: "cache-hit-collapse",
        second,
        kind: "cache-miss-collapse",
        severity: "warning",
        title: "Cache hit rate collapsed",
        detail: `${Math.round(databaseReadRps)} reads/s are reaching durable storage after cache effectiveness fell to ${rounded(cacheHitRate * 100)}%.`,
        entityId: cacheNodes[0]?.id,
        parentIds: events
          .filter(
            (event) =>
              event.second <= second &&
              (event.kind.includes("cache") || event.kind === "hot-key"),
          )
          .slice(-1)
          .map((event) => event.id),
        recommendations: rootRecommendation("cache-failure"),
      });

    const demandFor = (node: ArchitectureNode): number => {
      if (!reachable.has(node.id)) return 0;
      if (
        node.kind === "users" ||
        node.kind === "region" ||
        node.kind === "cdn" ||
        node.kind === "network" ||
        node.kind === "load-balancer" ||
        node.kind === "api"
      )
        return requestedRps / countKind(node.kind);
      if (node.kind === "dns") return requestedRps / 120 / countKind("dns");
      if (node.kind === "cache") return readRps / countKind("cache");
      if (node.kind === "database")
        return databaseDemand / countKind("database");
      if (node.kind === "queue" || node.kind === "stream")
        return queueDemand / countKind(node.kind);
      if (node.kind === "worker") return queueDemand / countKind("worker");
      if (node.kind === "object-store")
        return (requestedRps * 0.06) / countKind("object-store");
      return (requestedRps * 0.12) / countKind("third-party");
    };

    const nodeMetrics: Record<string, NodeMetricSnapshot> = {};
    let totalMonthlyCost = 0;
    let queueDepth = 0;
    let maxQueueAgeMs = 0;
    let replicaLagMs = 0;
    let recoveryTimeSeconds = 0;
    let residencyViolations = 0;
    let frameDataLoss = 0;
    let frameConsistencyViolations = 0;

    for (const node of architecture.nodes) {
      const state = runtime.get(node.id)!;
      if (state.pendingInstances > 0 && second >= state.pendingReadyAt) {
        state.activeInstances = Math.min(
          node.config.maxInstances,
          state.activeInstances + state.pendingInstances,
        );
        state.pendingInstances = 0;
        state.pendingReadyAt = Number.POSITIVE_INFINITY;
      }
      const behavior = node.config.behavior;
      const replicationMode =
        behavior?.storage?.replicationMode ??
        (node.config.replicas > 0 ? "async" : "none");
      const edgeProfile = edgeProfiles.get(node.id)!;
      const demand = demandFor(node) * edgeProfile.trafficShare;
      const edgeLatencyMs =
        edgeProfile.synchronousBaseLatencyMs +
        edgeProfile.synchronousJitterMs * random.between(0.2, 1);
      const relevant = activeIncidents.filter((incident) =>
        incidentAffectsNode(incident, node),
      );
      const cacheToggle = latestToggle(node, "cache-failure", "cache-recovery");
      const databaseToggle = latestToggle(
        node,
        "database-degradation",
        "database-recovery",
      );
      const nodeFailure = relevant.some(
        (incident) => incident.kind === "node-failure",
      );
      const zoneOutage = relevant.some(
        (incident) => incident.kind === "zone-outage",
      );
      const regionOutage = relevant.some(
        (incident) => incident.kind === "region-outage",
      );
      const multiAz =
        behavior?.topology?.zone?.toLowerCase().includes("multi") ?? false;
      const multiRegion =
        behavior?.topology?.failureDomain
          ?.toLowerCase()
          .includes("multi-region") ?? false;
      let offline =
        (node.kind === "cache" && cacheToggle?.kind === "cache-failure") ||
        (nodeFailure && node.config.replicas === 0) ||
        (zoneOutage && !(multiAz && node.config.replicas > 0)) ||
        (regionOutage && !multiRegion) ||
        relevant.some(
          (incident) =>
            incident.kind === "network-partition" ||
            (incident.kind === "dns-failure" && node.kind === "dns") ||
            (incident.kind === "certificate-expiry" &&
              (node.kind === "cdn" || node.kind === "load-balancer")) ||
            (incident.kind === "third-party-outage" &&
              node.kind === "third-party"),
        );
      let capacityMultiplier =
        databaseToggle?.kind === "database-degradation"
          ? 1 / databaseToggle.magnitude
          : 1;
      if (nodeFailure && node.config.replicas > 0) {
        capacityMultiplier *= node.config.replicas / (node.config.replicas + 1);
        recoveryTimeSeconds = Math.max(
          recoveryTimeSeconds,
          behavior?.storage?.failoverSeconds ?? 20,
        );
      }
      if (zoneOutage && multiAz && node.config.replicas > 0) {
        capacityMultiplier *= 0.62;
        recoveryTimeSeconds = Math.max(
          recoveryTimeSeconds,
          behavior?.storage?.failoverSeconds ?? 30,
        );
      }
      if (regionOutage && multiRegion) {
        capacityMultiplier *= 0.5;
        recoveryTimeSeconds = Math.max(
          recoveryTimeSeconds,
          behavior?.storage?.failoverSeconds ?? 60,
        );
      }
      let latencyMultiplier = 1;
      if (replicationMode === "sync") {
        capacityMultiplier *= 0.86;
        latencyMultiplier *= 1.25;
      }
      if (replicationMode === "quorum") {
        capacityMultiplier *= 0.72;
        latencyMultiplier *= 1.5;
      }
      let packetLoss =
        1 -
        (1 - (behavior?.network?.packetLossRate ?? 0)) *
          (1 - edgeProfile.packetLossRate);
      let errorBonus = 0;
      let lockContention = behavior?.storage?.lockContention ?? 0;
      let hotPartition = behavior?.storage?.hotPartitionFraction ?? 0;
      let poisonRate = behavior?.messaging?.poisonMessageRate ?? 0;
      let badAutoscaling = false;
      state.memoryLeakMb +=
        (behavior?.compute?.memoryLeakMbPerMinute ?? 0) / 60;
      for (const incident of relevant) {
        if (
          incident.kind === "database-lock-contention" &&
          node.kind === "database"
        )
          lockContention = clamp(
            lockContention + incident.magnitude / 10,
            0,
            1,
          );
        if (
          (incident.kind === "disk-saturation" ||
            incident.kind === "hot-shard") &&
          (node.kind === "database" || node.kind === "object-store")
        ) {
          capacityMultiplier /= incident.magnitude;
          if (incident.kind === "hot-shard")
            hotPartition = clamp(hotPartition + 0.35, 0, 0.95);
        }
        if (incident.kind === "gc-pause") {
          capacityMultiplier /= incident.magnitude;
          latencyMultiplier *= incident.magnitude;
        }
        if (incident.kind === "deployment-regression") {
          capacityMultiplier /= Math.sqrt(incident.magnitude);
          latencyMultiplier *= incident.magnitude;
        }
        if (incident.kind === "packet-loss")
          packetLoss = clamp(packetLoss + incident.magnitude / 100, 0, 1);
        if (incident.kind === "slow-network")
          latencyMultiplier *= incident.magnitude;
        if (
          incident.kind === "third-party-slowdown" &&
          node.kind === "third-party"
        )
          latencyMultiplier *= incident.magnitude;
        if (
          incident.kind === "queue-consumer-slowdown" &&
          node.kind === "worker"
        )
          capacityMultiplier /= incident.magnitude;
        if (
          incident.kind === "poison-message" &&
          (node.kind === "queue" || node.kind === "stream")
        ) {
          poisonRate = clamp(
            poisonRate + Math.max(0.04, incident.magnitude * 0.04),
            0,
            1,
          );
          errorBonus += poisonRate * 0.35;
        }
        if (incident.kind === "partition-imbalance")
          capacityMultiplier /= Math.max(1, incident.magnitude * 0.65);
        if (incident.kind === "leader-election") {
          offline = true;
          recoveryTimeSeconds = Math.max(
            recoveryTimeSeconds,
            behavior?.storage?.failoverSeconds ?? 8,
          );
        }
        if (incident.kind === "bad-autoscaling") {
          badAutoscaling = true;
          capacityMultiplier /= Math.max(1.5, incident.magnitude);
          if (incident.atSecond === second) {
            state.activeInstances = Math.max(
              1,
              Math.floor(
                state.activeInstances / Math.max(2, incident.magnitude),
              ),
            );
            state.pendingInstances = 0;
            state.pendingReadyAt = Number.POSITIVE_INFINITY;
          }
        }
        if (incident.kind === "memory-leak")
          state.memoryLeakMb +=
            (behavior?.compute?.memoryLeakMbPerMinute ??
              incident.magnitude * 128) / 60;
        if (incident.kind === "replication-lag")
          replicaLagMs = Math.max(
            replicaLagMs,
            (behavior?.storage?.replicationLagMs ?? 100) * incident.magnitude,
          );
      }
      if (maliciousTrafficShare > 0) {
        const shedding = behavior?.resilience?.loadSheddingThreshold;
        if (shedding) {
          capacityMultiplier *= 1 + maliciousTrafficShare * 0.7;
          errorBonus += maliciousTrafficShare * 0.015;
        }
      }
      const gcPauseMs = behavior?.compute?.gcPauseMs ?? 0;
      const gcIntervalSeconds = behavior?.compute?.gcIntervalSeconds ?? 30;
      const gcPauseActive =
        gcPauseMs > 0 && second > 0 && second % gcIntervalSeconds === 0;
      if (gcPauseActive)
        capacityMultiplier *= clamp(1 - gcPauseMs / 1_000, 0.05, 1);
      if (behavior?.resilience?.bulkhead) capacityMultiplier *= 0.92;
      capacityMultiplier *= 1 - hotPartition * 0.7;
      capacityMultiplier *= 1 - lockContention * 0.65;
      const baseCapacity =
        node.config.capacityRps * state.activeInstances * capacityMultiplier;
      const throughputUtilization = offline
        ? 1.99
        : demand / Math.max(1, baseCapacity);
      const serviceTimeMs =
        behavior?.compute?.serviceTimeMs ??
        Math.max(node.config.baseLatencyMs, profile.computeMs);
      const concurrencyCapacity =
        (behavior?.compute?.concurrencyPerInstance ??
          node.config.maxConnections) * state.activeInstances;
      const requestConcurrency = (demand * serviceTimeMs) / 1_000;
      const persistentConnections = USER_CONCURRENCY_KINDS.has(node.kind)
        ? Math.min(
            (scenario.workload.concurrentUsers ?? 0) / countKind(node.kind),
            (demand * (scenario.workload.clientTimeoutMs ?? 1_000)) / 1_000,
          )
        : 0;
      const connectionUtilization =
        Math.max(requestConcurrency, persistentConnections) /
        Math.max(1, concurrencyCapacity);
      const cpuCores = behavior?.compute?.cpuCores ?? 4;
      const cpuUtilization =
        throughputUtilization *
        (1 + profile.computeMs / Math.max(1, cpuCores * 20));
      const memoryGb = behavior?.compute?.memoryGb ?? 8;
      const memoryUtilization = clamp(
        0.28 + state.memoryLeakMb / Math.max(1, memoryGb * 1_024),
        0,
        1.99,
      );
      const bandwidthMbps = behavior?.network?.bandwidthMbps ?? 10_000;
      const nodeNetworkUtilization =
        (demand * profile.payloadKb * payloadMultiplier * 8) /
        1_000 /
        Math.max(1, bandwidthMbps * state.activeInstances);
      const edgeNetworkUtilization =
        edgeProfile.bandwidthMbps > 0
          ? (demand * profile.payloadKb * payloadMultiplier * 8) /
            1_000 /
            edgeProfile.bandwidthMbps
          : 0;
      const networkUtilization = Math.max(
        nodeNetworkUtilization,
        edgeNetworkUtilization,
      );
      let iopsUtilization = 0;
      if (node.kind === "database" || node.kind === "object-store") {
        const reads = demand * profile.readRatio;
        const writes = demand - reads;
        const physicalReads =
          reads * (1 - (behavior?.storage?.bufferHitRate ?? 0));
        const readIops = behavior?.storage?.readIops ?? node.config.capacityRps;
        const writeIops =
          behavior?.storage?.writeIops ?? node.config.capacityRps * 0.6;
        const readableCopies =
          replicationMode === "none" ? 1 : node.config.replicas + 1;
        const operationUtilization =
          physicalReads /
            Math.max(1, readIops * state.activeInstances * readableCopies) +
          writes / Math.max(1, writeIops * state.activeInstances);
        const diskThroughputMbps =
          behavior?.storage?.diskThroughputMbps ?? 1_000;
        const diskUtilization =
          (demand * profile.payloadKb * payloadMultiplier * 8) /
          1_000 /
          Math.max(1, diskThroughputMbps * state.activeInstances);
        iopsUtilization = Math.max(operationUtilization, diskUtilization);
      }
      let componentQueueDepth = 0;
      let componentQueueAge = 0;
      if (node.kind === "queue" || node.kind === "stream") {
        const consumers = nodesOfKind("worker");
        const consumerInstances = consumers.reduce(
          (total, consumer) =>
            total + (runtime.get(consumer.id)?.activeInstances ?? 0),
          0,
        );
        const consumerCapacity = consumers.reduce((total, consumer) => {
          const consumerState = runtime.get(consumer.id)!;
          const slowdown = activeIncidents
            .filter(
              (incident) =>
                incident.kind === "queue-consumer-slowdown" &&
                incidentAffectsNode(incident, consumer),
            )
            .reduce((factor, incident) => factor / incident.magnitude, 1);
          return (
            total +
            consumer.config.capacityRps *
              consumerState.activeInstances *
              slowdown
          );
        }, 0);
        const partitions = behavior?.messaging?.partitions ?? 1;
        const partitionParallelism = Math.min(
          1,
          partitions / Math.max(1, consumerInstances),
        );
        const batchSize = behavior?.messaging?.batchSize ?? 1;
        const batchEfficiency = 1 + Math.log2(batchSize) * 0.06;
        const delivery = behavior?.messaging?.delivery ?? "at-least-once";
        const deliveryThroughput = delivery === "exactly-once" ? 0.82 : 1;
        const partitionAvailability = relevant
          .filter((incident) => incident.kind === "partition-imbalance")
          .reduce(
            (factor, incident) =>
              factor / Math.max(1, incident.magnitude * 0.65),
            1,
          );
        const processed = Math.max(
          0,
          consumerCapacity *
            partitionParallelism *
            batchEfficiency *
            deliveryThroughput *
            partitionAvailability *
            (1 - poisonRate),
        );
        state.queueDepth = Math.max(0, state.queueDepth + demand - processed);
        componentQueueDepth = state.queueDepth;
        componentQueueAge =
          (state.queueDepth / Math.max(1, processed || demand)) * 1_000 +
          (batchSize > 1
            ? Math.min(1_000, batchSize / Math.max(1, demand)) * 1_000
            : 0);
        queueDepth += componentQueueDepth;
        maxQueueAgeMs = Math.max(maxQueueAgeMs, componentQueueAge);
        const retentionMs =
          (behavior?.messaging?.retentionHours ?? 24) * 3_600_000;
        if (componentQueueAge > retentionMs)
          frameDataLoss += Math.min(
            componentQueueDepth,
            demand * ((componentQueueAge - retentionMs) / 1_000),
          );
        if (delivery === "at-least-once" && componentQueueDepth > 0)
          frameConsistencyViolations += Math.floor(
            demand * (poisonRate + 0.000_05) * (1 + componentQueueAge / 60_000),
          );
      }
      const utilization = clamp(
        Math.max(
          throughputUtilization,
          connectionUtilization,
          cpuUtilization,
          memoryUtilization,
          networkUtilization,
          iopsUtilization,
        ),
        0,
        1.99,
      );
      const overload = Math.max(0, utilization - 0.82);
      const circuitBreaker = behavior?.resilience?.circuitBreaker ?? false;
      const bulkhead = behavior?.resilience?.bulkhead ?? false;
      const loadSheddingThreshold =
        behavior?.resilience?.loadSheddingThreshold ?? 1.35;
      const latencyMs =
        (node.config.baseLatencyMs +
          edgeLatencyMs +
          (behavior?.network?.rttMs ?? 0) +
          (behavior?.network?.jitterMs ?? 0) * random.between(0.2, 1)) *
          latencyMultiplier *
          (1 + utilization ** 2.5) +
        componentQueueAge * 0.15 +
        (gcPauseActive ? gcPauseMs : 0);
      let nodeErrorRate = offline
        ? 1
        : clamp(overload ** 2 * 0.34 + packetLoss + errorBonus, 0, 0.98);
      if (utilization > loadSheddingThreshold)
        nodeErrorRate = Math.min(0.98, nodeErrorRate + 0.04);
      if (circuitBreaker && node.kind === "third-party") nodeErrorRate *= 0.45;
      const timeoutMs =
        behavior?.resilience?.timeoutMs ??
        scenario.workload.clientTimeoutMs ??
        120_000;
      if (latencyMs > timeoutMs)
        nodeErrorRate = clamp(
          nodeErrorRate + (latencyMs - timeoutMs) / Math.max(1, latencyMs),
          0,
          0.98,
        );
      if (bulkhead && nodeErrorRate > 0) nodeErrorRate *= 0.72;

      const scaling = behavior?.scaling;
      const targetUtilization = scaling?.targetUtilization ?? 0.7;
      const cooldownSeconds = scaling?.cooldownSeconds ?? 15;
      const startupSeconds = scaling?.startupSeconds ?? 8;
      if (
        node.config.autoscale &&
        !badAutoscaling &&
        utilization > targetUtilization &&
        state.pendingInstances === 0 &&
        second - state.lastScaleSecond >= cooldownSeconds &&
        state.activeInstances < node.config.maxInstances
      ) {
        state.pendingInstances = Math.min(
          node.config.maxInstances - state.activeInstances,
          Math.max(1, Math.ceil(state.activeInstances * 0.35)),
        );
        state.pendingReadyAt = second + startupSeconds;
        state.lastScaleSecond = second;
        emit({
          id: `autoscale-${node.id}-${second}`,
          second,
          kind: "autoscale-requested",
          severity: "info",
          title: `${node.name} scaling requested`,
          detail: `${state.pendingInstances} instances will be ready after the ${startupSeconds}s startup window.`,
          entityId: node.id,
          parentIds: events
            .filter(
              (event) => event.second <= second && event.severity !== "info",
            )
            .slice(-1)
            .map((event) => event.id),
          effects: [
            {
              metric: "activeInstances",
              delta: state.pendingInstances,
              label: `+${state.pendingInstances} pending`,
            },
          ],
        });
      } else if (
        node.config.autoscale &&
        utilization < targetUtilization * 0.35 &&
        second - state.lastScaleSecond >= cooldownSeconds * 2 &&
        state.activeInstances > (scaling?.minInstances ?? node.config.instances)
      ) {
        state.activeInstances -= 1;
        state.lastScaleSecond = second;
      }

      if (node.kind === "database") {
        const baseLag =
          behavior?.storage?.replicationLagMs ??
          (replicationMode === "sync" || replicationMode === "quorum" ? 8 : 90);
        const lag =
          baseLag *
          (1 + Math.max(0, iopsUtilization - 0.6) * 8) *
          (replicationMode === "none" ? 0 : 1);
        replicaLagMs = Math.max(replicaLagMs, lag);
        if (node.config.consistency === "eventual") {
          const tolerance =
            (scenario.domain?.staleReadToleranceSeconds ?? 0.25) * 1_000;
          if (lag > tolerance)
            frameConsistencyViolations += Math.floor(
              ((lag - tolerance) / Math.max(1, tolerance)) *
                writeRps *
                0.000_15,
            );
        }
        const noDurableReplica =
          node.config.replicas === 0 || replicationMode === "none";
        if (noDurableReplica && (offline || utilization > 1.35))
          frameDataLoss += writeRps * nodeErrorRate * 0.004;
        recoveryTimeSeconds = Math.max(
          recoveryTimeSeconds,
          offline
            ? (behavior?.storage?.failoverSeconds ??
                (node.config.replicas > 0 ? 20 : 300))
            : 0,
        );
        const requiredResidency = scenario.domain?.piiRegion;
        const actualResidency = behavior?.topology?.dataResidency;
        if (
          requiredResidency &&
          actualResidency &&
          requiredResidency !== actualResidency
        )
          residencyViolations += Math.ceil(writeRps * profile.criticalShare);
      }
      if (
        (node.kind === "queue" || node.kind === "stream") &&
        behavior?.messaging?.delivery === "at-most-once"
      )
        frameDataLoss += demand * nodeErrorRate * 0.002;

      const egressCost =
        ((demand * profile.payloadKb * payloadMultiplier * 2_592_000) /
          1_000_000) *
        (behavior?.network?.egressCostPerGb ?? 0);
      totalMonthlyCost +=
        node.config.monthlyCostEur *
          (state.activeInstances + node.config.replicas) +
        egressCost;
      nodeMetrics[node.id] = {
        utilization: rounded(utilization, 4),
        cpuUtilization: rounded(clamp(cpuUtilization, 0, 1.99), 4),
        memoryUtilization: rounded(memoryUtilization, 4),
        connectionUtilization: rounded(
          clamp(connectionUtilization, 0, 1.99),
          4,
        ),
        iopsUtilization: rounded(clamp(iopsUtilization, 0, 1.99), 4),
        networkUtilization: rounded(clamp(networkUtilization, 0, 1.99), 4),
        queueDepth: rounded(componentQueueDepth),
        replicaLagMs: rounded(replicaLagMs),
        activeInstances: state.activeInstances,
        latencyMs: rounded(latencyMs),
        errorRate: rounded(nodeErrorRate * 100, 4),
        state: stateForUtilization(utilization, offline),
      };

      if (utilization > 1) {
        const parent = events
          .filter(
            (event) =>
              event.second <= second &&
              (event.entityId === node.id || event.kind.startsWith("cache")),
          )
          .slice(-1)
          .map((event) => event.id);
        emit({
          id: `saturation-${node.id}`,
          second,
          kind: "resource-saturation",
          severity: "critical",
          title: `${node.name} capacity exceeded`,
          detail: `Modeled demand reached ${rounded(utilization * 100)}% across throughput, CPU, connections, IOPS, memory and network budgets.`,
          entityId: node.id,
          parentIds: parent,
          effects: [
            {
              metric: "utilization",
              delta: rounded(utilization - 1, 3),
              label: `${rounded(utilization * 100)}% utilized`,
            },
          ],
          recommendations: [
            "Inspect the saturated resource dimension before scaling.",
            "Reduce amplification or isolate the failing dependency.",
          ],
        });
      }
      if (
        node.kind === "database" &&
        utilization > 1 &&
        emitted.has("cache-hit-collapse")
      )
        emit({
          id: `cache-cascade-${node.id}`,
          second,
          kind: "cache-cascade",
          severity: "critical",
          title: `${node.name} absorbed the cache miss surge`,
          detail: `The cache collapse shifted read demand onto ${node.name}, which is now at ${rounded(utilization * 100)}% modeled utilization.`,
          entityId: node.id,
          parentIds: ["cache-hit-collapse"],
          effects: [
            {
              metric: "databaseReadRps",
              delta: rounded(databaseReadRps),
              label: `${Math.round(databaseReadRps)} reads/s`,
            },
          ],
          recommendations: [
            "Coalesce cache misses and apply stale-while-revalidate where semantics allow.",
            "Reserve durable-store capacity for critical writes.",
          ],
        });
      if (connectionUtilization > 1)
        emit({
          id: `connections-${node.id}`,
          second,
          kind: "connection-exhaustion",
          severity: "critical",
          title: `${node.name} connections exhausted`,
          detail: `Concurrent work exceeded the configured ${node.config.maxConnections} connections per instance.`,
          entityId: node.id,
          parentIds: emitted.has(`saturation-${node.id}`)
            ? [`saturation-${node.id}`]
            : [],
          recommendations: [
            "Bound concurrency at the caller and tune the connection pool.",
          ],
        });
      if (iopsUtilization > 1)
        emit({
          id: `iops-${node.id}`,
          second,
          kind: "iops-saturation",
          severity: "critical",
          title: `${node.name} storage path saturated`,
          detail: `Read and write IOPS demand reached ${rounded(iopsUtilization * 100)}%.`,
          entityId: node.id,
          parentIds: emitted.has(`saturation-${node.id}`)
            ? [`saturation-${node.id}`]
            : [],
          recommendations: [
            "Reduce query fan-out, increase buffer hits or split hot partitions.",
          ],
        });
    }

    const criticalKinds = new Set<ArchitectureNode["kind"]>([
      "dns",
      "cdn",
      "load-balancer",
      "api",
      "database",
      "third-party",
    ]);
    const criticalGroups = new Map<
      ArchitectureNode["kind"],
      NodeMetricSnapshot[]
    >();
    for (const node of architecture.nodes) {
      if (
        !criticalKinds.has(node.kind) ||
        !reachable.has(node.id) ||
        asynchronousTargets.has(node.id)
      )
        continue;
      const metric = nodeMetrics[node.id];
      if (!metric) continue;
      criticalGroups.set(node.kind, [
        ...(criticalGroups.get(node.kind) ?? []),
        metric,
      ]);
    }
    const nodeErrors = [...criticalGroups.values()]
      .map((metrics) =>
        average(metrics.map((metric) => metric.errorRate / 100)),
      )
      .sort((left, right) => right - left);
    const dominantError = nodeErrors[0] ?? 0;
    const supportingError = average(nodeErrors.slice(1)) * 0.18;
    const baseErrorRate = clamp(dominantError + supportingError, 0, 0.98);
    const nodeLatencies = [...criticalGroups.values()].map((metrics) =>
      average(metrics.map((metric) => metric.latencyMs)),
    );
    const regionalLatency = scenario.workload.regions.reduce(
      (total, region) => total + region.roundTripMs * region.trafficShare,
      0,
    );
    const p50LatencyMs =
      regionalLatency +
      nodeLatencies.reduce((total, latency) => total + latency, 0) * 0.72;
    const provisionalP95LatencyMs =
      p50LatencyMs * (1.55 + Math.max(0, baseErrorRate - 0.01) * 3) +
      maxQueueAgeMs * 0.16;
    const clientTimeoutMs = scenario.workload.clientTimeoutMs ?? 120_000;
    const timeoutErrorRate =
      provisionalP95LatencyMs > clientTimeoutMs
        ? clamp(
            ((provisionalP95LatencyMs - clientTimeoutMs) /
              provisionalP95LatencyMs) *
              0.75,
            0,
            0.75,
          )
        : 0;
    const errorRate = clamp(baseErrorRate + timeoutErrorRate, 0, 0.98);
    const p95LatencyMs =
      p50LatencyMs * (1.55 + Math.max(0, errorRate - 0.01) * 3) +
      maxQueueAgeMs * 0.16;
    const p99LatencyMs =
      p95LatencyMs * (1.42 + errorRate * 2.8) + replicaLagMs * 0.05;
    const clientRetryPolicy = scenario.workload.retryPolicy ?? {
      maxRetries: 3,
      backoffBaseMs: 80,
      jitter: true,
      retryOnTimeout: true,
    };
    const resilienceNodes = architecture.nodes.filter(
      (node) => node.kind === "api" || node.kind === "load-balancer",
    );
    const hasCircuitBreaker = resilienceNodes.some(
      (node) => node.config.behavior?.resilience?.circuitBreaker,
    );
    const hasLoadShedding = resilienceNodes.some(
      (node) => node.config.behavior?.resilience?.loadSheddingThreshold,
    );
    const hasBulkheads = resilienceNodes.some(
      (node) => node.config.behavior?.resilience?.bulkhead,
    );
    const dependencyRetries = Math.max(
      0,
      ...resilienceNodes.map(
        (node) => node.config.behavior?.resilience?.maxRetries ?? 0,
      ),
    );
    const dependencyBackoff = Math.max(
      0,
      ...resilienceNodes.map(
        (node) => node.config.behavior?.resilience?.backoffBaseMs ?? 0,
      ),
    );
    const dependencyJitter = resilienceNodes.some(
      (node) => node.config.behavior?.resilience?.jitter,
    );
    let retryPressure = clientRetryPolicy.retryOnTimeout
      ? Math.max(errorRate, timeoutErrorRate) *
        clientRetryPolicy.maxRetries *
        0.68
      : 0;
    retryPressure += errorRate * dependencyRetries * 0.22;
    if (clientRetryPolicy.jitter) retryPressure *= 0.78;
    if (clientRetryPolicy.backoffBaseMs >= 100) retryPressure *= 0.78;
    if (dependencyJitter) retryPressure *= 0.84;
    if (dependencyBackoff >= 100) retryPressure *= 0.84;
    if (hasCircuitBreaker) retryPressure *= 0.52;
    if (hasLoadShedding) retryPressure *= 0.62;
    if (hasBulkheads) retryPressure *= 0.72;
    const scheduledRetryStorm = activeIncidents
      .filter((incident) => incident.kind === "retry-storm")
      .reduce((pressure, incident) => pressure + incident.magnitude * 0.08, 0);
    if (scheduledRetryStorm > 0)
      retryPressure = (retryPressure + scheduledRetryStorm) * 1.8;
    retryAmplification = 1 + clamp(retryPressure, 0, 2.8);
    if (retryAmplification > 1.2)
      emit({
        id: "retry-amplification",
        second,
        kind: "retry-storm",
        severity: "critical",
        title: "Retry amplification detected",
        detail: `Client behavior is generating ${rounded(retryAmplification)}x effective traffic after failures.`,
        entityId: nodesOfKind("api")[0]?.id,
        parentIds: events
          .filter(
            (event) => event.second <= second && event.severity === "critical",
          )
          .slice(-1)
          .map((event) => event.id),
        effects: [
          {
            metric: "retryAmplification",
            delta: rounded(retryAmplification - 1, 3),
            label: `${rounded(retryAmplification)}x traffic`,
          },
        ],
        recommendations: [
          "Use capped exponential backoff with jitter.",
          "Add circuit breaking and load shedding at dependency boundaries.",
        ],
      });
    if (queueDepth > 0 && maxQueueAgeMs > 1_000)
      emit({
        id: "queue-backlog-growth",
        second,
        kind: "queue-backlog",
        severity: maxQueueAgeMs > 10_000 ? "critical" : "warning",
        title: "Asynchronous backlog is aging",
        detail: `${Math.round(queueDepth)} messages are queued and the oldest modeled work is ${rounded(maxQueueAgeMs / 1_000)}s behind.`,
        entityId: nodesOfKind("queue")[0]?.id ?? nodesOfKind("stream")[0]?.id,
        parentIds: events
          .filter(
            (event) =>
              event.second <= second &&
              (event.kind.includes("queue") ||
                event.kind.includes("consumer") ||
                event.kind.includes("partition")),
          )
          .slice(-1)
          .map((event) => event.id),
        recommendations: [
          "Scale consumers by queue age rather than CPU alone.",
          "Quarantine poison messages and rebalance hot partitions.",
        ],
      });

    cumulativeLoss += frameDataLoss;
    const durabilityPercent =
      cumulativeWrites === 0
        ? 100
        : clamp(100 * (1 - cumulativeLoss / cumulativeWrites), 0, 100);
    const throughputRps = requestedRps * (1 - errorRate);
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
      monthlyCostEur: rounded(totalMonthlyCost),
      dataLoss: rounded(frameDataLoss),
      consistencyViolations: frameConsistencyViolations,
      durabilityPercent: rounded(durabilityPercent, 6),
      replicaLagMs: rounded(replicaLagMs),
      maxQueueAgeMs: rounded(maxQueueAgeMs),
      recoveryTimeSeconds: rounded(recoveryTimeSeconds),
      residencyViolations,
      operationalComplexity: complexity,
      nodeUtilization: Object.fromEntries(
        Object.entries(nodeMetrics).map(([id, metric]) => [
          id,
          metric.utilization,
        ]),
      ),
      nodeMetrics,
    });
  }

  const requirements = evaluateRequirements(scenario, frames);
  const utilizationByNode = new Map(
    architecture.nodes.map((node) => [
      node.id,
      Math.max(...frames.map((frame) => frame.nodeUtilization[node.id] ?? 0)),
    ]),
  );
  const bottleneckNode = architecture.nodes
    .filter((node) => reachable.has(node.id))
    .sort(
      (left, right) =>
        (utilizationByNode.get(right.id) ?? 0) -
        (utilizationByNode.get(left.id) ?? 0),
    )[0];
  const strengths: string[] = [];
  const risks: string[] = [];
  const tradeoffs: string[] = [];
  const totalDataLoss = frames.reduce(
    (total, frame) => total + frame.dataLoss,
    0,
  );
  const totalConsistencyViolations = frames.reduce(
    (total, frame) => total + frame.consistencyViolations,
    0,
  );
  const maximumRecovery = Math.max(
    ...frames.map((frame) => frame.recoveryTimeSeconds),
  );
  if (scenario.domain?.acknowledgedWritesMustSurvive) {
    if (totalDataLoss > 0)
      risks.push(
        `The acknowledged-write invariant was violated by ${rounded(totalDataLoss)} modeled lost writes.`,
      );
    else strengths.push("Acknowledged writes survived the modeled run.");
  }
  if (scenario.domain?.preventOversell) {
    if (totalConsistencyViolations > 0)
      risks.push(
        `The no-oversell invariant encountered ${totalConsistencyViolations} modeled consistency violations.`,
      );
    else strengths.push("The no-oversell invariant remained intact.");
  }
  if (scenario.domain?.maximumRecoverySeconds !== undefined) {
    if (maximumRecovery > scenario.domain.maximumRecoverySeconds)
      risks.push(
        `Recovery reached ${rounded(maximumRecovery)}s against the ${scenario.domain.maximumRecoverySeconds}s domain limit.`,
      );
    else
      strengths.push(
        `Recovery stayed within the ${scenario.domain.maximumRecoverySeconds}s domain limit.`,
      );
  }
  if (architecture.nodes.some((node) => node.config.autoscale))
    strengths.push("Elastic compute responds to measured utilization.");
  if (
    architecture.nodes.some(
      (node) =>
        node.config.behavior?.resilience?.circuitBreaker &&
        node.config.behavior?.resilience?.loadSheddingThreshold,
    )
  )
    strengths.push("Circuit breaking and load shedding bound cascading load.");
  if (
    architecture.nodes.some(
      (node) =>
        node.config.behavior?.storage?.replicationMode === "sync" ||
        node.config.behavior?.storage?.replicationMode === "quorum",
    )
  )
    strengths.push("Synchronous durability protects acknowledged writes.");
  for (const node of architecture.nodes) {
    if (
      (node.kind === "database" || node.kind === "cache") &&
      node.config.replicas === 0
    )
      risks.push(`${node.name} remains a single failure domain.`);
    if (
      node.config.behavior?.resilience?.maxRetries &&
      !node.config.behavior?.resilience?.jitter
    )
      risks.push(
        `${node.name} retries without jitter and can synchronize load.`,
      );
    if (
      node.config.consistency === "strong" &&
      scenario.workload.regions.length > 1
    )
      tradeoffs.push(
        `${node.name} favors consistency and durability at the cost of cross-region latency.`,
      );
    if (node.config.consistency === "eventual")
      tradeoffs.push(
        `${node.name} lowers coordination latency while accepting stale-read risk.`,
      );
    if (node.config.replicas > 1)
      tradeoffs.push(
        `${node.name} buys failure tolerance with additional cost and operational complexity.`,
      );
  }
  if (risks.length === 0)
    risks.push(
      "No structural single point of failure was detected in the modeled primitives.",
    );
  if (tradeoffs.length === 0)
    tradeoffs.push(
      "The architecture has not made its consistency, cost and recovery trade-offs explicit yet.",
    );

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
    analysis: {
      bottleneckNodeId: bottleneckNode?.id,
      bottleneckLabel: bottleneckNode
        ? `${bottleneckNode.name} reached ${rounded((utilizationByNode.get(bottleneckNode.id) ?? 0) * 100)}% modeled utilization.`
        : "No reachable bottleneck was identified.",
      strengths: strengths.slice(0, 6),
      risks: risks.slice(0, 8),
      tradeoffs: [...new Set(tradeoffs)].slice(0, 8),
    },
  };
}
