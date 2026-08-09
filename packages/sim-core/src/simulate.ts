import {
  analyzeTopologyExecutionBounds,
  architectureSchema,
  componentOwnsState,
  componentUsesReadConsistency,
  estimateSimulationExecutionWorkUnits,
  estimateSimulationOutputMetricCells,
  estimateSimulationResultBytes,
  incidentCanAffectComponent,
  incidentUsesGlobalWorkload,
  incidentUsesMagnitude,
  MAX_TOPOLOGY_FANOUT_AMPLIFICATION,
  MAX_SIMULATION_EXECUTION_WORK_UNITS,
  MAX_SIMULATION_ESTIMATED_RESULT_BYTES,
  MAX_SIMULATION_OUTPUT_METRIC_CELLS,
  modeledIncidentDurationSeconds,
  scenarioSchema,
  simulationActionScheduleSchema,
  type Architecture,
  type ArchitectureNode,
  type CausalEvent,
  type EdgeMetricSnapshot,
  type GeneratedIncidentRecord,
  type Incident,
  type MetricFrame,
  type NodeMetricSnapshot,
  type Requirement,
  type RequirementResult,
  type SampledSpan,
  type SampledTrace,
  type Scenario,
  type SimulationAction,
  type SimulationResult,
  type StochasticIncidentRule,
} from "@systemforge/contracts";
import { DeterministicRandom } from "./prng";
import { resolveBehavioralProfileEvidence } from "./behavioralProfiles";
import { simulationInputFingerprintFromParsedInputs } from "./inputFingerprint";

export const ENGINE_VERSION = "0.7.0";

export interface SimulationOptions {
  actions?: readonly SimulationAction[];
  includeTraces?: boolean;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const rounded = (value: number, digits = 2): number => {
  const factor =
    digits === 2
      ? 100
      : digits === 4
        ? 10_000
        : digits === 3
          ? 1_000
          : digits === 5
            ? 100_000
            : digits === 6
              ? 1_000_000
              : 10 ** digits;
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
  const metricValues = new Map<Requirement["metric"], number>();
  const metricValue = (metric: Requirement["metric"]): number => {
    if (metricValues.has(metric)) return metricValues.get(metric)!;

    let value: number;
    switch (metric) {
      case "availability":
        value = rounded(average(frames.map((frame) => frame.availability)), 4);
        break;
      case "p50LatencyMs":
        value = rounded(
          percentile(
            frames.map((frame) => frame.p50LatencyMs),
            0.95,
          ),
        );
        break;
      case "p95LatencyMs":
        value = rounded(
          percentile(
            frames.map((frame) => frame.p95LatencyMs),
            0.95,
          ),
        );
        break;
      case "p99LatencyMs":
        value = rounded(
          percentile(
            frames.map((frame) => frame.p99LatencyMs),
            0.99,
          ),
        );
        break;
      case "errorRate":
        value = rounded(
          percentile(
            frames.map((frame) => frame.errorRate),
            0.95,
          ),
          4,
        );
        break;
      case "monthlyCostEur":
        value = rounded(
          Math.max(...frames.map((frame) => frame.monthlyCostEur)),
        );
        break;
      case "dataLoss":
        value = rounded(
          frames.reduce((total, frame) => total + frame.dataLoss, 0),
        );
        break;
      case "consistencyViolations":
        value = rounded(
          frames.reduce(
            (total, frame) => total + frame.consistencyViolations,
            0,
          ),
        );
        break;
      case "throughputRps":
        value = rounded(
          percentile(
            frames.map((frame) => frame.throughputRps),
            0.5,
          ),
        );
        break;
      case "queueDepth":
        value = rounded(Math.max(...frames.map((frame) => frame.queueDepth)));
        break;
      case "maxQueueAgeMs":
        value = rounded(
          Math.max(...frames.map((frame) => frame.maxQueueAgeMs)),
        );
        break;
      case "durabilityPercent":
        value = rounded(
          Math.min(...frames.map((frame) => frame.durabilityPercent)),
          6,
        );
        break;
      case "replicaLagMs":
        value = rounded(Math.max(...frames.map((frame) => frame.replicaLagMs)));
        break;
      case "recoveryTimeSeconds":
        value = rounded(
          Math.max(...frames.map((frame) => frame.recoveryTimeSeconds)),
        );
        break;
      case "residencyViolations":
        value = rounded(
          frames.reduce((total, frame) => total + frame.residencyViolations, 0),
        );
        break;
      case "operationalComplexity":
        value = rounded(
          Math.max(...frames.map((frame) => frame.operationalComplexity)),
        );
        break;
    }

    metricValues.set(metric, value);
    return value;
  };

  return scenario.requirements.map((requirement) => {
    const actual = metricValue(requirement.metric);
    return {
      requirement,
      actual,
      passed: requirementPassed(requirement, actual),
    };
  });
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
  baseLatencyMs: number;
  jitterMs: number;
  packetLossRate: number;
  networkUtilization: number;
}

interface TopologyNodeExecution {
  demand: number;
  readDemand: number;
  readPayloadDemandKb: number;
  deliveredWriteDemand: number;
  payloadDemandKb: number;
  computeDemandMs: number;
  criticalDemand: number;
  synchronousAttemptedDemand: number;
  forwardDemand: number;
  synchronousForwardDemand: number;
  attemptedTransportDemand: number;
  deliveredTransportDemand: number;
  lostTransportDemand: number;
  latencyDemandMs: number;
  jitterDemandMs: number;
  edgeNetworkUtilization: number;
  edgeProfile: EdgeRuntimeProfile;
}

interface TopologyEdgeExecution {
  attemptedRps: number;
  throughputRps: number;
  retryRps: number;
  synchronousAttemptedRps: number;
  lostRps: number;
  transportLostRps: number;
  targetUnavailableRps: number;
  latencyMs: number;
  cacheHitRps: number;
  cacheMissRps: number;
  asyncQueueRps: number;
}

interface TopologyExecutionPlan {
  sourceIds: string[];
  sourceIndexes: number[];
  executionOrderIndexes: number[];
  reachable: Set<string>;
  cacheBranchCoverageByIndex: number[];
  outgoingByIndex: Array<
    Array<{
      edge: Architecture["edges"][number];
      edgeIndex: number;
      targetIndex: number;
    }>
  >;
  downstreamWorkers: Map<string, ArchitectureNode[]>;
}

interface StochasticIncidentRulePlan {
  rule: StochasticIncidentRule;
  eligibleNodes: ArchitectureNode[];
  random: DeterministicRandom;
  occurrences: number;
  nextEligibleSecond: number;
}

interface RequestClassExecutionPlan {
  index: number;
  name: string;
  share: number;
  profile: WorkloadProfile;
  entryIndexes: number[];
  entryWeights: number[];
  entryNodeId: string;
  terminalNodeId?: string;
  routeEdgeIndexes?: Set<number>;
  routeEdgeOrder?: number[];
  cacheBranchCoverageByIndex: number[];
  fixedRoute: boolean;
  traced: boolean;
}

interface RequestClassRuntime {
  plan: RequestClassExecutionPlan;
  nodeDemand: Float64Array;
  nodeSynchronousAttemptedDemand: Float64Array;
  edgeExecution: TopologyEdgeExecution[];
  forwardDemand: Float64Array;
  synchronousForwardDemand: Float64Array;
  edgeAttemptedRps: Float64Array;
  edgeSynchronousAttemptedRps: Float64Array;
  edgeRetryDemand: number[];
  edgeSynchronousRetryDemand: number[];
  edgeModels: RequestClassEdgeModel[];
  edgeCacheHitRates: Float64Array;
  outcomeSuccess: Float64Array;
  outcomeLatencyMs: Float64Array;
}

interface RequestClassEdgeModel {
  trafficShare: number;
  survivalRate: number;
  localBase: number;
  localCacheCoefficient: number;
  forwardBase: number;
  forwardCacheCoefficient: number;
  baseLatencyMs: number;
  jitterMs: number;
  latencyMs: number;
  bandwidthScale: number;
  cacheTarget: boolean;
  asyncQueueTarget: boolean;
  asynchronous: boolean;
  retryPressureFactor: number;
}

const USER_CONCURRENCY_KINDS = new Set<ArchitectureNode["kind"]>([
  "cdn",
  "load-balancer",
  "api",
]);

const MAX_MODELED_REQUEST_RATE = 1_000_000_000_000_000;

const modeledRateIsUnsafe = (value: number): boolean =>
  !Number.isFinite(value) || Math.abs(value) > MAX_MODELED_REQUEST_RATE;

const rejectUnsafeModeledRate = (label: string, value: number): never => {
  throw new Error(
    `unsafe_topology:non-finite-demand:${label}:${String(value)}`,
  );
};

const MAX_SAMPLED_TRACES = 16;
const MAX_SPANS_PER_TRACE = 64;
const MAX_TRACE_SAMPLE_SECONDS = 4;

type RequestMixItem = NonNullable<Scenario["workload"]["requestMix"]>[number];

const requestClassProfile = (request: RequestMixItem): WorkloadProfile => ({
  readRatio: request.readRatio,
  payloadKb: request.payloadKb,
  computeMs: request.computeMs,
  databaseQueries: request.databaseQueries,
  cacheableShare: request.cacheable && request.readRatio > 0 ? 1 : 0,
  criticalShare: request.critical ? 1 : 0,
});

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

const incidentAffectsNode = (
  incident: Incident,
  node: ArchitectureNode,
): boolean => {
  if (!incidentCanAffectArchitectureNode(incident.kind, node)) return false;
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

const incidentCanAffectArchitectureNode = (
  kind: Incident["kind"],
  node: ArchitectureNode,
): boolean =>
  incidentCanAffectComponent(kind, node.kind) &&
  (kind !== "bad-autoscaling" || node.config.autoscale);

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
  const modeledEffect = incidentUsesMagnitude(incident.kind)
    ? ` with ${incident.magnitude}x magnitude`
    : " as a binary modeled state change";
  return `${incident.kind.replaceAll("-", " ")}${target} entered the event schedule at ${incident.atSecond}s${modeledEffect}.`;
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
  return ["Inspect linked events before changing component capacity."];
};

const topologySources = (architecture: Architecture): string[] => {
  const incoming = new Map<string, number>();
  for (const node of architecture.nodes) incoming.set(node.id, 0);
  for (const edge of architecture.edges) {
    if ((edge.config?.trafficShare ?? 1) <= 0) continue;
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }
  const explicitSources = architecture.nodes.filter(
    (node) => node.kind === "users" || node.kind === "region",
  );
  return (
    explicitSources.length > 0
      ? explicitSources
      : architecture.nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0)
  ).map((node) => node.id);
};

const buildTopologyExecutionPlan = (
  architecture: Architecture,
): TopologyExecutionPlan => {
  const nodeById = new Map(architecture.nodes.map((node) => [node.id, node]));
  const outgoingEdges = new Map<string, Architecture["edges"]>();
  for (const edge of architecture.edges) {
    const outgoing = outgoingEdges.get(edge.source) ?? [];
    outgoing.push(edge);
    outgoingEdges.set(edge.source, outgoing);
  }
  const cacheBranchCoverage = new Map<string, number>();
  for (const [sourceId, outgoing] of outgoingEdges) {
    cacheBranchCoverage.set(
      sourceId,
      clamp(
        outgoing.reduce((coverage, edge) => {
          if (
            edge.config?.asynchronous ||
            nodeById.get(edge.target)?.kind !== "cache"
          )
            return coverage;
          return (
            coverage +
            (edge.config?.trafficShare ?? 1) *
              (1 - (edge.config?.packetLossRate ?? 0))
          );
        }, 0),
        0,
        1,
      ),
    );
  }
  const sourceIds = topologySources(architecture);
  const nodeIndexById = new Map(
    architecture.nodes.map((node, index) => [node.id, index]),
  );
  const edgeIndexById = new Map(
    architecture.edges.map((edge, index) => [edge.id, index]),
  );
  const sourceIdSet = new Set(sourceIds);
  const reached = new Set<string>();
  const pending = [...sourceIds];
  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index];
    if (!id || reached.has(id)) continue;
    reached.add(id);
    for (const edge of outgoingEdges.get(id) ?? []) {
      if ((edge.config?.trafficShare ?? 1) > 0) pending.push(edge.target);
    }
  }
  const incomingCount = new Map<string, number>(
    [...reached].map((id) => [id, 0]),
  );
  for (const edge of architecture.edges) {
    if (!reached.has(edge.source) || !reached.has(edge.target)) continue;
    if ((edge.config?.trafficShare ?? 1) <= 0) continue;
    if (sourceIdSet.has(edge.target)) continue;
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
  }
  const ready = architecture.nodes
    .filter(
      (node) => reached.has(node.id) && (incomingCount.get(node.id) ?? 0) === 0,
    )
    .map((node) => node.id);
  const executionOrder: string[] = [];
  const scheduled = new Set<string>();
  for (let index = 0; index < ready.length; index += 1) {
    const id = ready[index];
    if (!id || scheduled.has(id)) continue;
    scheduled.add(id);
    executionOrder.push(id);
    for (const edge of outgoingEdges.get(id) ?? []) {
      if ((edge.config?.trafficShare ?? 1) <= 0) continue;
      if (!reached.has(edge.target) || sourceIdSet.has(edge.target)) continue;
      const remaining = Math.max(0, (incomingCount.get(edge.target) ?? 0) - 1);
      incomingCount.set(edge.target, remaining);
      if (remaining === 0) ready.push(edge.target);
    }
  }
  // A cyclic remainder executes once in authored node order, so feedback links
  // remain deterministic without multiplying demand forever.
  for (const node of architecture.nodes) {
    if (reached.has(node.id) && !scheduled.has(node.id))
      executionOrder.push(node.id);
  }

  const downstreamWorkers = new Map<string, ArchitectureNode[]>();
  for (const origin of architecture.nodes.filter(
    (node) => node.kind === "queue" || node.kind === "stream",
  )) {
    const workerIds = new Set<string>();
    const visited = new Set<string>([origin.id]);
    const queue = (outgoingEdges.get(origin.id) ?? [])
      .filter(
        (edge) =>
          (edge.config?.trafficShare ?? 1) > 0 &&
          (edge.config?.packetLossRate ?? 0) < 1,
      )
      .map((edge) => edge.target);
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index];
      if (!id || visited.has(id)) continue;
      visited.add(id);
      const candidate = nodeById.get(id);
      if (!candidate) continue;
      if (candidate.kind === "worker") workerIds.add(candidate.id);
      for (const edge of outgoingEdges.get(id) ?? []) {
        if (
          (edge.config?.trafficShare ?? 1) > 0 &&
          (edge.config?.packetLossRate ?? 0) < 1
        )
          queue.push(edge.target);
      }
    }
    downstreamWorkers.set(
      origin.id,
      architecture.nodes.filter((node) => workerIds.has(node.id)),
    );
  }

  return {
    sourceIds,
    sourceIndexes: sourceIds.map((id) => nodeIndexById.get(id)!),
    executionOrderIndexes: executionOrder.map((id) => nodeIndexById.get(id)!),
    reachable: reached,
    cacheBranchCoverageByIndex: architecture.nodes.map(
      (node) => cacheBranchCoverage.get(node.id) ?? 0,
    ),
    outgoingByIndex: architecture.nodes.map((node) =>
      (outgoingEdges.get(node.id) ?? []).map((edge) => ({
        edge,
        edgeIndex: edgeIndexById.get(edge.id)!,
        targetIndex: nodeIndexById.get(edge.target)!,
      })),
    ),
    downstreamWorkers,
  };
};

const validatedTopologyExecutionPlan = (
  scenario: Scenario,
  architecture: Architecture,
): TopologyExecutionPlan => {
  const nodeIds = new Set(architecture.nodes.map((node) => node.id));
  const topologyBounds = analyzeTopologyExecutionBounds(architecture);
  if (topologyBounds.reachableCycleNodeIds.length > 0)
    throw new Error(
      `invalid_topology:reachable-cycle:${topologyBounds.reachableCycleNodeIds.join(",")}`,
    );
  if (
    !Number.isFinite(topologyBounds.fanoutAmplification) ||
    topologyBounds.fanoutAmplification > MAX_TOPOLOGY_FANOUT_AMPLIFICATION
  )
    throw new Error(
      `invalid_topology:fanout-amplification:${topologyBounds.fanoutAmplification}`,
    );
  const outgoingBySource = new Map<string, Architecture["edges"]>();
  for (const edge of architecture.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target))
      throw new Error(`invalid_topology:edge:${edge.id}:unknown-endpoint`);
    const outgoing = outgoingBySource.get(edge.source) ?? [];
    outgoing.push(edge);
    outgoingBySource.set(edge.source, outgoing);
  }
  for (const [sourceId, outgoing] of outgoingBySource) {
    const enabledOutgoing = outgoing.filter(
      (edge) => (edge.config?.trafficShare ?? 1) > 0,
    );
    if (enabledOutgoing.length === 0) continue;
    const explicitShares = enabledOutgoing.filter(
      (edge) => edge.config?.trafficShare !== undefined,
    );
    if (explicitShares.length === 0) continue;
    if (explicitShares.length !== enabledOutgoing.length)
      throw new Error(
        `invalid_topology:mixed-outgoing-traffic-share:${sourceId}`,
      );
    const totalShare = enabledOutgoing.reduce(
      (total, edge) => total + (edge.config?.trafficShare ?? 0),
      0,
    );
    if (Math.abs(totalShare - 1) > 0.000_001)
      throw new Error(
        `invalid_topology:outgoing-traffic-share:${sourceId}:${rounded(totalShare, 6)}`,
      );
  }

  const plan = buildTopologyExecutionPlan(architecture);
  if (plan.sourceIds.length === 0)
    throw new Error("invalid_topology:no-entry-path");
  const explicitSourceIds = architecture.nodes
    .filter((node) => node.kind === "users" || node.kind === "region")
    .map((node) => node.id);
  for (const sourceId of explicitSourceIds) {
    const sourceReachable = new Set<string>();
    const pending = [sourceId];
    for (let index = 0; index < pending.length; index += 1) {
      const nodeId = pending[index];
      if (!nodeId || sourceReachable.has(nodeId)) continue;
      sourceReachable.add(nodeId);
      for (const edge of outgoingBySource.get(nodeId) ?? []) {
        if ((edge.config?.trafficShare ?? 1) > 0) pending.push(edge.target);
      }
    }
    if (
      !architecture.nodes.some(
        (node) =>
          sourceReachable.has(node.id) &&
          node.kind !== "users" &&
          node.kind !== "region",
      )
    )
      throw new Error(`invalid_topology:disconnected-entry:${sourceId}`);
  }

  const topologyValues = (key: "region" | "zone" | "failureDomain") =>
    new Set(
      architecture.nodes.flatMap((node) => {
        const value = node.config.behavior?.topology?.[key];
        return value ? [value] : [];
      }),
    );
  const regions = topologyValues("region");
  const zones = topologyValues("zone");
  const failureDomains = topologyValues("failureDomain");
  for (const incident of scenario.incidents) {
    const errorPrefix = `invalid_scenario:incident:${incident.id}`;
    if (incident.targetId && !nodeIds.has(incident.targetId))
      throw new Error(`${errorPrefix}:unknown-target:${incident.targetId}`);
    if (incident.region && !regions.has(incident.region))
      throw new Error(`${errorPrefix}:unknown-region:${incident.region}`);
    if (incident.zone && !zones.has(incident.zone))
      throw new Error(`${errorPrefix}:unknown-zone:${incident.zone}`);
    if (incident.failureDomain && !failureDomains.has(incident.failureDomain))
      throw new Error(
        `${errorPrefix}:unknown-failure-domain:${incident.failureDomain}`,
      );
    const hasPhysicalScope = Boolean(
      incident.targetId ||
      incident.region ||
      incident.zone ||
      incident.failureDomain,
    );
    if (incidentUsesGlobalWorkload(incident.kind)) {
      if (hasPhysicalScope)
        throw new Error(`${errorPrefix}:inapplicable-kind-scope`);
      continue;
    }
    const eligibleNodes = architecture.nodes.filter(
      (node) =>
        plan.reachable.has(node.id) && incidentAffectsNode(incident, node),
    );
    if (eligibleNodes.length === 0)
      throw new Error(`${errorPrefix}:inapplicable-kind-scope`);
  }
  return plan;
};

const stochasticIncidentCanAffectNode = (
  kind: Incident["kind"],
  node: ArchitectureNode,
): boolean => incidentCanAffectArchitectureNode(kind, node);

const stableIncidentSeed = (scenarioSeed: number, ruleId: string): number => {
  let hash = 0x811c9dc5;
  const namespace = `systemforge:seeded-incidents:v1:${ruleId}`;
  for (let index = 0; index < namespace.length; index += 1) {
    hash ^= namespace.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let mixed = (hash ^ (scenarioSeed >>> 0) ^ 0x9e3779b9) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x85ebca6b) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 13), 0xc2b2ae35) >>> 0;
  return (mixed ^ (mixed >>> 16)) >>> 0;
};

const compareNodeIds = (
  left: ArchitectureNode,
  right: ArchitectureNode,
): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

const buildStochasticIncidentRulePlans = (
  scenario: Scenario,
  architecture: Architecture,
  topologyPlan: TopologyExecutionPlan,
): StochasticIncidentRulePlan[] => {
  const model = scenario.stochasticIncidents;
  if (!model) return [];
  const nodeById = new Map(
    architecture.nodes.map((node) => [node.id, node] as const),
  );
  const regions = new Set(
    architecture.nodes.flatMap((node) => {
      const region = node.config.behavior?.topology?.region;
      return region ? [region] : [];
    }),
  );
  const zones = new Set(
    architecture.nodes.flatMap((node) => {
      const zone = node.config.behavior?.topology?.zone;
      return zone ? [zone] : [];
    }),
  );
  const failureDomains = new Set(
    architecture.nodes.flatMap((node) => {
      const failureDomain = node.config.behavior?.topology?.failureDomain;
      return failureDomain ? [failureDomain] : [];
    }),
  );

  return model.rules.map((rule) => {
    const scope = rule.scope;
    const hasLocationScope = Boolean(
      scope?.targetId || scope?.region || scope?.zone || scope?.failureDomain,
    );
    if (scope?.targetId && !nodeById.has(scope.targetId))
      throw new Error(
        `invalid_stochastic_rule:${rule.id}:unknown-target:${scope.targetId}`,
      );
    if (scope?.region && !regions.has(scope.region))
      throw new Error(
        `invalid_stochastic_rule:${rule.id}:unknown-region:${scope.region}`,
      );
    if (scope?.zone && !zones.has(scope.zone))
      throw new Error(
        `invalid_stochastic_rule:${rule.id}:unknown-zone:${scope.zone}`,
      );
    if (scope?.failureDomain && !failureDomains.has(scope.failureDomain))
      throw new Error(
        `invalid_stochastic_rule:${rule.id}:unknown-failure-domain:${scope.failureDomain}`,
      );
    if (incidentUsesGlobalWorkload(rule.kind)) {
      if (hasLocationScope || scope?.correlated)
        throw new Error(
          `invalid_stochastic_rule:${rule.id}:inapplicable-kind-scope`,
        );
      return {
        rule,
        eligibleNodes: [],
        random: new DeterministicRandom(
          stableIncidentSeed(scenario.seed, rule.id),
        ),
        occurrences: 0,
        nextEligibleSecond: 0,
      };
    }
    if (scope?.correlated && scope.targetId)
      throw new Error(
        `invalid_stochastic_rule:${rule.id}:correlated-target-scope`,
      );
    if (
      scope?.correlated &&
      !scope.region &&
      !scope.zone &&
      !scope.failureDomain
    )
      throw new Error(
        `invalid_stochastic_rule:${rule.id}:correlated-scope-required`,
      );
    if (scope?.targetId && !topologyPlan.reachable.has(scope.targetId))
      throw new Error(`invalid_stochastic_rule:${rule.id}:impossible-scope`);

    const nodesInScope = architecture.nodes.filter((node) => {
      if (scope?.targetId && node.id !== scope.targetId) return false;
      if (
        scope?.region &&
        node.config.behavior?.topology?.region !== scope.region
      )
        return false;
      if (scope?.zone && node.config.behavior?.topology?.zone !== scope.zone)
        return false;
      if (
        scope?.failureDomain &&
        node.config.behavior?.topology?.failureDomain !== scope.failureDomain
      )
        return false;
      return true;
    });
    if (hasLocationScope && nodesInScope.length === 0)
      throw new Error(`invalid_stochastic_rule:${rule.id}:impossible-scope`);
    const eligibleNodes = nodesInScope
      .filter(
        (node) =>
          topologyPlan.reachable.has(node.id) &&
          stochasticIncidentCanAffectNode(rule.kind, node),
      )
      .sort(compareNodeIds);
    if (eligibleNodes.length === 0)
      throw new Error(
        `invalid_stochastic_rule:${rule.id}:inapplicable-kind-scope`,
      );
    return {
      rule,
      eligibleNodes,
      random: new DeterministicRandom(
        stableIncidentSeed(scenario.seed, rule.id),
      ),
      occurrences: 0,
      nextEligibleSecond: 0,
    };
  });
};

const stochasticTriggerValue = (
  frame: MetricFrame,
  metric: NonNullable<StochasticIncidentRule["trigger"]>["metric"],
): number => frame[metric];

const stochasticTriggerPasses = (
  rule: StochasticIncidentRule,
  priorFrame: MetricFrame | undefined,
): boolean => {
  if (!rule.trigger) return true;
  if (!priorFrame) return false;
  const value = stochasticTriggerValue(priorFrame, rule.trigger.metric);
  return rule.trigger.operator === "gte"
    ? value >= rule.trigger.threshold
    : value <= rule.trigger.threshold;
};

const generatedIncidentId = (
  ruleId: string,
  occurrence: number,
  reservedIds: Set<string>,
): string => {
  const normalized = ruleId.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
  const base = `seeded-${normalized}-${occurrence}`.slice(0, 74);
  let candidate = base;
  let suffix = 2;
  while (reservedIds.has(candidate)) {
    const marker = `-${suffix}`;
    candidate = `${base.slice(0, 80 - marker.length)}${marker}`;
    suffix += 1;
  }
  reservedIds.add(candidate);
  return candidate;
};

const requestEntryWeights = (
  scenario: Scenario,
  architecture: Architecture,
  entryIndexes: number[],
  requireCompleteRegionalBinding: boolean,
): number[] => {
  if (entryIndexes.length === 0) return [];
  const entries = entryIndexes.map((index) => architecture.nodes[index]!);
  const regionEntryCount = entries.filter(
    (node) => node.kind === "region",
  ).length;
  if (regionEntryCount === 0) return entries.map(() => 1 / entries.length);
  if (regionEntryCount !== entries.length)
    throw new Error("invalid_topology:mixed-region-entry-kinds");
  if (!requireCompleteRegionalBinding)
    return entries.map(() => 1 / entries.length);

  const normalizeRegion = (value: string): string =>
    value.trim().toLocaleLowerCase("en-US");
  const workloadShares = new Map(
    scenario.workload.regions.map((region) => [
      normalizeRegion(region.name),
      region.trafficShare,
    ]),
  );
  const bindings = entries.map((node) =>
    normalizeRegion(node.config.behavior?.topology?.region ?? node.name),
  );
  for (const binding of bindings) {
    if (!workloadShares.has(binding))
      throw new Error(`invalid_topology:unknown-region-entry:${binding}`);
  }
  for (const regionName of workloadShares.keys()) {
    if (!bindings.includes(regionName))
      throw new Error(`invalid_topology:missing-region-entry:${regionName}`);
  }
  const bindingCounts = new Map<string, number>();
  for (const binding of bindings)
    bindingCounts.set(binding, (bindingCounts.get(binding) ?? 0) + 1);
  return bindings.map(
    (binding) =>
      workloadShares.get(binding)! / Math.max(1, bindingCounts.get(binding)!),
  );
};

const buildRequestClassExecutionPlans = (
  scenario: Scenario,
  architecture: Architecture,
  topologyPlan: TopologyExecutionPlan,
  traceSamplingEnabled: boolean,
): RequestClassExecutionPlan[] => {
  const requestMix = scenario.workload.requestMix;
  if (!requestMix || requestMix.length === 0)
    return [
      {
        index: 0,
        name: "Legacy aggregate",
        share: 1,
        profile: workloadProfile(scenario),
        entryIndexes: topologyPlan.sourceIndexes,
        entryWeights: requestEntryWeights(
          scenario,
          architecture,
          topologyPlan.sourceIndexes,
          true,
        ),
        entryNodeId: topologyPlan.sourceIds[0]!,
        cacheBranchCoverageByIndex: topologyPlan.cacheBranchCoverageByIndex,
        fixedRoute: false,
        traced: false,
      },
    ];

  const nodeIndexById = new Map(
    architecture.nodes.map((node, index) => [node.id, index]),
  );
  const edgeIndexById = new Map(
    architecture.edges.map((edge, index) => [edge.id, index]),
  );
  const reverseEdgesByTarget = architecture.nodes.map(() => [] as number[]);
  for (const [edgeIndex, edge] of architecture.edges.entries()) {
    const targetIndex = nodeIndexById.get(edge.target);
    if (targetIndex !== undefined)
      reverseEdgesByTarget[targetIndex]!.push(edgeIndex);
  }

  return requestMix.map((request, index) => {
    const errorPrefix = `invalid_scenario:request-class:${index}`;
    if (!request.entryNodeId && !request.route && !traceSamplingEnabled)
      return {
        index,
        name: request.name,
        share: request.share,
        profile: requestClassProfile(request),
        entryIndexes: topologyPlan.sourceIndexes,
        entryWeights: requestEntryWeights(
          scenario,
          architecture,
          topologyPlan.sourceIndexes,
          true,
        ),
        entryNodeId: topologyPlan.sourceIds[0]!,
        cacheBranchCoverageByIndex: topologyPlan.cacheBranchCoverageByIndex,
        fixedRoute: false,
        traced: false,
      };
    let entryNodeId = request.entryNodeId;
    if (entryNodeId && !nodeIndexById.has(entryNodeId))
      throw new Error(`${errorPrefix}:unknown-entry:${entryNodeId}`);

    const explicitEdgeIds = request.route?.edgeIds;
    let routeEdgeIndexes: Set<number> | undefined;
    if (explicitEdgeIds) {
      const routeEdges = explicitEdgeIds.map((edgeId) => {
        const edgeIndex = edgeIndexById.get(edgeId);
        if (edgeIndex === undefined)
          throw new Error(`${errorPrefix}:unknown-route-edge:${edgeId}`);
        const edge = architecture.edges[edgeIndex]!;
        if ((edge.config?.trafficShare ?? 1) <= 0)
          throw new Error(`${errorPrefix}:disabled-route-edge:${edgeId}`);
        return { edge, edgeIndex };
      });
      const firstEdge = routeEdges[0]!.edge;
      entryNodeId ??= firstEdge.source;
      if (firstEdge.source !== entryNodeId)
        throw new Error(
          `${errorPrefix}:route-entry-mismatch:${firstEdge.id}:${entryNodeId}`,
        );
      const visitedNodes = new Set<string>([entryNodeId]);
      let expectedSource = entryNodeId;
      for (const { edge } of routeEdges) {
        if (edge.source !== expectedSource)
          throw new Error(
            `${errorPrefix}:disconnected-route-edge:${edge.id}:${expectedSource}`,
          );
        if (visitedNodes.has(edge.target))
          throw new Error(`${errorPrefix}:cyclic-route:${edge.id}`);
        visitedNodes.add(edge.target);
        expectedSource = edge.target;
      }
      if (
        request.route?.terminalNodeId &&
        request.route.terminalNodeId !== expectedSource
      )
        throw new Error(
          `${errorPrefix}:route-terminal-mismatch:${expectedSource}:${request.route.terminalNodeId}`,
        );
      routeEdgeIndexes = new Set(routeEdges.map(({ edgeIndex }) => edgeIndex));
    }

    const usesDefaultEntries = entryNodeId === undefined;
    const entryIndexes = entryNodeId
      ? [nodeIndexById.get(entryNodeId)!]
      : topologyPlan.sourceIndexes;
    entryNodeId ??= topologyPlan.sourceIds[0]!;
    if (!topologyPlan.reachable.has(entryNodeId))
      throw new Error(`${errorPrefix}:unreachable-entry:${entryNodeId}`);

    const forwardReachable = new Set<number>();
    const pending = [...entryIndexes];
    for (
      let pendingIndex = 0;
      pendingIndex < pending.length;
      pendingIndex += 1
    ) {
      const nodeIndex = pending[pendingIndex];
      if (nodeIndex === undefined || forwardReachable.has(nodeIndex)) continue;
      forwardReachable.add(nodeIndex);
      for (const { edge, edgeIndex, targetIndex } of topologyPlan
        .outgoingByIndex[nodeIndex] ?? []) {
        if (
          (edge.config?.trafficShare ?? 1) > 0 &&
          (!routeEdgeIndexes || routeEdgeIndexes.has(edgeIndex))
        )
          pending.push(targetIndex);
      }
    }

    const terminalNodeId = request.route?.terminalNodeId;
    if (terminalNodeId && !nodeIndexById.has(terminalNodeId))
      throw new Error(`${errorPrefix}:unknown-terminal:${terminalNodeId}`);
    if (terminalNodeId) {
      const terminalIndex = nodeIndexById.get(terminalNodeId)!;
      if (!forwardReachable.has(terminalIndex))
        throw new Error(
          `${errorPrefix}:unreachable-terminal:${terminalNodeId}`,
        );
      if (!explicitEdgeIds) {
        const canReachTerminal = new Set<number>();
        const reversePending = [terminalIndex];
        for (
          let pendingIndex = 0;
          pendingIndex < reversePending.length;
          pendingIndex += 1
        ) {
          const nodeIndex = reversePending[pendingIndex];
          if (nodeIndex === undefined || canReachTerminal.has(nodeIndex))
            continue;
          canReachTerminal.add(nodeIndex);
          for (const edgeIndex of reverseEdgesByTarget[nodeIndex] ?? []) {
            const edge = architecture.edges[edgeIndex]!;
            if ((edge.config?.trafficShare ?? 1) <= 0) continue;
            const sourceIndex = nodeIndexById.get(edge.source);
            if (sourceIndex !== undefined) reversePending.push(sourceIndex);
          }
        }
        routeEdgeIndexes = new Set(
          architecture.edges.flatMap((edge, edgeIndex) => {
            const sourceIndex = nodeIndexById.get(edge.source)!;
            const targetIndex = nodeIndexById.get(edge.target)!;
            return forwardReachable.has(sourceIndex) &&
              canReachTerminal.has(targetIndex) &&
              (edge.config?.trafficShare ?? 1) > 0
              ? [edgeIndex]
              : [];
          }),
        );
      }
    }

    return {
      index,
      name: request.name,
      share: request.share,
      profile: requestClassProfile(request),
      entryIndexes,
      entryWeights: requestEntryWeights(
        scenario,
        architecture,
        entryIndexes,
        usesDefaultEntries,
      ),
      entryNodeId,
      terminalNodeId:
        terminalNodeId ??
        (explicitEdgeIds
          ? architecture.edges[edgeIndexById.get(explicitEdgeIds.at(-1)!)!]!
              .target
          : undefined),
      routeEdgeIndexes,
      routeEdgeOrder: explicitEdgeIds
        ? explicitEdgeIds.map((edgeId) => edgeIndexById.get(edgeId)!)
        : topologyPlan.executionOrderIndexes.flatMap((nodeIndex) =>
            (topologyPlan.outgoingByIndex[nodeIndex] ?? []).flatMap(
              ({ edgeIndex }) =>
                !routeEdgeIndexes || routeEdgeIndexes.has(edgeIndex)
                  ? [edgeIndex]
                  : [],
            ),
          ),
      cacheBranchCoverageByIndex: routeEdgeIndexes
        ? architecture.nodes.map((_, nodeIndex) =>
            clamp(
              (topologyPlan.outgoingByIndex[nodeIndex] ?? []).reduce(
                (coverage, { edge, edgeIndex, targetIndex }) =>
                  routeEdgeIndexes.has(edgeIndex) &&
                  architecture.nodes[targetIndex]?.kind === "cache" &&
                  !edge.config?.asynchronous
                    ? coverage +
                      (explicitEdgeIds ? 1 : (edge.config?.trafficShare ?? 1)) *
                        (1 - (edge.config?.packetLossRate ?? 0))
                    : coverage,
                0,
              ),
              0,
              1,
            ),
          )
        : topologyPlan.cacheBranchCoverageByIndex,
      fixedRoute: explicitEdgeIds !== undefined,
      traced: traceSamplingEnabled,
    };
  });
};

const createTopologyExecutionState = (
  architecture: Architecture,
): TopologyNodeExecution[] =>
  architecture.nodes.map(() => ({
    demand: 0,
    readDemand: 0,
    readPayloadDemandKb: 0,
    deliveredWriteDemand: 0,
    payloadDemandKb: 0,
    computeDemandMs: 0,
    criticalDemand: 0,
    synchronousAttemptedDemand: 0,
    forwardDemand: 0,
    synchronousForwardDemand: 0,
    attemptedTransportDemand: 0,
    deliveredTransportDemand: 0,
    lostTransportDemand: 0,
    latencyDemandMs: 0,
    jitterDemandMs: 0,
    edgeNetworkUtilization: 0,
    edgeProfile: {
      baseLatencyMs: 0,
      jitterMs: 0,
      packetLossRate: 0,
      networkUtilization: 0,
    },
  }));

const createTopologyEdgeExecutionState = (
  architecture: Architecture,
): TopologyEdgeExecution[] =>
  architecture.edges.map(() => ({
    attemptedRps: 0,
    throughputRps: 0,
    retryRps: 0,
    synchronousAttemptedRps: 0,
    lostRps: 0,
    transportLostRps: 0,
    targetUnavailableRps: 0,
    latencyMs: 0,
    cacheHitRps: 0,
    cacheMissRps: 0,
    asyncQueueRps: 0,
  }));

const retryPressureFactorForNode = (node: ArchitectureNode): number => {
  const resilience = node.config.behavior?.resilience;
  let factor = (resilience?.maxRetries ?? 0) * 0.22;
  if (resilience?.jitter) factor *= 0.84;
  if ((resilience?.backoffBaseMs ?? 0) >= 100) factor *= 0.84;
  if (resilience?.circuitBreaker) factor *= 0.52;
  if (resilience?.loadSheddingThreshold) factor *= 0.62;
  if (resilience?.bulkhead) factor *= 0.72;
  return factor;
};

const createRequestClassEdgeModels = (
  architecture: Architecture,
  requestPlan: RequestClassExecutionPlan,
): RequestClassEdgeModel[] => {
  const nodeById = new Map(architecture.nodes.map((node) => [node.id, node]));
  const nodeIndexById = new Map(
    architecture.nodes.map((node, index) => [node.id, index]),
  );
  const profile = requestPlan.profile;
  return architecture.edges.map((edge, edgeIndex) => {
    const source = nodeById.get(edge.source)!;
    const target = nodeById.get(edge.target)!;
    const retryPressureFactor = retryPressureFactorForNode(source);
    let localBase = 1;
    let localCacheCoefficient = 0;
    let forwardBase = 1;
    let forwardCacheCoefficient = 0;
    if (target.kind === "dns") localBase = 1 / 120;
    else if (target.kind === "cache") {
      localBase = source.kind === "cache" ? 1 : profile.readRatio;
      forwardBase = localBase;
      forwardCacheCoefficient = localBase * profile.cacheableShare;
    } else if (target.kind === "database") {
      const queryFactor = Math.max(0, profile.databaseQueries);
      if (source.kind === "cache") localBase = queryFactor;
      else if (
        source.kind !== "worker" &&
        source.kind !== "queue" &&
        source.kind !== "stream"
      ) {
        localBase = queryFactor;
        localCacheCoefficient =
          profile.readRatio *
          profile.cacheableShare *
          (requestPlan.cacheBranchCoverageByIndex[
            nodeIndexById.get(edge.source)!
          ] ?? 0) *
          queryFactor;
      }
      forwardBase = localBase;
      forwardCacheCoefficient = localCacheCoefficient;
    } else if (target.kind === "queue" || target.kind === "stream") {
      localBase =
        source.kind === "queue" || source.kind === "stream"
          ? 1
          : (1 - profile.readRatio) * (0.2 + profile.criticalShare * 0.35);
      forwardBase = localBase;
    } else if (target.kind === "object-store") {
      localBase = 0.06;
      forwardBase = 0.06;
    } else if (target.kind === "third-party") {
      localBase = 0.12;
      forwardBase = 0.12;
    }
    if (requestPlan.fixedRoute) {
      localBase = 1;
      localCacheCoefficient = 0;
      forwardBase = 1;
      forwardCacheCoefficient =
        target.kind === "cache"
          ? profile.readRatio * profile.cacheableShare
          : 0;
    }
    const bandwidthMbps = edge.config?.bandwidthMbps;
    const edgeEnabled =
      !requestPlan.routeEdgeIndexes ||
      requestPlan.routeEdgeIndexes.has(edgeIndex);
    const baseLatencyMs = edge.config?.baseLatencyMs ?? 0;
    const jitterMs = edge.config?.jitterMs ?? 0;
    return {
      trafficShare: edgeEnabled
        ? requestPlan.fixedRoute
          ? 1
          : (edge.config?.trafficShare ?? 1)
        : 0,
      survivalRate: 1 - (edge.config?.packetLossRate ?? 0),
      localBase,
      localCacheCoefficient,
      forwardBase,
      forwardCacheCoefficient,
      baseLatencyMs,
      jitterMs,
      latencyMs: baseLatencyMs + jitterMs * 0.5,
      bandwidthScale: bandwidthMbps
        ? (profile.payloadKb * 8) / 1_000 / Math.max(1, bandwidthMbps)
        : 0,
      cacheTarget: target.kind === "cache",
      asyncQueueTarget:
        edge.config?.asynchronous === true &&
        (target.kind === "queue" || target.kind === "stream"),
      asynchronous: edge.config?.asynchronous === true,
      retryPressureFactor,
    };
  });
};

const cacheHitRateForEdge = (
  topologyPlan: TopologyExecutionPlan,
  requestRuntime: RequestClassRuntime,
  sourceIndex: number,
  targetIndex: number,
  edgeIndex: number,
  cacheHitRatesByNode: readonly number[],
): number => {
  const directModel = requestRuntime.edgeModels[edgeIndex];
  if (directModel?.cacheTarget) return cacheHitRatesByNode[targetIndex] ?? 0;
  if (
    directModel &&
    (directModel.localCacheCoefficient > 0 ||
      directModel.forwardCacheCoefficient > 0)
  ) {
    let coveredShare = 0;
    let weightedHitShare = 0;
    for (const candidate of topologyPlan.outgoingByIndex[sourceIndex] ?? []) {
      const model = requestRuntime.edgeModels[candidate.edgeIndex];
      if (!model?.cacheTarget || model.trafficShare <= 0) continue;
      const share = model.trafficShare * model.survivalRate;
      coveredShare += share;
      weightedHitShare +=
        share * (cacheHitRatesByNode[candidate.targetIndex] ?? 0);
    }
    return coveredShare > 0 ? clamp(weightedHitShare / coveredShare, 0, 1) : 0;
  }
  return cacheHitRatesByNode[sourceIndex] ?? 0;
};

const executeRequestClasses = (
  architecture: Architecture,
  topologyPlan: TopologyExecutionPlan,
  requestRuntimes: RequestClassRuntime[],
  aggregateExecution: TopologyNodeExecution[],
  aggregateEdgeExecution: TopologyEdgeExecution[],
  nodeForwardingFactors: readonly number[],
  requestedRps: number,
  cacheHitRatesByNode: readonly number[],
  payloadMultiplier: number,
  collectTraceEvidence: boolean,
): void => {
  for (
    let requestRuntimeIndex = 0;
    requestRuntimeIndex < requestRuntimes.length;
    requestRuntimeIndex += 1
  ) {
    const requestRuntime = requestRuntimes[requestRuntimeIndex]!;
    const requestPlan = requestRuntime.plan;
    const profile = requestPlan.profile;
    requestRuntime.forwardDemand.fill(0);
    requestRuntime.synchronousForwardDemand.fill(0);
    requestRuntime.edgeAttemptedRps.fill(0);
    requestRuntime.edgeSynchronousAttemptedRps.fill(0);
    requestRuntime.nodeDemand.fill(0);
    requestRuntime.nodeSynchronousAttemptedDemand.fill(0);
    if (collectTraceEvidence && requestPlan.traced) {
      for (const state of requestRuntime.edgeExecution) {
        state.attemptedRps = 0;
        state.throughputRps = 0;
        state.retryRps = 0;
        state.synchronousAttemptedRps = 0;
        state.lostRps = 0;
        state.transportLostRps = 0;
        state.targetUnavailableRps = 0;
        state.latencyMs = 0;
        state.cacheHitRps = 0;
        state.cacheMissRps = 0;
        state.asyncQueueRps = 0;
      }
    }
    const classRequestedRps = requestedRps * requestPlan.share;
    for (
      let entryIndex = 0;
      entryIndex < requestPlan.entryIndexes.length;
      entryIndex += 1
    ) {
      const sourceIndex = requestPlan.entryIndexes[entryIndex]!;
      const sourceDemand =
        classRequestedRps * (requestPlan.entryWeights[entryIndex] ?? 0);
      const aggregateState = aggregateExecution[sourceIndex];
      if (!aggregateState) continue;
      requestRuntime.nodeDemand[sourceIndex] =
        (requestRuntime.nodeDemand[sourceIndex] ?? 0) + sourceDemand;
      requestRuntime.nodeSynchronousAttemptedDemand[sourceIndex] =
        (requestRuntime.nodeSynchronousAttemptedDemand[sourceIndex] ?? 0) +
        sourceDemand;
      const sourceForwardingFactor = nodeForwardingFactors[sourceIndex] ?? 1;
      requestRuntime.forwardDemand[sourceIndex] =
        (requestRuntime.forwardDemand[sourceIndex] ?? 0) +
        sourceDemand * sourceForwardingFactor;
      requestRuntime.synchronousForwardDemand[sourceIndex] =
        (requestRuntime.synchronousForwardDemand[sourceIndex] ?? 0) +
        sourceDemand * sourceForwardingFactor;
      aggregateState.demand += sourceDemand;
      aggregateState.readDemand += sourceDemand * profile.readRatio;
      aggregateState.readPayloadDemandKb +=
        sourceDemand * profile.readRatio * profile.payloadKb;
      aggregateState.deliveredWriteDemand +=
        sourceDemand * (1 - profile.readRatio);
      aggregateState.payloadDemandKb += sourceDemand * profile.payloadKb;
      aggregateState.computeDemandMs += sourceDemand * profile.computeMs;
      aggregateState.criticalDemand += sourceDemand * profile.criticalShare;
      aggregateState.synchronousAttemptedDemand += sourceDemand;
    }
  }

  for (
    let orderIndex = 0;
    orderIndex < topologyPlan.executionOrderIndexes.length;
    orderIndex += 1
  ) {
    const sourceIndex = topologyPlan.executionOrderIndexes[orderIndex]!;
    const source = architecture.nodes[sourceIndex];
    if (!source) continue;
    const outgoing = topologyPlan.outgoingByIndex[sourceIndex] ?? [];
    for (
      let outgoingIndex = 0;
      outgoingIndex < outgoing.length;
      outgoingIndex += 1
    ) {
      const { edgeIndex, targetIndex } = outgoing[outgoingIndex]!;
      const target = architecture.nodes[targetIndex];
      const aggregateTargetState = aggregateExecution[targetIndex];
      const aggregateEdgeState = aggregateEdgeExecution[edgeIndex];
      if (!target || !aggregateTargetState || !aggregateEdgeState) continue;
      for (
        let requestRuntimeIndex = 0;
        requestRuntimeIndex < requestRuntimes.length;
        requestRuntimeIndex += 1
      ) {
        const requestRuntime = requestRuntimes[requestRuntimeIndex]!;
        const requestPlan = requestRuntime.plan;
        const edgeModel = requestRuntime.edgeModels[edgeIndex];
        if (!edgeModel) continue;
        const edgeCacheHitRate = cacheHitRateForEdge(
          topologyPlan,
          requestRuntime,
          sourceIndex,
          targetIndex,
          edgeIndex,
          cacheHitRatesByNode,
        );
        requestRuntime.edgeCacheHitRates[edgeIndex] = edgeCacheHitRate;
        const sourceForwardDemand =
          requestRuntime.forwardDemand[sourceIndex] ?? 0;
        if (
          sourceForwardDemand <= 0 ||
          source.id === requestPlan.terminalNodeId
        )
          continue;
        const trafficShare = edgeModel.trafficShare;
        if (trafficShare <= 0) continue;
        const profile = requestPlan.profile;
        // Local demand is work performed by the target; forwarded demand is
        // the logical flow that remains available to later nodes on the route.
        const localFactor = Math.max(
          0,
          edgeModel.localBase -
            edgeModel.localCacheCoefficient * edgeCacheHitRate,
        );
        const forwardedFactor = Math.max(
          0,
          edgeModel.forwardBase -
            edgeModel.forwardCacheCoefficient * edgeCacheHitRate,
        );
        const retryDemand = requestRuntime.edgeRetryDemand[edgeIndex] ?? 0;
        const synchronousRetryDemand = edgeModel.asynchronous
          ? 0
          : (requestRuntime.edgeSynchronousRetryDemand[edgeIndex] ?? 0);
        const targetForwardingFactor = nodeForwardingFactors[targetIndex] ?? 1;
        const attemptedForward =
          sourceForwardDemand * trafficShare + retryDemand;
        const attemptedLocal = attemptedForward * localFactor;
        const deliveredLocal = attemptedLocal * edgeModel.survivalRate;
        const acceptedLocal = deliveredLocal * targetForwardingFactor;
        const deliveredForward =
          attemptedForward *
          forwardedFactor *
          edgeModel.survivalRate *
          targetForwardingFactor;
        const attemptedSynchronousForward = edgeModel.asynchronous
          ? 0
          : (requestRuntime.synchronousForwardDemand[sourceIndex] ?? 0) *
              trafficShare +
            synchronousRetryDemand;
        const deliveredSynchronousForward =
          attemptedSynchronousForward *
          forwardedFactor *
          edgeModel.survivalRate *
          targetForwardingFactor;

        requestRuntime.forwardDemand[targetIndex] =
          (requestRuntime.forwardDemand[targetIndex] ?? 0) + deliveredForward;
        requestRuntime.synchronousForwardDemand[targetIndex] =
          (requestRuntime.synchronousForwardDemand[targetIndex] ?? 0) +
          deliveredSynchronousForward;
        requestRuntime.nodeDemand[targetIndex] =
          (requestRuntime.nodeDemand[targetIndex] ?? 0) + acceptedLocal;
        requestRuntime.nodeSynchronousAttemptedDemand[targetIndex] =
          (requestRuntime.nodeSynchronousAttemptedDemand[targetIndex] ?? 0) +
          attemptedSynchronousForward * localFactor;

        aggregateTargetState.demand += acceptedLocal;
        aggregateTargetState.readDemand += acceptedLocal * profile.readRatio;
        aggregateTargetState.readPayloadDemandKb +=
          acceptedLocal * profile.readRatio * profile.payloadKb;
        aggregateTargetState.deliveredWriteDemand +=
          deliveredLocal * (1 - profile.readRatio);
        aggregateTargetState.payloadDemandKb +=
          acceptedLocal * profile.payloadKb;
        aggregateTargetState.computeDemandMs +=
          acceptedLocal * profile.computeMs;
        aggregateTargetState.criticalDemand +=
          acceptedLocal * profile.criticalShare;
        aggregateTargetState.synchronousAttemptedDemand +=
          attemptedSynchronousForward * localFactor;
        aggregateTargetState.attemptedTransportDemand += attemptedLocal;
        aggregateTargetState.deliveredTransportDemand += deliveredLocal;
        aggregateTargetState.lostTransportDemand +=
          attemptedLocal - deliveredLocal;
        aggregateTargetState.latencyDemandMs +=
          deliveredLocal * edgeModel.baseLatencyMs;
        aggregateTargetState.jitterDemandMs +=
          deliveredLocal * edgeModel.jitterMs;

        const transportFactor = Math.max(localFactor, forwardedFactor);
        const edgeAttemptedRps = attemptedForward * transportFactor;
        const transportThroughputRps =
          edgeAttemptedRps * edgeModel.survivalRate;
        const edgeThroughputRps =
          transportThroughputRps * targetForwardingFactor;
        const transportLostRps = edgeAttemptedRps - transportThroughputRps;
        const targetUnavailableRps = transportThroughputRps - edgeThroughputRps;
        const edgeLostRps = transportLostRps + targetUnavailableRps;
        requestRuntime.edgeAttemptedRps[edgeIndex] = edgeAttemptedRps;
        requestRuntime.edgeSynchronousAttemptedRps[edgeIndex] =
          attemptedSynchronousForward * transportFactor;
        const edgeState =
          collectTraceEvidence && requestPlan.traced
            ? requestRuntime.edgeExecution[edgeIndex]!
            : undefined;
        if (edgeState) {
          edgeState.attemptedRps = edgeAttemptedRps;
          edgeState.throughputRps = edgeThroughputRps;
          edgeState.retryRps = retryDemand;
          edgeState.synchronousAttemptedRps =
            attemptedSynchronousForward * transportFactor;
          edgeState.lostRps = edgeLostRps;
          edgeState.transportLostRps = transportLostRps;
          edgeState.targetUnavailableRps = targetUnavailableRps;
          edgeState.latencyMs = edgeModel.latencyMs;
        }
        aggregateEdgeState.attemptedRps += edgeAttemptedRps;
        aggregateEdgeState.throughputRps += edgeThroughputRps;
        aggregateEdgeState.retryRps += retryDemand;
        aggregateEdgeState.synchronousAttemptedRps +=
          attemptedSynchronousForward * transportFactor;
        aggregateEdgeState.lostRps += edgeLostRps;
        aggregateEdgeState.transportLostRps += transportLostRps;
        aggregateEdgeState.targetUnavailableRps += targetUnavailableRps;
        aggregateEdgeState.latencyMs = edgeModel.latencyMs;
        if (edgeModel.cacheTarget) {
          const cacheMissRps = deliveredForward;
          const cacheHitRps = Math.max(0, acceptedLocal - deliveredForward);
          if (edgeState) {
            edgeState.cacheMissRps = cacheMissRps;
            edgeState.cacheHitRps = cacheHitRps;
          }
          aggregateEdgeState.cacheMissRps += cacheMissRps;
          aggregateEdgeState.cacheHitRps += cacheHitRps;
        }
        if (edgeModel.asyncQueueTarget) {
          if (edgeState) edgeState.asyncQueueRps = acceptedLocal;
          aggregateEdgeState.asyncQueueRps += acceptedLocal;
        }
        if (edgeModel.bandwidthScale > 0)
          aggregateTargetState.edgeNetworkUtilization = Math.max(
            aggregateTargetState.edgeNetworkUtilization,
            attemptedLocal * edgeModel.bandwidthScale * payloadMultiplier,
          );
      }
    }
  }
};

const resetAggregateTopologyExecution = (
  nodeExecution: TopologyNodeExecution[],
  edgeExecution: TopologyEdgeExecution[],
): void => {
  for (let index = 0; index < nodeExecution.length; index += 1) {
    const state = nodeExecution[index]!;
    state.demand = 0;
    state.readDemand = 0;
    state.readPayloadDemandKb = 0;
    state.deliveredWriteDemand = 0;
    state.payloadDemandKb = 0;
    state.computeDemandMs = 0;
    state.criticalDemand = 0;
    state.synchronousAttemptedDemand = 0;
    state.forwardDemand = 0;
    state.synchronousForwardDemand = 0;
    state.attemptedTransportDemand = 0;
    state.deliveredTransportDemand = 0;
    state.lostTransportDemand = 0;
    state.latencyDemandMs = 0;
    state.jitterDemandMs = 0;
    state.edgeNetworkUtilization = 0;
    state.edgeProfile.baseLatencyMs = 0;
    state.edgeProfile.jitterMs = 0;
    state.edgeProfile.packetLossRate = 0;
    state.edgeProfile.networkUtilization = 0;
  }
  for (let index = 0; index < edgeExecution.length; index += 1) {
    const state = edgeExecution[index]!;
    state.attemptedRps = 0;
    state.throughputRps = 0;
    state.retryRps = 0;
    state.synchronousAttemptedRps = 0;
    state.lostRps = 0;
    state.transportLostRps = 0;
    state.targetUnavailableRps = 0;
    state.latencyMs = 0;
    state.cacheHitRps = 0;
    state.cacheMissRps = 0;
    state.asyncQueueRps = 0;
  }
};

const finalizeAggregateTopologyExecution = (
  execution: TopologyNodeExecution[],
): void => {
  for (let index = 0; index < execution.length; index += 1) {
    const state = execution[index]!;
    state.edgeProfile.baseLatencyMs =
      state.deliveredTransportDemand > 0
        ? state.latencyDemandMs / state.deliveredTransportDemand
        : 0;
    state.edgeProfile.jitterMs =
      state.deliveredTransportDemand > 0
        ? state.jitterDemandMs / state.deliveredTransportDemand
        : 0;
    state.edgeProfile.packetLossRate =
      state.attemptedTransportDemand > 0
        ? clamp(
            state.lostTransportDemand / state.attemptedTransportDemand,
            0,
            1,
          )
        : 0;
    state.edgeProfile.networkUtilization = state.edgeNetworkUtilization;
  }
};

const validateModeledExecutionRates = (
  nodeExecution: readonly TopologyNodeExecution[],
  edgeExecution: readonly TopologyEdgeExecution[],
): void => {
  for (let index = 0; index < nodeExecution.length; index += 1) {
    const state = nodeExecution[index]!;
    if (modeledRateIsUnsafe(state.demand))
      rejectUnsafeModeledRate(`node:${index}:demand`, state.demand);
    if (modeledRateIsUnsafe(state.readDemand))
      rejectUnsafeModeledRate(`node:${index}:read-demand`, state.readDemand);
    if (modeledRateIsUnsafe(state.readPayloadDemandKb))
      rejectUnsafeModeledRate(
        `node:${index}:read-payload-demand`,
        state.readPayloadDemandKb,
      );
    if (modeledRateIsUnsafe(state.deliveredWriteDemand))
      rejectUnsafeModeledRate(
        `node:${index}:delivered-write-demand`,
        state.deliveredWriteDemand,
      );
    if (modeledRateIsUnsafe(state.payloadDemandKb))
      rejectUnsafeModeledRate(
        `node:${index}:payload-demand`,
        state.payloadDemandKb,
      );
    if (modeledRateIsUnsafe(state.computeDemandMs))
      rejectUnsafeModeledRate(
        `node:${index}:compute-demand`,
        state.computeDemandMs,
      );
    if (modeledRateIsUnsafe(state.synchronousAttemptedDemand))
      rejectUnsafeModeledRate(
        `node:${index}:sync-demand`,
        state.synchronousAttemptedDemand,
      );
    if (modeledRateIsUnsafe(state.forwardDemand))
      rejectUnsafeModeledRate(
        `node:${index}:forward-demand`,
        state.forwardDemand,
      );
    if (modeledRateIsUnsafe(state.synchronousForwardDemand))
      rejectUnsafeModeledRate(
        `node:${index}:sync-forward-demand`,
        state.synchronousForwardDemand,
      );
    if (modeledRateIsUnsafe(state.attemptedTransportDemand))
      rejectUnsafeModeledRate(
        `node:${index}:transport-demand`,
        state.attemptedTransportDemand,
      );
  }
  for (let index = 0; index < edgeExecution.length; index += 1) {
    const state = edgeExecution[index]!;
    if (modeledRateIsUnsafe(state.attemptedRps))
      rejectUnsafeModeledRate(
        `edge:${index}:attempted-rps`,
        state.attemptedRps,
      );
    if (modeledRateIsUnsafe(state.throughputRps))
      rejectUnsafeModeledRate(
        `edge:${index}:throughput-rps`,
        state.throughputRps,
      );
    if (modeledRateIsUnsafe(state.retryRps))
      rejectUnsafeModeledRate(`edge:${index}:retry-rps`, state.retryRps);
    if (modeledRateIsUnsafe(state.lostRps))
      rejectUnsafeModeledRate(`edge:${index}:lost-rps`, state.lostRps);
    if (modeledRateIsUnsafe(state.transportLostRps))
      rejectUnsafeModeledRate(
        `edge:${index}:transport-lost-rps`,
        state.transportLostRps,
      );
    if (modeledRateIsUnsafe(state.targetUnavailableRps))
      rejectUnsafeModeledRate(
        `edge:${index}:target-unavailable-rps`,
        state.targetUnavailableRps,
      );
  }
};

const sampledTraceForRequestClass = (
  scenario: Scenario,
  architecture: Architecture,
  requestRuntime: RequestClassRuntime,
  nodeMetrics: Record<string, NodeMetricSnapshot>,
  second: number,
): SampledTrace => {
  const traceId = `trace-${scenario.seed}-${requestRuntime.plan.index}-${second}`;
  const rootMessageId = `${traceId}-request`;
  const queryClass: NonNullable<SampledSpan["queryClass"]> =
    requestRuntime.plan.profile.readRatio >= 0.95
      ? "read"
      : requestRuntime.plan.profile.readRatio <= 0.05
        ? "write"
        : "mixed";
  const failureCause = (
    metric: TopologyEdgeExecution | undefined,
    targetMetric: NodeMetricSnapshot | undefined,
  ): SampledSpan["failureCause"] => {
    if (targetMetric?.state === "offline") return "target-offline";
    if ((metric?.targetUnavailableRps ?? 0) > 0) return "target-error";
    if ((metric?.transportLostRps ?? 0) > 0) return "transport-loss";
    if (
      targetMetric &&
      targetMetric.latencyMs >
        (scenario.workload.clientTimeoutMs ?? Number.POSITIVE_INFINITY)
    )
      return "timeout";
    if (targetMetric?.state === "critical") return "capacity-pressure";
    if ((targetMetric?.errorRate ?? 0) > 0) return "target-error";
    return undefined;
  };
  const connectionPoolWaitMs = (
    target: ArchitectureNode | undefined,
    targetMetric: NodeMetricSnapshot | undefined,
  ): number | undefined => {
    if (
      !target ||
      (target.kind !== "database" && target.kind !== "third-party")
    )
      return undefined;
    const poolPressure = Math.max(
      0,
      (targetMetric?.connectionUtilization ?? 0) - 0.65,
    );
    return rounded(
      poolPressure * Math.max(1, targetMetric?.latencyMs ?? 0) * 0.5,
    );
  };
  const spans: SampledSpan[] = [];
  let truncated = false;
  let spanSequence = 0;
  const pushSpan = (span: Omit<SampledSpan, "spanId">): string | undefined => {
    if (spans.length >= MAX_SPANS_PER_TRACE) {
      truncated = true;
      return undefined;
    }
    const spanId = `${traceId}-span-${spanSequence}`;
    spanSequence += 1;
    spans.push({ spanId, ...span });
    return spanId;
  };
  const multiEntry = requestRuntime.plan.entryIndexes.length > 1;
  const entrySpanId = pushSpan({
    kind: "entry",
    name: multiEntry
      ? `Enter ${requestRuntime.plan.entryIndexes.length} modeled sources`
      : `Enter ${requestRuntime.plan.entryNodeId}`,
    ...(multiEntry ? {} : { nodeId: requestRuntime.plan.entryNodeId }),
    attemptedRps: rounded(
      requestRuntime.plan.entryIndexes.reduce(
        (total, nodeIndex) =>
          total + (requestRuntime.nodeDemand[nodeIndex] ?? 0),
        0,
      ),
    ),
    throughputRps: rounded(
      requestRuntime.plan.entryIndexes.reduce(
        (total, nodeIndex) =>
          total + (requestRuntime.forwardDemand[nodeIndex] ?? 0),
        0,
      ),
    ),
    retryRps: 0,
    lostRps: 0,
    latencyMs: 0,
    queryClass,
    messageId: rootMessageId,
    asynchronous: false,
    status: "ok",
  })!;
  const parentSpanByNode = new Map<string, string>();
  const messageLineageByNode = new Map<
    string,
    { messageId: string; parentMessageId?: string }
  >();
  for (const entryIndex of requestRuntime.plan.entryIndexes) {
    const entryNode = architecture.nodes[entryIndex];
    if (entryNode) {
      const entryMessageId = multiEntry
        ? `${rootMessageId}-${entryNode.id}`
        : rootMessageId;
      const sourceSpanId = multiEntry
        ? (pushSpan({
            parentSpanId: entrySpanId,
            kind: "entry",
            name: `Enter ${entryNode.id}`,
            nodeId: entryNode.id,
            attemptedRps: rounded(requestRuntime.nodeDemand[entryIndex] ?? 0),
            throughputRps: rounded(
              requestRuntime.forwardDemand[entryIndex] ?? 0,
            ),
            retryRps: 0,
            lostRps: 0,
            latencyMs: 0,
            queryClass,
            messageId: entryMessageId,
            parentMessageId: rootMessageId,
            asynchronous: false,
            status: "ok",
          }) ?? entrySpanId)
        : entrySpanId;
      parentSpanByNode.set(entryNode.id, sourceSpanId);
      messageLineageByNode.set(entryNode.id, {
        messageId: entryMessageId,
        ...(multiEntry ? { parentMessageId: rootMessageId } : {}),
      });
    }
  }
  let finalTargetId: string | undefined;

  for (const edgeIndex of requestRuntime.plan.routeEdgeOrder ?? []) {
    const edge = architecture.edges[edgeIndex];
    const metric = requestRuntime.edgeExecution[edgeIndex];
    if (!edge || !metric || metric.attemptedRps <= 0) continue;
    const parentSpanId = parentSpanByNode.get(edge.source) ?? entrySpanId;
    const targetMetric = nodeMetrics[edge.target];
    const targetNode = architecture.nodes.find(
      (node) => node.id === edge.target,
    );
    const messageLineage = messageLineageByNode.get(edge.source) ?? {
      messageId: rootMessageId,
    };
    const modeledFailureCause = failureCause(metric, targetMetric);
    const status =
      metric.throughputRps <= 0
        ? "dropped"
        : metric.lostRps > 0 || (targetMetric?.errorRate ?? 0) > 0
          ? "degraded"
          : "ok";
    const edgeSpanId = pushSpan({
      parentSpanId,
      kind: "edge",
      name: `${edge.source} to ${edge.target}`,
      edgeId: edge.id,
      sourceNodeId: edge.source,
      targetNodeId: edge.target,
      attemptedRps: rounded(metric.attemptedRps),
      throughputRps: rounded(metric.throughputRps),
      retryRps: rounded(metric.retryRps),
      lostRps: rounded(metric.lostRps),
      latencyMs: rounded(metric.latencyMs),
      ...(targetNode?.kind === "database" ? { queryClass } : {}),
      ...messageLineage,
      ...(connectionPoolWaitMs(targetNode, targetMetric) === undefined
        ? {}
        : {
            connectionPoolWaitMs: connectionPoolWaitMs(
              targetNode,
              targetMetric,
            ),
          }),
      ...(modeledFailureCause ? { failureCause: modeledFailureCause } : {}),
      asynchronous: edge.config?.asynchronous === true,
      status,
    });
    if (!edgeSpanId) break;
    parentSpanByNode.set(edge.target, edgeSpanId);
    messageLineageByNode.set(edge.target, messageLineage);
    finalTargetId = edge.target;

    if (metric.retryRps > 0) {
      const sourceNode = architecture.nodes.find(
        (node) => node.id === edge.source,
      );
      const configuredRetryAttempts = Math.max(
        1,
        sourceNode?.config.behavior?.resilience?.maxRetries ?? 1,
      );
      const sampledRetryAttempts = Math.min(configuredRetryAttempts, 4);
      const retryWeightTotal = Array.from(
        { length: configuredRetryAttempts },
        (_, index) => 0.5 ** index,
      ).reduce((total, weight) => total + weight, 0);
      let retryParentSpanId = edgeSpanId;
      for (
        let retryAttempt = 1;
        retryAttempt <= sampledRetryAttempts;
        retryAttempt += 1
      ) {
        const attemptRps =
          (metric.retryRps * 0.5 ** (retryAttempt - 1)) / retryWeightTotal;
        const retrySpanId = pushSpan({
          parentSpanId: retryParentSpanId,
          kind: "retry",
          name: `Retry ${edge.id} attempt ${retryAttempt}`,
          edgeId: edge.id,
          sourceNodeId: edge.source,
          targetNodeId: edge.target,
          attemptedRps: rounded(attemptRps),
          throughputRps: rounded(
            attemptRps *
              (metric.throughputRps / Math.max(1, metric.attemptedRps)),
          ),
          retryRps: rounded(attemptRps),
          lostRps: rounded(
            attemptRps * (metric.lostRps / Math.max(1, metric.attemptedRps)),
          ),
          latencyMs: rounded(metric.latencyMs),
          retryAttempt,
          ...(targetNode?.kind === "database" ? { queryClass } : {}),
          ...messageLineage,
          ...(modeledFailureCause ? { failureCause: modeledFailureCause } : {}),
          asynchronous: edge.config?.asynchronous === true,
          status,
        });
        if (!retrySpanId) break;
        retryParentSpanId = retrySpanId;
      }
      if (configuredRetryAttempts > sampledRetryAttempts) truncated = true;
    }
    if (metric.cacheHitRps > 0 || metric.cacheMissRps > 0)
      pushSpan({
        parentSpanId: edgeSpanId,
        kind: "cache",
        name: `Cache decision at ${edge.target}`,
        nodeId: edge.target,
        edgeId: edge.id,
        attemptedRps: rounded(metric.cacheHitRps + metric.cacheMissRps),
        throughputRps: rounded(metric.cacheHitRps),
        retryRps: 0,
        lostRps: 0,
        latencyMs: 0,
        cacheHitRps: rounded(metric.cacheHitRps),
        cacheMissRps: rounded(metric.cacheMissRps),
        ...messageLineage,
        asynchronous: false,
        status:
          metric.cacheHitRps <= 0 && metric.cacheMissRps > 0
            ? "degraded"
            : "ok",
      });
    if (metric.asyncQueueRps > 0) {
      const queuedMessageLineage = {
        messageId: `${traceId}-message-${edgeIndex}`,
        parentMessageId: messageLineage.messageId,
      };
      pushSpan({
        parentSpanId: edgeSpanId,
        kind: "async-queue",
        name: `Enqueue at ${edge.target}`,
        nodeId: edge.target,
        edgeId: edge.id,
        attemptedRps: rounded(metric.asyncQueueRps),
        throughputRps: rounded(metric.asyncQueueRps),
        retryRps: 0,
        lostRps: 0,
        latencyMs: 0,
        ...queuedMessageLineage,
        ...(modeledFailureCause ? { failureCause: modeledFailureCause } : {}),
        asynchronous: true,
        status,
      });
      messageLineageByNode.set(edge.target, queuedMessageLineage);
    }
  }

  const terminalNodeId = requestRuntime.plan.terminalNodeId ?? finalTargetId;
  const terminalParentId = terminalNodeId
    ? multiEntry
      ? entrySpanId
      : parentSpanByNode.get(terminalNodeId)
    : undefined;
  if (terminalNodeId && terminalParentId) {
    const terminalDemand =
      requestRuntime.nodeDemand[
        architecture.nodes.findIndex((node) => node.id === terminalNodeId)
      ] ?? 0;
    const terminalMetric = nodeMetrics[terminalNodeId];
    const terminalNode = architecture.nodes.find(
      (node) => node.id === terminalNodeId,
    );
    const terminalFailureCause = failureCause(undefined, terminalMetric);
    const terminalMessageLineage = multiEntry
      ? { messageId: rootMessageId }
      : (messageLineageByNode.get(terminalNodeId) ?? {
          messageId: rootMessageId,
        });
    pushSpan({
      parentSpanId: terminalParentId,
      kind: "terminal",
      name: `Terminate at ${terminalNodeId}`,
      nodeId: terminalNodeId,
      attemptedRps: rounded(terminalDemand),
      throughputRps: rounded(
        terminalDemand * (1 - (terminalMetric?.errorRate ?? 0) / 100),
      ),
      retryRps: 0,
      lostRps: rounded(
        terminalDemand * ((terminalMetric?.errorRate ?? 0) / 100),
      ),
      latencyMs: rounded(terminalMetric?.latencyMs ?? 0),
      ...(terminalNode?.kind === "database" ? { queryClass } : {}),
      ...terminalMessageLineage,
      ...(connectionPoolWaitMs(terminalNode, terminalMetric) === undefined
        ? {}
        : {
            connectionPoolWaitMs: connectionPoolWaitMs(
              terminalNode,
              terminalMetric,
            ),
          }),
      ...(terminalFailureCause ? { failureCause: terminalFailureCause } : {}),
      asynchronous: false,
      status:
        terminalMetric?.state === "offline"
          ? "dropped"
          : (terminalMetric?.errorRate ?? 0) > 0
            ? "degraded"
            : "ok",
    });
  }

  return {
    traceId,
    second,
    requestClass: requestRuntime.plan.name,
    modeledRps: rounded(
      requestRuntime.plan.entryIndexes.reduce(
        (total, nodeIndex) =>
          total + (requestRuntime.nodeDemand[nodeIndex] ?? 0),
        0,
      ),
    ),
    entryNodeId: requestRuntime.plan.entryNodeId,
    ...(multiEntry
      ? {
          entryNodeIds: requestRuntime.plan.entryIndexes.map(
            (nodeIndex) => architecture.nodes[nodeIndex]!.id,
          ),
        }
      : {}),
    ...(terminalNodeId ? { terminalNodeId } : {}),
    truncated,
    spans,
  };
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
    const replicaWeight = componentOwnsState(node.kind)
      ? Math.log2(node.config.replicas + 1) * 1.4
      : 0;
    const partitionWeight = Math.log2(
      (behavior?.storage?.partitions ?? behavior?.messaging?.partitions ?? 1) +
        1,
    );
    const managedDiscount = behavior?.operations?.managed ? 0.6 : 1;
    return (
      total +
      managedDiscount *
        ((behavior?.operations?.complexityWeight ?? 1.5) +
          replicaWeight +
          partitionWeight)
    );
  }, 0);
  return rounded(
    clamp(componentWeight + kinds * 1.2 + Math.max(0, regions - 1) * 5, 0, 100),
  );
};

const stateForUtilization = (
  utilization: number,
  offline: boolean,
  errorRate: number,
): NodeMetricSnapshot["state"] => {
  if (offline) return "offline";
  if (utilization >= 1 || errorRate >= 0.2) return "critical";
  if (utilization >= 0.72 || errorRate >= 0.01) return "warning";
  return "healthy";
};

export function simulate(
  inputScenario: Scenario,
  inputArchitecture: Architecture,
  options: SimulationOptions = {},
): SimulationResult {
  const scenario = scenarioSchema.parse(inputScenario);
  const architecture = architectureSchema.parse(inputArchitecture);
  const actions = simulationActionScheduleSchema.parse(options.actions ?? []);
  const inputFingerprint = simulationInputFingerprintFromParsedInputs(
    scenario,
    architecture,
    ENGINE_VERSION,
    actions,
  );
  const executionWorkUnits = estimateSimulationExecutionWorkUnits(
    scenario,
    architecture,
    actions.length,
  );
  if (executionWorkUnits > MAX_SIMULATION_EXECUTION_WORK_UNITS)
    throw new Error(
      `simulation_work_budget_exceeded:${executionWorkUnits}:${MAX_SIMULATION_EXECUTION_WORK_UNITS}`,
    );
  const outputMetricCells = estimateSimulationOutputMetricCells(
    scenario,
    architecture,
  );
  if (outputMetricCells > MAX_SIMULATION_OUTPUT_METRIC_CELLS)
    throw new Error(
      `simulation_output_budget_exceeded:${outputMetricCells}:${MAX_SIMULATION_OUTPUT_METRIC_CELLS}`,
    );
  const estimatedResultBytes = estimateSimulationResultBytes(
    scenario,
    architecture,
  );
  if (estimatedResultBytes > MAX_SIMULATION_ESTIMATED_RESULT_BYTES)
    throw new Error(
      `simulation_result_bytes_exceeded:${estimatedResultBytes}:${MAX_SIMULATION_ESTIMATED_RESULT_BYTES}`,
    );
  const behavioralProfiles = resolveBehavioralProfileEvidence(architecture);
  const architectureNodeById = new Map(
    architecture.nodes.map((node) => [node.id, node]),
  );
  const incidentIds = new Set(
    scenario.incidents.map((incident) => incident.id),
  );
  const interventionActionsAt = new Map<number, SimulationAction[]>();
  for (const action of actions) {
    if (action.atSecond > scenario.workload.durationSeconds)
      throw new Error(`invalid_action:outside-duration:${action.id}`);
    if (action.type === "inject-incident") {
      if (incidentIds.has(action.incident.id))
        throw new Error(
          `invalid_action:duplicate-incident-id:${action.incident.id}`,
        );
      incidentIds.add(action.incident.id);
      scenario.incidents.push({
        ...action.incident,
        atSecond: action.atSecond,
      });
      continue;
    }
    const targetNode = architectureNodeById.get(action.nodeId);
    if (!targetNode)
      throw new Error(`invalid_action:unknown-node:${action.nodeId}`);
    if (
      action.intervention.kind === "scale" &&
      action.intervention.instances > targetNode.config.maxInstances
    )
      throw new Error(`invalid_action:scale-exceeds-maximum:${action.id}`);
    if (
      action.intervention.kind === "scale" &&
      action.intervention.instances <
        (targetNode.config.behavior?.scaling?.minInstances ?? 1)
    )
      throw new Error(`invalid_action:scale-below-minimum:${action.id}`);
    if (
      action.intervention.kind === "circuit-breaker" &&
      targetNode.kind !== "api" &&
      targetNode.kind !== "load-balancer" &&
      targetNode.kind !== "third-party"
    )
      throw new Error(
        `invalid_action:inapplicable-circuit-breaker:${action.id}`,
      );
    if (
      action.intervention.kind === "load-shedding" &&
      targetNode.kind !== "api" &&
      targetNode.kind !== "load-balancer"
    )
      throw new Error(`invalid_action:inapplicable-load-shedding:${action.id}`);
    interventionActionsAt.set(action.atSecond, [
      ...(interventionActionsAt.get(action.atSecond) ?? []),
      action,
    ]);
  }
  const topologyPlan = validatedTopologyExecutionPlan(scenario, architecture);
  const runtimeNodeIndexById = new Map(
    architecture.nodes.map((node, index) => [node.id, index]),
  );
  const stochasticRulePlans = buildStochasticIncidentRulePlans(
    scenario,
    architecture,
    topologyPlan,
  );
  const requestClassPlans = buildRequestClassExecutionPlans(
    scenario,
    architecture,
    topologyPlan,
    options.includeTraces !== false,
  );
  const random = new DeterministicRandom(scenario.seed);
  const profile = workloadProfile(scenario);
  const reachable = topologyPlan.reachable;
  const frames: MetricFrame[] = [];
  const events: CausalEvent[] = [];
  const generatedIncidents: GeneratedIncidentRecord[] = [];
  const generatedIncidentById = new Map<string, GeneratedIncidentRecord>();
  const emitted = new Set<string>();
  const runtimeStates: RuntimeNodeState[] = architecture.nodes.map((node) => ({
    activeInstances: node.config.instances,
    pendingInstances: 0,
    pendingReadyAt: Number.POSITIVE_INFINITY,
    lastScaleSecond: Number.NEGATIVE_INFINITY,
    queueDepth: 0,
    memoryLeakMb: 0,
  }));
  const runtime = new Map<string, RuntimeNodeState>(
    architecture.nodes.map((node, nodeIndex) => [
      node.id,
      runtimeStates[nodeIndex]!,
    ]),
  );
  const topologyExecution = createTopologyExecutionState(architecture);
  const topologyEdgeExecution = createTopologyEdgeExecutionState(architecture);
  const requestClassRuntimes: RequestClassRuntime[] = requestClassPlans.map(
    (plan) => ({
      plan,
      nodeDemand: new Float64Array(architecture.nodes.length),
      nodeSynchronousAttemptedDemand: new Float64Array(
        architecture.nodes.length,
      ),
      edgeExecution: plan.traced
        ? createTopologyEdgeExecutionState(architecture)
        : [],
      forwardDemand: new Float64Array(architecture.nodes.length),
      synchronousForwardDemand: new Float64Array(architecture.nodes.length),
      edgeAttemptedRps: new Float64Array(architecture.edges.length),
      edgeSynchronousAttemptedRps: new Float64Array(architecture.edges.length),
      edgeRetryDemand: architecture.edges.map(() => 0),
      edgeSynchronousRetryDemand: architecture.edges.map(() => 0),
      edgeModels: createRequestClassEdgeModels(architecture, plan),
      edgeCacheHitRates: new Float64Array(architecture.edges.length),
      outcomeSuccess: new Float64Array(architecture.nodes.length),
      outcomeLatencyMs: new Float64Array(architecture.nodes.length),
    }),
  );
  const dependencyRetryEdgeIndexes = architecture.edges.flatMap(
    (_, edgeIndex) =>
      (requestClassRuntimes[0]?.edgeModels[edgeIndex]?.retryPressureFactor ??
        0) > 0
        ? [edgeIndex]
        : [],
  );
  const dependencyRetryTargetIndexes = dependencyRetryEdgeIndexes.map(
    (edgeIndex) =>
      runtimeNodeIndexById.get(architecture.edges[edgeIndex]!.target)!,
  );
  const dependencyRetryMaxRetries = dependencyRetryEdgeIndexes.map(
    (edgeIndex) =>
      architectureNodeById.get(architecture.edges[edgeIndex]!.source)?.config
        .behavior?.resilience?.maxRetries ?? 0,
  );
  const traces: SampledTrace[] = [];
  const traceSampleSeconds = requestClassPlans.some((plan) => plan.traced)
    ? new Set(
        [
          0,
          ...scenario.incidents.map((incident) =>
            Math.min(scenario.workload.durationSeconds, incident.atSecond + 1),
          ),
          scenario.workload.durationSeconds,
        ]
          .sort((left, right) => left - right)
          .filter((second, index, seconds) => seconds.indexOf(second) === index)
          .slice(0, MAX_TRACE_SAMPLE_SECONDS),
      )
    : new Set<number>();
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
  const nodesOfKind = (kind: ArchitectureNode["kind"]) =>
    reachableNodesByKind.get(kind) ?? [];
  const regionalLatency = scenario.workload.regions.reduce(
    (total, region) => total + region.roundTripMs * region.trafficShare,
    0,
  );
  const clientTimeoutMs = scenario.workload.clientTimeoutMs ?? 120_000;
  const clientRetryPolicy = scenario.workload.retryPolicy ?? {
    maxRetries: 3,
    backoffBaseMs: 80,
    jitter: true,
    retryOnTimeout: true,
  };
  let clientRetryAmplification = 1;
  let cumulativeDurabilityOperations = 0;
  let cumulativeLoss = 0;
  const previousCacheReadPayloadDemandKb = new Float64Array(
    architecture.nodes.length,
  );
  const activeIncidentsByNodeIndex: Incident[][] = architecture.nodes.map(
    () => [],
  );
  const nodeForwardingFactors = architecture.nodes.map(() => 1);
  const cacheHitRatesByNode = architecture.nodes.map(() => 0);
  const nodeMetricsByIndex = new Array<NodeMetricSnapshot>(
    architecture.nodes.length,
  );
  const queueDemandByWorker = new Map<string, number>();
  const cacheNodeIndexes: number[] = [];
  const databaseNodeIndexes: number[] = [];
  for (const [nodeIndex, node] of architecture.nodes.entries()) {
    if (node.kind === "cache") cacheNodeIndexes.push(nodeIndex);
    if (node.kind === "database") databaseNodeIndexes.push(nodeIndex);
  }
  const maxUtilizationByNode = new Float64Array(architecture.nodes.length);

  const emit = (event: CausalEvent): void => {
    if (emitted.has(event.id)) return;
    emitted.add(event.id);
    events.push(event);
  };

  const refreshRetryPolicyForNode = (node: ArchitectureNode): void => {
    const retryPressureFactor = retryPressureFactorForNode(node);
    for (const [edgeIndex, edge] of architecture.edges.entries()) {
      if (edge.source !== node.id) continue;
      for (const requestRuntime of requestClassRuntimes) {
        const edgeModel = requestRuntime.edgeModels[edgeIndex];
        if (edgeModel) edgeModel.retryPressureFactor = retryPressureFactor;
      }
    }
  };

  const applyIntervention = (
    action: Extract<SimulationAction, { type: "apply-intervention" }>,
    second: number,
  ): void => {
    const node = architectureNodeById.get(action.nodeId)!;
    const nodeState = runtime.get(action.nodeId)!;
    let detail: string;
    let effect: NonNullable<CausalEvent["effects"]>[number];
    if (action.intervention.kind === "scale") {
      const previousInstances = nodeState.activeInstances;
      nodeState.activeInstances = action.intervention.instances;
      nodeState.pendingInstances = 0;
      nodeState.pendingReadyAt = Number.POSITIVE_INFINITY;
      nodeState.lastScaleSecond = second;
      detail = `Scheduled modeled scale action set ${node.name} to ${action.intervention.instances} active instances at second ${second}.`;
      effect = {
        metric: "activeInstances",
        delta: action.intervention.instances - previousInstances,
        label: `${previousInstances} to ${action.intervention.instances}`,
      };
    } else if (action.intervention.kind === "circuit-breaker") {
      const behavior = node.config.behavior ?? {};
      node.config.behavior = {
        ...behavior,
        resilience: {
          ...behavior.resilience,
          circuitBreaker: action.intervention.enabled,
        },
      };
      refreshRetryPolicyForNode(node);
      detail = `Scheduled modeled policy action ${action.intervention.enabled ? "enabled" : "disabled"} circuit breaking on ${node.name} at second ${second}.`;
      effect = {
        metric: "circuitBreaker",
        delta: action.intervention.enabled ? 1 : -1,
        label: action.intervention.enabled ? "enabled" : "disabled",
      };
    } else {
      const behavior = node.config.behavior ?? {};
      node.config.behavior = {
        ...behavior,
        resilience: {
          ...behavior.resilience,
          loadSheddingThreshold: action.intervention.threshold,
        },
      };
      refreshRetryPolicyForNode(node);
      detail = `Scheduled modeled policy action set ${node.name} load shedding to ${action.intervention.threshold} modeled utilization at second ${second}.`;
      effect = {
        metric: "loadSheddingThreshold",
        delta: action.intervention.threshold,
        label: `${action.intervention.threshold} modeled utilization`,
      };
    }
    emit({
      id: `intervention-${action.id}`,
      second,
      kind: "operator-intervention",
      severity: "info",
      title: `Applied ${action.intervention.kind} intervention`,
      detail,
      entityId: node.id,
      parentIds: [],
      effects: [effect],
    });
  };

  let currentSecond = 0;
  const activeIncidents: Incident[] = [];
  const latestToggle = (
    node: ArchitectureNode,
    down: Incident["kind"],
    up: Incident["kind"],
  ): Incident | undefined => {
    let latest: Incident | undefined;
    for (const incident of scenario.incidents) {
      const downExpired =
        incident.kind === down &&
        currentSecond >=
          incident.atSecond +
            modeledIncidentDurationSeconds(
              incident,
              scenario.workload.durationSeconds,
            );
      if (
        incident.atSecond <= currentSecond &&
        (incident.kind === down || incident.kind === up) &&
        !downExpired &&
        incidentAffectsNode(incident, node) &&
        (!latest || incident.atSecond >= latest.atSecond)
      )
        latest = incident;
    }
    return latest;
  };
  const effectiveFailoverSeconds = (
    incident: Incident,
    node: ArchitectureNode,
    fallbackSeconds: number,
  ): number =>
    Math.min(
      node.config.behavior?.storage?.failoverSeconds ?? fallbackSeconds,
      modeledIncidentDurationSeconds(
        incident,
        scenario.workload.durationSeconds,
      ),
    );

  for (
    let second = 0;
    second <= scenario.workload.durationSeconds;
    second += 1
  ) {
    currentSecond = second;
    for (const action of interventionActionsAt.get(second) ?? []) {
      if (action.type === "apply-intervention")
        applyIntervention(action, second);
    }
    const stochasticModel = scenario.stochasticIncidents;
    if (
      stochasticModel?.enabled &&
      generatedIncidents.length < stochasticModel.maxGeneratedIncidents
    ) {
      const priorFrame = frames.at(-1);
      for (const plan of stochasticRulePlans) {
        if (generatedIncidents.length >= stochasticModel.maxGeneratedIncidents)
          break;
        if (!plan.rule.enabled) continue;
        if (plan.occurrences >= plan.rule.maxOccurrences) continue;
        if (second < plan.nextEligibleSecond) continue;
        if (!stochasticTriggerPasses(plan.rule, priorFrame)) continue;
        if (plan.random.next() >= plan.rule.hazardRatePerSecond) continue;

        plan.occurrences += 1;
        plan.nextEligibleSecond = second + plan.rule.cooldownSeconds + 1;
        const scope = plan.rule.scope;
        const correlated = scope?.correlated === true;
        const selectedNode =
          plan.eligibleNodes.length === 0 || correlated
            ? undefined
            : plan.eligibleNodes[
                Math.floor(plan.random.next() * plan.eligibleNodes.length)
              ];
        const affectedNodeIds = (
          correlated ? plan.eligibleNodes : selectedNode ? [selectedNode] : []
        ).map((node) => node.id);
        const incident: Incident = {
          id: generatedIncidentId(plan.rule.id, plan.occurrences, incidentIds),
          atSecond: second,
          kind: plan.rule.kind,
          magnitude: plan.rule.magnitude,
          durationSeconds: plan.rule.durationSeconds,
          label: plan.rule.label,
          ...(selectedNode ? { targetId: selectedNode.id } : {}),
          ...(scope?.region ? { region: scope.region } : {}),
          ...(scope?.zone ? { zone: scope.zone } : {}),
          ...(scope?.failureDomain
            ? { failureDomain: scope.failureDomain }
            : {}),
        };
        const record: GeneratedIncidentRecord = {
          ruleId: plan.rule.id,
          occurrence: plan.occurrences,
          incident,
          affectedNodeIds,
          correlated,
          ...(plan.rule.trigger && priorFrame
            ? {
                trigger: {
                  ...plan.rule.trigger,
                  priorFrameSecond: priorFrame.second,
                  observedValue: stochasticTriggerValue(
                    priorFrame,
                    plan.rule.trigger.metric,
                  ),
                },
              }
            : {}),
        };
        generatedIncidents.push(record);
        generatedIncidentById.set(incident.id, record);
        scenario.incidents.push(incident);
        incidentsAt.set(second, [...(incidentsAt.get(second) ?? []), incident]);
        const traceSecond = Math.min(
          scenario.workload.durationSeconds,
          second + 1,
        );
        if (traceSampleSeconds.size < MAX_TRACE_SAMPLE_SECONDS)
          traceSampleSeconds.add(traceSecond);
      }
    }
    for (const incident of incidentsAt.get(second) ?? []) {
      const generated = generatedIncidentById.get(incident.id);
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
            delta: incidentUsesMagnitude(incident.kind)
              ? incident.magnitude
              : 1,
            label: incidentUsesMagnitude(incident.kind)
              ? `${incident.magnitude}x magnitude`
              : "binary state change",
          },
        ],
        recommendations: rootRecommendation(incident.kind),
        ...(generated
          ? {
              generatedIncident: {
                ruleId: generated.ruleId,
                occurrence: generated.occurrence,
                affectedNodeIds: generated.affectedNodeIds,
                correlated: generated.correlated,
              },
            }
          : {}),
      });
    }

    activeIncidents.length = 0;
    for (const incident of scenario.incidents) {
      if (incident.kind.includes("recovery")) continue;
      const end =
        incident.atSecond +
        modeledIncidentDurationSeconds(
          incident,
          scenario.workload.durationSeconds,
        );
      if (second >= incident.atSecond && second < end)
        activeIncidents.push(incident);
    }
    for (
      let nodeIndex = 0;
      nodeIndex < architecture.nodes.length;
      nodeIndex += 1
    ) {
      const node = architecture.nodes[nodeIndex]!;
      const relevant = activeIncidentsByNodeIndex[nodeIndex]!;
      relevant.length = 0;
      for (const incident of activeIncidents) {
        if (incidentAffectsNode(incident, node)) relevant.push(incident);
      }
    }

    for (
      let nodeIndex = 0;
      nodeIndex < architecture.nodes.length;
      nodeIndex += 1
    ) {
      const node = architecture.nodes[nodeIndex]!;
      const state = runtimeStates[nodeIndex]!;
      const relevant = activeIncidentsByNodeIndex[nodeIndex] ?? [];
      if (
        (node.kind === "cache" &&
          latestToggle(node, "cache-failure", "cache-recovery")?.kind ===
            "cache-failure") ||
        relevant.some(
          (incident) =>
            incident.kind === "network-partition" ||
            (incident.kind === "dns-failure" && node.kind === "dns") ||
            (incident.kind === "certificate-expiry" &&
              (node.kind === "cdn" || node.kind === "load-balancer")) ||
            (incident.kind === "third-party-outage" &&
              node.kind === "third-party"),
        )
      ) {
        nodeForwardingFactors[nodeIndex] = 0;
        continue;
      }

      const stateOwning = componentOwnsState(node.kind);
      let factor = 1;
      for (const incident of relevant) {
        if (incident.kind !== "node-failure") continue;
        if (stateOwning) {
          const failoverSeconds = effectiveFailoverSeconds(incident, node, 20);
          factor *=
            node.config.replicas > 0 &&
            second - incident.atSecond >= failoverSeconds
              ? 1
              : node.config.replicas / Math.max(1, node.config.replicas + 1);
        } else {
          factor *=
            Math.max(0, state.activeInstances - 1) /
            Math.max(1, state.activeInstances);
        }
      }
      for (const incident of relevant) {
        if (incident.kind !== "zone-outage") continue;
        const multiAz =
          node.config.behavior?.topology?.zone?.toLowerCase() === "multi-az";
        const hasRedundancy = stateOwning
          ? node.config.replicas > 0
          : state.activeInstances > 1;
        const failoverComplete =
          stateOwning &&
          second - incident.atSecond >=
            effectiveFailoverSeconds(incident, node, 30);
        factor *= multiAz && hasRedundancy ? (failoverComplete ? 1 : 0.62) : 0;
      }
      for (const incident of relevant) {
        if (incident.kind !== "region-outage") continue;
        const multiRegion =
          node.config.behavior?.topology?.failureDomain?.toLowerCase() ===
          "multi-region";
        const failoverComplete =
          stateOwning &&
          node.config.replicas > 0 &&
          second - incident.atSecond >=
            effectiveFailoverSeconds(incident, node, 60);
        const hasRedundancy = stateOwning
          ? node.config.replicas > 0
          : state.activeInstances > 1;
        factor *=
          multiRegion && hasRedundancy ? (failoverComplete ? 1 : 0.5) : 0;
      }
      for (const incident of relevant) {
        if (incident.kind !== "leader-election") continue;
        const failoverComplete =
          stateOwning &&
          node.config.replicas > 0 &&
          second - incident.atSecond >=
            effectiveFailoverSeconds(incident, node, 8);
        factor *= failoverComplete ? 1 : 0;
      }
      nodeForwardingFactors[nodeIndex] = clamp(factor, 0, 1);
    }

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
      scheduledRps *
      arrivalNoise *
      trafficMultiplier *
      clientRetryAmplification;
    const cacheNodes = nodesOfKind("cache");
    for (
      let nodeIndex = 0;
      nodeIndex < architecture.nodes.length;
      nodeIndex += 1
    ) {
      const node = architecture.nodes[nodeIndex]!;
      if (node.kind !== "cache") {
        cacheHitRatesByNode[nodeIndex] = 0;
        continue;
      }
      const toggle = latestToggle(node, "cache-failure", "cache-recovery");
      if (toggle?.kind === "cache-failure") {
        cacheHitRatesByNode[nodeIndex] = 0;
        continue;
      }
      let hitRate = node.config.cacheHitRate;
      const relevant = activeIncidentsByNodeIndex[nodeIndex] ?? [];
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
      if ((cache?.ttlSeconds ?? 300) === 0) {
        cacheHitRatesByNode[nodeIndex] = 0;
        continue;
      }
      hitRate *= 1 - (cache?.hotKeyFraction ?? 0) * 0.35;
      const baseHitRate = clamp(hitRate, 0, 1);
      if (baseHitRate <= 0) {
        cacheHitRatesByNode[nodeIndex] = baseHitRate;
        continue;
      }
      const ttlSeconds = cache?.ttlSeconds ?? 300;
      const routedReadPayloadKb =
        previousCacheReadPayloadDemandKb[nodeIndex] ?? 0;
      const workingSetGb = (routedReadPayloadKb * ttlSeconds) / 1_000_000;
      const capacityGb =
        (cache?.capacityGb ?? 32) *
        (runtimeStates[nodeIndex]?.activeInstances ?? 1);
      const pressure = workingSetGb / Math.max(0.001, capacityGb);
      if (pressure <= 1) {
        cacheHitRatesByNode[nodeIndex] = baseHitRate;
        continue;
      }
      const policyFactor =
        cache?.evictionPolicy === "lfu"
          ? 0.93
          : cache?.evictionPolicy === "fifo"
            ? 0.72
            : cache?.evictionPolicy === "random"
              ? 0.6
              : 0.85;
      cacheHitRatesByNode[nodeIndex] = clamp(
        (baseHitRate * policyFactor) / Math.sqrt(pressure),
        0,
        1,
      );
    }
    resetAggregateTopologyExecution(topologyExecution, topologyEdgeExecution);
    executeRequestClasses(
      architecture,
      topologyPlan,
      requestClassRuntimes,
      topologyExecution,
      topologyEdgeExecution,
      nodeForwardingFactors,
      requestedRps,
      cacheHitRatesByNode,
      payloadMultiplier,
      traceSampleSeconds.has(second),
    );
    for (
      let nodeIndex = 0;
      nodeIndex < architecture.nodes.length;
      nodeIndex += 1
    ) {
      const node = architecture.nodes[nodeIndex]!;
      if (node.kind === "cache")
        previousCacheReadPayloadDemandKb[nodeIndex] =
          topologyExecution[nodeIndex]?.readPayloadDemandKb ?? 0;
    }
    let cacheHitRate = 0;
    for (const nodeIndex of cacheNodeIndexes)
      cacheHitRate += cacheHitRatesByNode[nodeIndex] ?? 0;
    if (cacheNodeIndexes.length > 0) cacheHitRate /= cacheNodeIndexes.length;
    validateModeledExecutionRates(topologyExecution, topologyEdgeExecution);
    finalizeAggregateTopologyExecution(topologyExecution);
    let databaseReadRps = 0;
    for (const nodeIndex of databaseNodeIndexes)
      databaseReadRps += topologyExecution[nodeIndex]?.readDemand ?? 0;

    if (
      cacheNodes.length > 0 &&
      cacheHitRate < 0.1 &&
      !emitted.has("cache-hit-collapse")
    )
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

    const nodeMetrics: Record<string, NodeMetricSnapshot> = {};
    const nodeUtilization: Record<string, number> = {};
    let totalMonthlyCost = 0;
    let queueDepth = 0;
    let maxQueueAgeMs = 0;
    let replicaLagMs = 0;
    let recoveryTimeSeconds = 0;
    let residencyViolations = 0;
    let frameDataLoss = 0;
    let frameDurabilityOperations = 0;
    let frameConsistencyViolations = 0;
    queueDemandByWorker.clear();
    for (const [queueId, workers] of topologyPlan.downstreamWorkers) {
      const queueIndex = runtimeNodeIndexById.get(queueId) ?? -1;
      const queueDemand = topologyExecution[queueIndex]?.demand ?? 0;
      for (const worker of workers)
        queueDemandByWorker.set(
          worker.id,
          (queueDemandByWorker.get(worker.id) ?? 0) + queueDemand,
        );
    }

    for (
      let nodeIndex = 0;
      nodeIndex < architecture.nodes.length;
      nodeIndex += 1
    ) {
      const node = architecture.nodes[nodeIndex]!;
      const state = runtimeStates[nodeIndex]!;
      if (state.pendingInstances > 0 && second >= state.pendingReadyAt) {
        state.activeInstances = Math.min(
          node.config.maxInstances,
          state.activeInstances + state.pendingInstances,
        );
        state.pendingInstances = 0;
        state.pendingReadyAt = Number.POSITIVE_INFINITY;
      }
      const behavior = node.config.behavior;
      const stateOwning = componentOwnsState(node.kind);
      const replicationMode = stateOwning
        ? (behavior?.storage?.replicationMode ??
          (node.config.replicas > 0 ? "async" : "none"))
        : "none";
      let nodeReplicaLagMs = 0;
      const nodeExecution = topologyExecution[nodeIndex]!;
      const edgeProfile = nodeExecution.edgeProfile;
      const demand = nodeExecution.demand;
      const nodeReadRps = Math.min(demand, nodeExecution.readDemand);
      const nodeWriteRps = Math.max(0, demand - nodeReadRps);
      const nodePayloadKb =
        demand > 0 ? nodeExecution.payloadDemandKb / demand : profile.payloadKb;
      const nodeComputeMs =
        demand > 0 ? nodeExecution.computeDemandMs / demand : profile.computeMs;
      const nodeCriticalShare =
        demand > 0
          ? clamp(nodeExecution.criticalDemand / demand, 0, 1)
          : profile.criticalShare;
      const edgeLatencyMs =
        edgeProfile.baseLatencyMs +
        edgeProfile.jitterMs * random.between(0.2, 1);
      const relevant = activeIncidentsByNodeIndex[nodeIndex] ?? [];
      const databaseToggle = latestToggle(
        node,
        "database-degradation",
        "database-recovery",
      );
      const multiRegion =
        behavior?.topology?.failureDomain?.toLowerCase() === "multi-region";
      const forwardingFactor = nodeForwardingFactors[nodeIndex] ?? 1;
      const offline = forwardingFactor <= 0;
      let capacityMultiplier =
        databaseToggle?.kind === "database-degradation"
          ? 1 / databaseToggle.magnitude
          : 1;
      capacityMultiplier *= forwardingFactor;
      for (const incident of relevant) {
        if (incident.kind !== "node-failure") continue;
        recoveryTimeSeconds = Math.max(
          recoveryTimeSeconds,
          stateOwning && node.config.replicas > 0
            ? effectiveFailoverSeconds(incident, node, 20)
            : modeledIncidentDurationSeconds(
                incident,
                scenario.workload.durationSeconds,
              ),
        );
      }
      for (const incident of relevant) {
        if (incident.kind !== "zone-outage") continue;
        recoveryTimeSeconds = Math.max(
          recoveryTimeSeconds,
          stateOwning && node.config.replicas > 0
            ? effectiveFailoverSeconds(incident, node, 30)
            : modeledIncidentDurationSeconds(
                incident,
                scenario.workload.durationSeconds,
              ),
        );
      }
      for (const incident of relevant) {
        if (incident.kind !== "region-outage") continue;
        recoveryTimeSeconds = Math.max(
          recoveryTimeSeconds,
          stateOwning && multiRegion
            ? effectiveFailoverSeconds(incident, node, 60)
            : modeledIncidentDurationSeconds(
                incident,
                scenario.workload.durationSeconds,
              ),
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
          recoveryTimeSeconds = Math.max(
            recoveryTimeSeconds,
            stateOwning && node.config.replicas > 0
              ? effectiveFailoverSeconds(incident, node, 8)
              : modeledIncidentDurationSeconds(
                  incident,
                  scenario.workload.durationSeconds,
                ),
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
        if (
          incident.kind === "replication-lag" &&
          node.config.replicas > 0 &&
          replicationMode !== "none"
        )
          nodeReplicaLagMs = Math.max(
            nodeReplicaLagMs,
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
        Math.max(node.config.baseLatencyMs, nodeComputeMs);
      const concurrencyCapacity =
        (behavior?.compute?.concurrencyPerInstance ??
          node.config.maxConnections) * state.activeInstances;
      const requestConcurrency = (demand * serviceTimeMs) / 1_000;
      const persistentConnections = USER_CONCURRENCY_KINDS.has(node.kind)
        ? Math.min(
            (scenario.workload.concurrentUsers ?? 0) *
              clamp(
                nodeExecution.synchronousAttemptedDemand /
                  Math.max(1, requestedRps),
                0,
                1,
              ),
            (demand * (scenario.workload.clientTimeoutMs ?? 1_000)) / 1_000,
          )
        : 0;
      const connectionUtilization =
        Math.max(requestConcurrency, persistentConnections) /
        Math.max(1, concurrencyCapacity);
      const cpuCores = behavior?.compute?.cpuCores ?? 4;
      const cpuUtilization =
        throughputUtilization *
        (1 + nodeComputeMs / Math.max(1, cpuCores * 20));
      const memoryGb = behavior?.compute?.memoryGb ?? 8;
      const memoryUtilization = clamp(
        0.28 + state.memoryLeakMb / Math.max(1, memoryGb * 1_024),
        0,
        1.99,
      );
      const bandwidthMbps = behavior?.network?.bandwidthMbps ?? 10_000;
      const nodeNetworkUtilization =
        (demand * nodePayloadKb * payloadMultiplier * 8) /
        1_000 /
        Math.max(1, bandwidthMbps * state.activeInstances);
      const edgeNetworkUtilization = edgeProfile.networkUtilization;
      const networkUtilization = Math.max(
        nodeNetworkUtilization,
        edgeNetworkUtilization,
      );
      let iopsUtilization = 0;
      if (
        node.kind === "database" ||
        node.kind === "object-store" ||
        node.kind === "queue" ||
        node.kind === "stream"
      ) {
        const durableLog = node.kind === "queue" || node.kind === "stream";
        const reads = durableLog ? demand : nodeReadRps;
        const writes = durableLog ? demand : nodeWriteRps;
        const physicalReads =
          reads *
          (durableLog ? 1 : 1 - (behavior?.storage?.bufferHitRate ?? 0));
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
          (demand * nodePayloadKb * payloadMultiplier * 8) /
          1_000 /
          Math.max(1, diskThroughputMbps * state.activeInstances);
        iopsUtilization = Math.max(operationUtilization, diskUtilization);
      }
      let componentQueueDepth = 0;
      let componentQueueAge = 0;
      if (node.kind === "queue" || node.kind === "stream") {
        const delivery = behavior?.messaging?.delivery ?? "at-least-once";
        const deliveredEnqueueDemand = nodeExecution.deliveredTransportDemand;
        const attemptedDurabilityDemand = Math.max(
          demand,
          deliveredEnqueueDemand,
        );
        const rejectedEnqueueDemand = Math.max(
          0,
          deliveredEnqueueDemand - demand,
        );
        frameDurabilityOperations += attemptedDurabilityDemand;
        if (
          delivery === "at-most-once" ||
          node.config.replicas === 0 ||
          replicationMode === "none"
        )
          frameDataLoss += rejectedEnqueueDemand;
        const consumers = topologyPlan.downstreamWorkers.get(node.id) ?? [];
        const consumerInstances = consumers.reduce((total, consumer) => {
          const consumerIndex = runtimeNodeIndexById.get(consumer.id) ?? -1;
          return total + (runtimeStates[consumerIndex]?.activeInstances ?? 0);
        }, 0);
        const consumerCapacity = consumers.reduce((total, consumer) => {
          const consumerIndex = runtimeNodeIndexById.get(consumer.id) ?? -1;
          const consumerState = runtimeStates[consumerIndex]!;
          const consumerForwardingFactor =
            consumerIndex >= 0
              ? (nodeForwardingFactors[consumerIndex] ?? 1)
              : 0;
          const sharedDemand = queueDemandByWorker.get(consumer.id) ?? demand;
          const capacityShare =
            sharedDemand > 0 ? clamp(demand / sharedDemand, 0, 1) : 0;
          const slowdown = (activeIncidentsByNodeIndex[consumerIndex] ?? [])
            .filter((incident) => incident.kind === "queue-consumer-slowdown")
            .reduce((factor, incident) => factor / incident.magnitude, 1);
          return (
            total +
            consumer.config.capacityRps *
              consumerState.activeInstances *
              consumerForwardingFactor *
              slowdown *
              capacityShare
          );
        }, 0);
        const partitions = behavior?.messaging?.partitions ?? 1;
        const partitionParallelism = Math.min(
          1,
          partitions / Math.max(1, consumerInstances),
        );
        const batchSize = behavior?.messaging?.batchSize ?? 1;
        const batchEfficiency = 1 + Math.log2(batchSize) * 0.06;
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
            forwardingFactor *
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
        : clamp(
            overload ** 2 * 0.34 +
              packetLoss +
              errorBonus +
              (1 - forwardingFactor),
            0,
            0.98,
          );
      if (!offline && utilization > loadSheddingThreshold)
        nodeErrorRate = Math.min(0.98, nodeErrorRate + 0.04);
      if (!offline && circuitBreaker && node.kind === "third-party")
        nodeErrorRate *= 0.45;
      const timeoutMs =
        behavior?.resilience?.timeoutMs ??
        scenario.workload.clientTimeoutMs ??
        120_000;
      if (!offline && latencyMs > timeoutMs)
        nodeErrorRate = clamp(
          nodeErrorRate + (latencyMs - timeoutMs) / Math.max(1, latencyMs),
          0,
          0.98,
        );
      if (!offline && bulkhead && nodeErrorRate > 0) nodeErrorRate *= 0.72;

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

      if (node.kind === "database" || node.kind === "object-store") {
        const baseLag =
          behavior?.storage?.replicationLagMs ??
          (replicationMode === "sync" || replicationMode === "quorum" ? 8 : 90);
        const lag =
          baseLag *
          (1 + Math.max(0, iopsUtilization - 0.6) * 8) *
          (replicationMode === "none" ? 0 : 1);
        nodeReplicaLagMs = Math.max(nodeReplicaLagMs, lag);
        if (
          node.kind === "database" &&
          node.config.consistency === "eventual"
        ) {
          const tolerance =
            (scenario.domain?.staleReadToleranceSeconds ?? 0.25) * 1_000;
          if (nodeReplicaLagMs > tolerance)
            frameConsistencyViolations += Math.floor(
              ((nodeReplicaLagMs - tolerance) / Math.max(1, tolerance)) *
                nodeWriteRps *
                0.000_15,
            );
        }
        if (node.kind === "database" || node.kind === "object-store") {
          const attemptedWriteRps = Math.max(
            nodeWriteRps,
            nodeExecution.deliveredWriteDemand,
          );
          frameDurabilityOperations += attemptedWriteRps;
          const noDurableReplica =
            node.config.replicas === 0 || replicationMode === "none";
          if (noDurableReplica && (offline || utilization > 1.35))
            frameDataLoss += attemptedWriteRps * nodeErrorRate * 0.004;
        }
        const requiredResidency = scenario.domain?.piiRegion;
        const actualResidency = behavior?.topology?.dataResidency;
        if (
          requiredResidency &&
          actualResidency &&
          requiredResidency !== actualResidency
        )
          residencyViolations += Math.ceil(nodeWriteRps * nodeCriticalShare);
      }
      if (offline) {
        for (const incident of relevant) {
          if (
            incident.kind === "node-failure" ||
            incident.kind === "zone-outage" ||
            incident.kind === "region-outage" ||
            incident.kind === "leader-election"
          )
            continue;
          recoveryTimeSeconds = Math.max(
            recoveryTimeSeconds,
            modeledIncidentDurationSeconds(
              incident,
              scenario.workload.durationSeconds,
            ),
          );
        }
      }
      replicaLagMs = Math.max(replicaLagMs, nodeReplicaLagMs);
      if (
        (node.kind === "queue" || node.kind === "stream") &&
        behavior?.messaging?.delivery === "at-most-once"
      )
        frameDataLoss += demand * nodeErrorRate * 0.002;

      const egressCost =
        ((demand * nodePayloadKb * payloadMultiplier * 2_592_000) / 1_000_000) *
        (behavior?.network?.egressCostPerGb ?? 0);
      totalMonthlyCost +=
        node.config.monthlyCostEur *
          (stateOwning
            ? Math.max(state.activeInstances, node.config.replicas + 1)
            : state.activeInstances) +
        egressCost;
      const nodeMetric: NodeMetricSnapshot = {
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
        replicaLagMs: rounded(nodeReplicaLagMs),
        activeInstances: state.activeInstances,
        latencyMs: rounded(latencyMs),
        errorRate: rounded(nodeErrorRate * 100, 4),
        state: stateForUtilization(utilization, offline, nodeErrorRate),
      };
      nodeMetrics[node.id] = nodeMetric;
      nodeMetricsByIndex[nodeIndex] = nodeMetric;
      nodeUtilization[node.id] = nodeMetric.utilization;
      maxUtilizationByNode[nodeIndex] = Math.max(
        maxUtilizationByNode[nodeIndex] ?? 0,
        nodeMetric.utilization,
      );

      const saturationEventId = `saturation-${node.id}`;
      if (utilization > 1 && !emitted.has(saturationEventId)) {
        const parent = events
          .filter(
            (event) =>
              event.second <= second &&
              (event.entityId === node.id || event.kind.startsWith("cache")),
          )
          .slice(-1)
          .map((event) => event.id);
        emit({
          id: saturationEventId,
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
        emitted.has("cache-hit-collapse") &&
        !emitted.has(`cache-cascade-${node.id}`)
      )
        emit({
          id: `cache-cascade-${node.id}`,
          second,
          kind: "cache-cascade",
          severity: "critical",
          title: `${node.name} is saturated during the cache miss surge`,
          detail: `During the modeled cache collapse, ${node.name} reached ${rounded(utilization * 100)}% modeled utilization with ${Math.round(databaseReadRps)} reads/s of durable-store demand.`,
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
      if (connectionUtilization > 1 && !emitted.has(`connections-${node.id}`))
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
      if (iopsUtilization > 1 && !emitted.has(`iops-${node.id}`))
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

    let baseErrorRate = 0;
    let synchronousPathLatencyMs = 0;
    for (
      let requestRuntimeIndex = 0;
      requestRuntimeIndex < requestClassRuntimes.length;
      requestRuntimeIndex += 1
    ) {
      const requestRuntime = requestClassRuntimes[requestRuntimeIndex]!;
      if (requestRuntime.plan.share <= 0) continue;
      requestRuntime.outcomeSuccess.fill(1);
      requestRuntime.outcomeLatencyMs.fill(0);
      for (
        let orderIndex = topologyPlan.executionOrderIndexes.length - 1;
        orderIndex >= 0;
        orderIndex -= 1
      ) {
        const nodeIndex = topologyPlan.executionOrderIndexes[orderIndex]!;
        const node = architecture.nodes[nodeIndex];
        if (!node) continue;
        const metric = nodeMetricsByIndex[nodeIndex];
        const ownSuccess = clamp(1 - (metric?.errorRate ?? 0) / 100, 0, 1);
        const ownLatencyMs = metric?.latencyMs ?? 0;
        if (node.id === requestRuntime.plan.terminalNodeId) {
          requestRuntime.outcomeSuccess[nodeIndex] = ownSuccess;
          requestRuntime.outcomeLatencyMs[nodeIndex] = ownLatencyMs;
          continue;
        }

        const outgoing = topologyPlan.outgoingByIndex[nodeIndex] ?? [];
        let branchCount = 0;
        let partitioned = requestRuntime.plan.fixedRoute;
        if (!partitioned) {
          partitioned = true;
          for (
            let outgoingIndex = 0;
            outgoingIndex < outgoing.length;
            outgoingIndex += 1
          ) {
            const { edge, edgeIndex } = outgoing[outgoingIndex]!;
            const model = requestRuntime.edgeModels[edgeIndex];
            if (!model || model.trafficShare <= 0) continue;
            branchCount += 1;
            if (edge.config?.trafficShare === undefined) partitioned = false;
          }
        } else {
          for (
            let outgoingIndex = 0;
            outgoingIndex < outgoing.length;
            outgoingIndex += 1
          ) {
            const { edgeIndex } = outgoing[outgoingIndex]!;
            const model = requestRuntime.edgeModels[edgeIndex];
            if (model && model.trafficShare > 0) branchCount += 1;
          }
        }
        if (branchCount === 0) {
          requestRuntime.outcomeSuccess[nodeIndex] = ownSuccess;
          requestRuntime.outcomeLatencyMs[nodeIndex] = ownLatencyMs;
          continue;
        }

        let downstreamSuccess = partitioned ? 0 : 1;
        let downstreamLatencyMs = 0;
        for (
          let outgoingIndex = 0;
          outgoingIndex < outgoing.length;
          outgoingIndex += 1
        ) {
          const { edgeIndex, targetIndex } = outgoing[outgoingIndex]!;
          const model = requestRuntime.edgeModels[edgeIndex];
          if (!model || model.trafficShare <= 0) continue;
          let exposure = 0;
          if (!model.asynchronous) {
            const branchCacheHitRate =
              requestRuntime.edgeCacheHitRates[edgeIndex] ?? 0;
            const localFactor = Math.max(
              0,
              model.localBase -
                model.localCacheCoefficient * branchCacheHitRate,
            );
            const forwardedFactor = Math.max(
              0,
              model.forwardBase -
                model.forwardCacheCoefficient * branchCacheHitRate,
            );
            const cacheHasSynchronousDescendant =
              model.cacheTarget &&
              (topologyPlan.outgoingByIndex[targetIndex] ?? []).some(
                ({ edgeIndex: descendantEdgeIndex }) => {
                  const descendantModel =
                    requestRuntime.edgeModels[descendantEdgeIndex];
                  return Boolean(
                    descendantModel &&
                    !descendantModel.asynchronous &&
                    descendantModel.trafficShare > 0,
                  );
                },
              );
            exposure = requestRuntime.plan.fixedRoute
              ? 1
              : model.cacheTarget
                ? cacheHasSynchronousDescendant
                  ? requestRuntime.plan.profile.readRatio
                  : requestRuntime.plan.profile.readRatio *
                    requestRuntime.plan.profile.cacheableShare *
                    branchCacheHitRate *
                    (requestRuntime.plan.cacheBranchCoverageByIndex[
                      nodeIndex
                    ] ?? 0)
                : Math.max(localFactor, forwardedFactor);
            exposure = clamp(exposure, 0, 1);
          }
          const targetSuccess = requestRuntime.outcomeSuccess[targetIndex] ?? 1;
          const targetLatencyMs =
            requestRuntime.outcomeLatencyMs[targetIndex] ?? 0;
          const branchSuccess = 1 - exposure + exposure * targetSuccess;
          if (partitioned) {
            downstreamSuccess += model.trafficShare * branchSuccess;
            downstreamLatencyMs +=
              model.trafficShare * exposure * targetLatencyMs;
          } else {
            downstreamSuccess *= branchSuccess;
            downstreamLatencyMs = Math.max(
              downstreamLatencyMs,
              exposure * targetLatencyMs,
            );
          }
        }
        if (node.kind === "cache") {
          const synchronousAttempted =
            requestRuntime.nodeSynchronousAttemptedDemand[nodeIndex] ?? 0;
          const missShare = clamp(
            (requestRuntime.synchronousForwardDemand[nodeIndex] ?? 0) /
              Math.max(1, synchronousAttempted),
            0,
            1,
          );
          downstreamSuccess = 1 - missShare + missShare * downstreamSuccess;
          downstreamLatencyMs *= missShare;
        }
        requestRuntime.outcomeSuccess[nodeIndex] = clamp(
          ownSuccess * downstreamSuccess,
          0,
          1,
        );
        requestRuntime.outcomeLatencyMs[nodeIndex] =
          ownLatencyMs + downstreamLatencyMs;
      }

      let classSuccess = 0;
      let classLatencyMs = 0;
      for (
        let entryOffset = 0;
        entryOffset < requestRuntime.plan.entryIndexes.length;
        entryOffset += 1
      ) {
        const entryIndex = requestRuntime.plan.entryIndexes[entryOffset]!;
        const weight = requestRuntime.plan.entryWeights[entryOffset] ?? 0;
        classSuccess +=
          weight * (requestRuntime.outcomeSuccess[entryIndex] ?? 1);
        classLatencyMs +=
          weight * (requestRuntime.outcomeLatencyMs[entryIndex] ?? 0);
      }
      baseErrorRate +=
        requestRuntime.plan.share * clamp(1 - classSuccess, 0, 1);
      synchronousPathLatencyMs += requestRuntime.plan.share * classLatencyMs;
    }
    baseErrorRate = clamp(baseErrorRate, 0, 1);
    const p50LatencyMs = regionalLatency + synchronousPathLatencyMs * 0.72;
    const provisionalP95LatencyMs =
      p50LatencyMs * (1.55 + Math.max(0, baseErrorRate - 0.01) * 3) +
      maxQueueAgeMs * 0.16;
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
    const errorRate = clamp(baseErrorRate + timeoutErrorRate, 0, 1);
    const p95LatencyMs =
      p50LatencyMs * (1.55 + Math.max(0, errorRate - 0.01) * 3) +
      maxQueueAgeMs * 0.16;
    const p99LatencyMs =
      p95LatencyMs * (1.42 + errorRate * 2.8) + replicaLagMs * 0.05;
    let clientRetryPressure = clientRetryPolicy.retryOnTimeout
      ? Math.max(errorRate, timeoutErrorRate) *
        clientRetryPolicy.maxRetries *
        0.68
      : 0;
    let circuitBreakerCoverage = 0;
    let loadSheddingCoverage = 0;
    let bulkheadCoverage = 0;
    for (
      let requestRuntimeIndex = 0;
      requestRuntimeIndex < requestClassRuntimes.length;
      requestRuntimeIndex += 1
    ) {
      const requestRuntime = requestClassRuntimes[requestRuntimeIndex]!;
      let usesCircuitBreaker = false;
      let usesLoadShedding = false;
      let usesBulkhead = false;
      for (
        let nodeIndex = 0;
        nodeIndex < architecture.nodes.length;
        nodeIndex += 1
      ) {
        const node = architecture.nodes[nodeIndex]!;
        if (
          (node.kind !== "api" && node.kind !== "load-balancer") ||
          (requestRuntime.nodeSynchronousAttemptedDemand[nodeIndex] ?? 0) <= 0
        )
          continue;
        const resilience = node.config.behavior?.resilience;
        usesCircuitBreaker ||= resilience?.circuitBreaker === true;
        usesLoadShedding ||= resilience?.loadSheddingThreshold !== undefined;
        usesBulkhead ||= resilience?.bulkhead === true;
      }
      const share = requestRuntime.plan.share;
      if (usesCircuitBreaker) circuitBreakerCoverage += share;
      if (usesLoadShedding) loadSheddingCoverage += share;
      if (usesBulkhead) bulkheadCoverage += share;
    }
    circuitBreakerCoverage = clamp(circuitBreakerCoverage, 0, 1);
    loadSheddingCoverage = clamp(loadSheddingCoverage, 0, 1);
    bulkheadCoverage = clamp(bulkheadCoverage, 0, 1);
    if (clientRetryPolicy.jitter) clientRetryPressure *= 0.78;
    if (clientRetryPolicy.backoffBaseMs >= 100) clientRetryPressure *= 0.78;
    clientRetryPressure *= 1 - circuitBreakerCoverage * (1 - 0.52);
    clientRetryPressure *= 1 - loadSheddingCoverage * (1 - 0.62);
    clientRetryPressure *= 1 - bulkheadCoverage * (1 - 0.72);
    let scheduledRetryStorm = 0;
    for (const incident of activeIncidents) {
      if (incident.kind === "retry-storm")
        scheduledRetryStorm += incident.magnitude * 0.08;
    }
    if (scheduledRetryStorm > 0)
      clientRetryPressure = (clientRetryPressure + scheduledRetryStorm) * 1.8;
    clientRetryAmplification = 1 + clamp(clientRetryPressure, 0, 2.8);

    let dependencyRetryRps = 0;
    for (
      let dependencyIndex = 0;
      dependencyIndex < dependencyRetryEdgeIndexes.length;
      dependencyIndex += 1
    ) {
      const edgeIndex = dependencyRetryEdgeIndexes[dependencyIndex]!;
      const targetMetric =
        nodeMetricsByIndex[dependencyRetryTargetIndexes[dependencyIndex]!];
      for (
        let requestRuntimeIndex = 0;
        requestRuntimeIndex < requestClassRuntimes.length;
        requestRuntimeIndex += 1
      ) {
        const requestRuntime = requestClassRuntimes[requestRuntimeIndex]!;
        const attemptedRps = requestRuntime.edgeAttemptedRps[edgeIndex] ?? 0;
        const retryPressureFactor =
          requestRuntime.edgeModels[edgeIndex]?.retryPressureFactor ?? 0;
        if (!targetMetric || attemptedRps <= 0 || retryPressureFactor <= 0) {
          requestRuntime.edgeRetryDemand[edgeIndex] = 0;
          requestRuntime.edgeSynchronousRetryDemand[edgeIndex] = 0;
          continue;
        }
        const branchRetryPressure =
          (targetMetric.errorRate / 100) * retryPressureFactor;
        const priorRetryRps = requestRuntime.edgeRetryDemand[edgeIndex] ?? 0;
        const unconstrainedRetryRps =
          Math.max(0, attemptedRps - priorRetryRps) *
          clamp(branchRetryPressure, 0, 2.8);
        const sourceMaxRetries =
          dependencyRetryMaxRetries[dependencyIndex] ?? 0;
        const retryBudgetRps =
          requestedRps *
          requestRuntime.plan.share *
          sourceMaxRetries *
          MAX_TOPOLOGY_FANOUT_AMPLIFICATION;
        const nextRetryRps = Math.min(unconstrainedRetryRps, retryBudgetRps);
        const synchronousShare = clamp(
          (requestRuntime.edgeSynchronousAttemptedRps[edgeIndex] ?? 0) /
            Math.max(1, attemptedRps),
          0,
          1,
        );
        requestRuntime.edgeRetryDemand[edgeIndex] = nextRetryRps;
        requestRuntime.edgeSynchronousRetryDemand[edgeIndex] =
          requestRuntime.edgeModels[edgeIndex]?.asynchronous === true
            ? 0
            : nextRetryRps * synchronousShare;
        dependencyRetryRps += nextRetryRps;
      }
    }
    const retryAmplification =
      1 +
      clamp(
        clientRetryAmplification -
          1 +
          dependencyRetryRps / Math.max(1, requestedRps),
        0,
        2.8,
      );
    if (traceSampleSeconds.has(second) && traces.length < MAX_SAMPLED_TRACES) {
      const perSampleLimit = Math.max(
        1,
        Math.floor(MAX_SAMPLED_TRACES / traceSampleSeconds.size),
      );
      let sampledThisSecond = 0;
      for (const requestRuntime of requestClassRuntimes) {
        if (
          !requestRuntime.plan.traced ||
          sampledThisSecond >= perSampleLimit ||
          traces.length >= MAX_SAMPLED_TRACES
        )
          continue;
        traces.push(
          sampledTraceForRequestClass(
            scenario,
            architecture,
            requestRuntime,
            nodeMetrics,
            second,
          ),
        );
        sampledThisSecond += 1;
      }
    }
    if (retryAmplification > 1.2 && !emitted.has("retry-amplification"))
      emit({
        id: "retry-amplification",
        second,
        kind: "retry-storm",
        severity: "critical",
        title: "Retry amplification detected",
        detail: `Modeled client and dependency retries are generating ${rounded(retryAmplification)}x effective traffic after failures.`,
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
    if (
      queueDepth > 0 &&
      maxQueueAgeMs > 1_000 &&
      !emitted.has("queue-backlog-growth")
    )
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
    cumulativeDurabilityOperations += frameDurabilityOperations;
    const durabilityPercent =
      cumulativeDurabilityOperations === 0
        ? cumulativeLoss > 0
          ? 0
          : 100
        : clamp(
            100 * (1 - cumulativeLoss / cumulativeDurabilityOperations),
            0,
            100,
          );
    const throughputRps = requestedRps * (1 - errorRate);
    const edgeMetrics: Record<string, EdgeMetricSnapshot> = {};
    for (
      let edgeIndex = 0;
      edgeIndex < architecture.edges.length;
      edgeIndex += 1
    ) {
      const edge = architecture.edges[edgeIndex]!;
      const metric = topologyEdgeExecution[edgeIndex];
      if (!metric) continue;
      edgeMetrics[edge.id] = {
        attemptedRps: rounded(metric.attemptedRps),
        throughputRps: rounded(metric.throughputRps),
        retryRps: rounded(metric.retryRps),
        lostRps: rounded(metric.lostRps),
        packetLossPercent: rounded(
          metric.attemptedRps > 0
            ? (metric.transportLostRps / metric.attemptedRps) * 100
            : 0,
          4,
        ),
        latencyMs: rounded(metric.latencyMs),
        asynchronous: edge.config?.asynchronous === true,
      };
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
      monthlyCostEur: rounded(totalMonthlyCost),
      dataLoss: rounded(frameDataLoss),
      consistencyViolations: frameConsistencyViolations,
      durabilityPercent: rounded(durabilityPercent, 6),
      replicaLagMs: rounded(replicaLagMs),
      maxQueueAgeMs: rounded(maxQueueAgeMs),
      recoveryTimeSeconds: rounded(recoveryTimeSeconds),
      residencyViolations,
      operationalComplexity: complexity,
      nodeUtilization,
      nodeMetrics,
      edgeMetrics,
    });
  }

  const requirements = evaluateRequirements(scenario, frames);
  const utilizationByNode = new Map(
    architecture.nodes.map((node, nodeIndex) => [
      node.id,
      maxUtilizationByNode[nodeIndex] ?? 0,
    ]),
  );
  const bottleneckNode = architecture.nodes
    .filter(
      (node) =>
        reachable.has(node.id) &&
        node.kind !== "users" &&
        node.kind !== "region",
    )
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
    else
      strengths.push(
        "The model recorded no acknowledged-write loss during this run.",
      );
  }
  if (scenario.domain?.preventOversell) {
    if (totalConsistencyViolations > 0)
      risks.push(
        `The no-oversell invariant encountered ${totalConsistencyViolations} modeled consistency violations.`,
      );
    else
      strengths.push(
        "The model recorded no consistency violations against the no-oversell invariant.",
      );
  }
  if (scenario.domain?.maximumRecoverySeconds !== undefined) {
    if (maximumRecovery > scenario.domain.maximumRecoverySeconds)
      risks.push(
        `Recovery reached ${rounded(maximumRecovery)}s against the ${scenario.domain.maximumRecoverySeconds}s domain limit.`,
      );
    else
      strengths.push(
        `Modeled recovery stayed within the ${scenario.domain.maximumRecoverySeconds}s domain limit.`,
      );
  }
  if (
    architecture.nodes.some(
      (node) => reachable.has(node.id) && node.config.autoscale,
    )
  )
    strengths.push("Elastic compute responds to modeled utilization.");
  if (
    architecture.nodes.some(
      (node) =>
        reachable.has(node.id) &&
        node.config.behavior?.resilience?.circuitBreaker &&
        node.config.behavior?.resilience?.loadSheddingThreshold,
    )
  )
    strengths.push(
      "The model applies circuit breaking and load shedding to cascading load.",
    );
  for (const node of architecture.nodes) {
    const modeledService =
      reachable.has(node.id) && node.kind !== "users" && node.kind !== "region";
    const multiRegion =
      node.config.behavior?.topology?.failureDomain?.toLowerCase() ===
      "multi-region";
    if (modeledService && !componentOwnsState(node.kind)) {
      if (node.config.instances < 2)
        risks.push(`${node.name} remains a single instance failure domain.`);
      else if (!multiRegion)
        risks.push(
          `${node.name} keeps its service instances inside one regional failure domain.`,
        );
    } else if (modeledService) {
      if (node.config.replicas === 0)
        risks.push(`${node.name} remains a single node failure domain.`);
      else if (node.config.behavior?.topology?.zone !== "multi-az")
        risks.push(
          `${node.name} keeps its replicas inside one availability-zone failure domain.`,
        );
      else if (!multiRegion)
        risks.push(
          `${node.name} keeps its retained state inside one regional failure domain.`,
        );
    }
    if (
      node.config.behavior?.resilience?.maxRetries &&
      !node.config.behavior?.resilience?.jitter
    )
      risks.push(
        `${node.name} retries without jitter and can synchronize load.`,
      );
    if (
      componentUsesReadConsistency(node.kind) &&
      node.config.consistency === "strong" &&
      scenario.workload.regions.length > 1
    )
      tradeoffs.push(
        `${node.name} avoids modeled stale-read violations; this engine does not assign a separate coordination-latency premium to strong consistency.`,
      );
    if (
      componentUsesReadConsistency(node.kind) &&
      node.config.consistency === "eventual"
    )
      tradeoffs.push(
        `${node.name} may violate the stale-read tolerance when modeled replica lag is too high; this engine does not assign eventual consistency a latency benefit.`,
      );
    if (componentOwnsState(node.kind) && node.config.replicas > 0) {
      const copiesIncreaseCost =
        node.config.replicas + 1 > node.config.instances;
      tradeoffs.push(
        `${node.name} adds modeled failure tolerance and replication complexity${copiesIncreaseCost ? " with additional billable copies" : " within its existing billable instance count"}.`,
      );
    }
  }
  if (risks.length === 0)
    risks.push(
      "No structural single point of failure was detected in the modeled primitives.",
    );
  if (tradeoffs.length === 0)
    tradeoffs.push(
      "The architecture has not made its resilience, cost and recovery trade-offs explicit yet.",
    );

  return {
    engineVersion: ENGINE_VERSION,
    inputFingerprint,
    seed: scenario.seed,
    behavioralProfiles,
    frames,
    events,
    generatedIncidents,
    ...(traces.length > 0 ? { traces } : {}),
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
