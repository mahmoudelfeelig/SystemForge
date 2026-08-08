import type {
  Architecture,
  ArchitectureNode,
  RequirementResult,
  Scenario,
  SimulationResult,
} from "@systemforge/contracts";
import { ENGINE_VERSION, simulate } from "./simulate";

export const SOLVER_VERSION = "0.1.0";
export const DEFAULT_SOLVER_WORK_UNIT_BUDGET = 250_000;
export const MAX_SOLVER_CANDIDATES = 64;

export const SOLVER_STRATEGIES = [
  "horizontal-scale",
  "elastic-scale",
  "resilience-controls",
  "durable-replication",
  "storage-partitioning",
  "cache-efficiency",
  "consumer-parallelism",
] as const;

export type SolverStrategy = (typeof SOLVER_STRATEGIES)[number];

export interface SolverWeights {
  requirements: number;
  resilience: number;
  latency: number;
  cost: number;
  complexity: number;
}

export interface SolveArchitectureOptions {
  maxCandidates?: number;
  maxChangesPerCandidate?: 1 | 2;
  workUnitBudget?: number;
  allowedStrategies?: SolverStrategy[];
  lockedNodeIds?: string[];
  includeHiddenRequirements?: boolean;
  maximumMonthlyCostEur?: number;
  maximumOperationalComplexity?: number;
  weights?: Partial<SolverWeights>;
}

export interface SolverMetrics {
  requirementsPassed: number;
  requirementsTotal: number;
  requirementFitness: number;
  resilienceFitness: number;
  p95LatencyMs: number;
  availability: number;
  errorRate: number;
  monthlyCostEur: number;
  dataLoss: number;
  durabilityPercent: number;
  recoveryTimeSeconds: number;
  operationalComplexity: number;
}

export interface SolverMetricDeltas {
  requirementsPassed: number;
  requirementFitness: number;
  resilienceFitness: number;
  p95LatencyMs: number;
  availability: number;
  monthlyCostEur: number;
  dataLoss: number;
  operationalComplexity: number;
}

export interface SolverEvaluation {
  metrics: SolverMetrics;
  requirements: RequirementResult[];
  analysis: SimulationResult["analysis"];
}

export interface SolverChange {
  strategy: SolverStrategy;
  nodeIds: string[];
  title: string;
  detail: string;
}

export interface SolverCandidate {
  id: string;
  rank: number;
  label: string;
  architecture: Architecture;
  changes: SolverChange[];
  evaluation: SolverEvaluation;
  deltas: SolverMetricDeltas;
  score: number;
  paretoOptimal: boolean;
  dominatedByBaseline: boolean;
  eligible: boolean;
  constraintViolations: string[];
  improvements: string[];
  tradeoffs: string[];
}

export interface SolveArchitectureResult {
  engineVersion: string;
  solverVersion: string;
  baseline: SolverEvaluation & {
    score: number;
    eligible: boolean;
    constraintViolations: string[];
  };
  candidates: SolverCandidate[];
  paretoFrontierIds: string[];
  recommendedCandidateId?: string;
  exploredCandidates: number;
  generatedCandidates: number;
  truncated: boolean;
  excludedHiddenRequirementCount: number;
  workUnits: number;
  options: {
    maxCandidates: number;
    maxChangesPerCandidate: 1 | 2;
    workUnitBudget: number;
    allowedStrategies: SolverStrategy[];
    lockedNodeIds: string[];
    includeHiddenRequirements: boolean;
    maximumMonthlyCostEur?: number;
    maximumOperationalComplexity?: number;
    weights: SolverWeights;
  };
}

interface Mutation {
  change: SolverChange;
  apply: (architecture: Architecture) => void;
}

interface InternalCandidate {
  id: string;
  label: string;
  architecture: Architecture;
  changes: SolverChange[];
  evaluation: SolverEvaluation;
  constraintViolations: string[];
  eligible: boolean;
  utility: number;
  paretoOptimal: boolean;
  dominatedByBaseline: boolean;
}

const DEFAULT_WEIGHTS: SolverWeights = {
  requirements: 0.48,
  resilience: 0.2,
  latency: 0.12,
  cost: 0.12,
  complexity: 0.08,
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const rounded = (value: number, digits = 4): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const average = (values: number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;

const maximum = (values: number[]): number =>
  values.length === 0 ? 0 : Math.max(...values);

const minimum = (values: number[]): number =>
  values.length === 0 ? 0 : Math.min(...values);

const requirementFitness = (requirements: RequirementResult[]): number => {
  if (requirements.length === 0) return 1;
  return average(
    requirements.map(({ requirement, actual, passed }) => {
      if (passed) return 1;
      const target = requirement.target;
      if (requirement.operator === "lte") {
        if (target === 0) return 1 / (1 + Math.abs(actual));
        return clamp(target / Math.max(Math.abs(actual), 0.000_001), 0, 1);
      }
      if (requirement.operator === "gte") {
        if (target === 0) return actual >= 0 ? 1 : 0;
        return clamp(actual / target, 0, 1);
      }
      const scale = Math.max(1, Math.abs(target));
      return 1 / (1 + Math.abs(actual - target) / scale);
    }),
  );
};

const summarize = (result: SimulationResult): SolverEvaluation => {
  const dataLoss = result.frames.reduce(
    (total, frame) => total + frame.dataLoss,
    0,
  );
  const availability = average(
    result.frames.map((frame) => frame.availability),
  );
  const durabilityPercent = minimum(
    result.frames.map((frame) => frame.durabilityPercent),
  );
  const recoveryTimeSeconds = maximum(
    result.frames.map((frame) => frame.recoveryTimeSeconds),
  );
  const errorRate = maximum(result.frames.map((frame) => frame.errorRate));
  const resilienceFitness =
    clamp(availability / 100, 0, 1) * 0.38 +
    clamp(durabilityPercent / 100, 0, 1) * 0.24 +
    (1 / (1 + dataLoss)) * 0.16 +
    (1 / (1 + recoveryTimeSeconds / 60)) * 0.12 +
    (1 / (1 + errorRate / 10)) * 0.1;

  return {
    metrics: {
      requirementsPassed: result.score.passed,
      requirementsTotal: result.score.total,
      requirementFitness: rounded(requirementFitness(result.requirements), 6),
      resilienceFitness: rounded(resilienceFitness, 6),
      p95LatencyMs: rounded(
        maximum(result.frames.map((frame) => frame.p95LatencyMs)),
      ),
      availability: rounded(availability, 6),
      errorRate: rounded(errorRate, 6),
      monthlyCostEur: rounded(
        maximum(result.frames.map((frame) => frame.monthlyCostEur)),
      ),
      dataLoss: rounded(dataLoss),
      durabilityPercent: rounded(durabilityPercent, 6),
      recoveryTimeSeconds: rounded(recoveryTimeSeconds),
      operationalComplexity: rounded(
        maximum(result.frames.map((frame) => frame.operationalComplexity)),
      ),
    },
    requirements: result.requirements,
    analysis: result.analysis,
  };
};

const updateNode = (
  architecture: Architecture,
  nodeId: string,
  update: (node: ArchitectureNode) => void,
): void => {
  const node = architecture.nodes.find((candidate) => candidate.id === nodeId);
  if (!node)
    throw new Error(`Solver mutation referenced missing node ${nodeId}.`);
  update(node);
};

const orderedNodes = (
  architecture: Architecture,
  bottleneckNodeId?: string,
): ArchitectureNode[] =>
  architecture.nodes
    .map((node, index) => ({ node, index }))
    .sort((left, right) => {
      if (left.node.id === bottleneckNodeId) return -1;
      if (right.node.id === bottleneckNodeId) return 1;
      return left.index - right.index;
    })
    .map(({ node }) => node);

const mutationCatalog = (
  architecture: Architecture,
  bottleneckNodeId: string | undefined,
  allowedStrategies: Set<SolverStrategy>,
  lockedNodeIds: Set<string>,
): Mutation[] => {
  const mutations: Mutation[] = [];
  const nodes = orderedNodes(architecture, bottleneckNodeId);
  const canChange = (...nodeIds: string[]) =>
    nodeIds.every((nodeId) => !lockedNodeIds.has(nodeId));
  const permits = (strategy: SolverStrategy) => allowedStrategies.has(strategy);

  if (permits("horizontal-scale")) {
    const scalableKinds = new Set<ArchitectureNode["kind"]>([
      "cdn",
      "load-balancer",
      "api",
      "cache",
      "database",
      "queue",
      "stream",
      "worker",
      "object-store",
      "third-party",
    ]);
    for (const node of nodes) {
      if (!scalableKinds.has(node.kind) || !canChange(node.id)) continue;
      const nextInstances = Math.min(
        10_000,
        Math.max(
          node.config.instances + 1,
          Math.ceil(node.config.instances * 1.5),
        ),
      );
      if (nextInstances === node.config.instances) continue;
      mutations.push({
        change: {
          strategy: "horizontal-scale",
          nodeIds: [node.id],
          title: `Scale ${node.name}`,
          detail: `Raise active capacity from ${node.config.instances} to ${nextInstances} instances; modeled recurring cost rises with the active fleet.`,
        },
        apply: (candidate) =>
          updateNode(candidate, node.id, (target) => {
            target.config.instances = nextInstances;
            target.config.maxInstances = Math.max(
              target.config.maxInstances,
              nextInstances,
            );
          }),
      });
    }
  }

  if (permits("elastic-scale")) {
    const elasticKinds = new Set<ArchitectureNode["kind"]>([
      "cdn",
      "load-balancer",
      "api",
      "worker",
      "third-party",
    ]);
    for (const node of nodes) {
      if (!elasticKinds.has(node.kind) || !canChange(node.id)) continue;
      const nextMaximum = Math.min(
        10_000,
        Math.max(
          node.config.maxInstances + 1,
          Math.ceil(node.config.instances * 2),
        ),
      );
      if (node.config.autoscale && nextMaximum === node.config.maxInstances)
        continue;
      mutations.push({
        change: {
          strategy: "elastic-scale",
          nodeIds: [node.id],
          title: `Add elastic headroom to ${node.name}`,
          detail: `Enable measured-utilization scaling up to ${nextMaximum} instances with explicit startup and cooldown behavior.`,
        },
        apply: (candidate) =>
          updateNode(candidate, node.id, (target) => {
            const currentScaling = target.config.behavior?.scaling;
            target.config.autoscale = true;
            target.config.maxInstances = nextMaximum;
            target.config.behavior = {
              ...target.config.behavior,
              scaling: {
                minInstances:
                  currentScaling?.minInstances ?? target.config.instances,
                targetUtilization: currentScaling?.targetUtilization ?? 0.68,
                cooldownSeconds: currentScaling?.cooldownSeconds ?? 15,
                startupSeconds: currentScaling?.startupSeconds ?? 8,
              },
            };
          }),
      });
    }
  }

  if (permits("resilience-controls")) {
    const boundaryKinds = new Set<ArchitectureNode["kind"]>([
      "cdn",
      "load-balancer",
      "api",
      "worker",
      "third-party",
    ]);
    for (const node of nodes) {
      if (!boundaryKinds.has(node.kind) || !canChange(node.id)) continue;
      const resilience = node.config.behavior?.resilience;
      const alreadyHardened =
        resilience?.circuitBreaker === true &&
        resilience.bulkhead === true &&
        resilience.jitter === true &&
        resilience.loadSheddingThreshold !== undefined &&
        resilience.loadSheddingThreshold <= 0.9 &&
        (resilience.backoffBaseMs ?? 0) >= 120 &&
        (resilience.maxRetries ?? 0) <= 2;
      if (alreadyHardened) continue;
      mutations.push({
        change: {
          strategy: "resilience-controls",
          nodeIds: [node.id],
          title: `Harden ${node.name} failure boundaries`,
          detail:
            "Add circuit breaking, load shedding, bulkheads, bounded retries, backoff, and jitter to reduce cascading amplification.",
        },
        apply: (candidate) =>
          updateNode(candidate, node.id, (target) => {
            const current = target.config.behavior?.resilience;
            target.config.behavior = {
              ...target.config.behavior,
              resilience: {
                ...current,
                maxRetries: Math.min(current?.maxRetries ?? 2, 2),
                backoffBaseMs: Math.max(current?.backoffBaseMs ?? 0, 120),
                jitter: true,
                circuitBreaker: true,
                loadSheddingThreshold: Math.min(
                  current?.loadSheddingThreshold ?? 0.9,
                  0.9,
                ),
                bulkhead: true,
              },
            };
          }),
      });
    }
  }

  if (permits("durable-replication")) {
    const stateKinds = new Set<ArchitectureNode["kind"]>([
      "cache",
      "database",
      "queue",
      "stream",
      "object-store",
    ]);
    for (const node of nodes) {
      if (!stateKinds.has(node.kind) || !canChange(node.id)) continue;
      const storage = node.config.behavior?.storage;
      const topology = node.config.behavior?.topology;
      const alreadyDurable =
        node.config.replicas >= 2 &&
        storage?.replicationMode === "quorum" &&
        topology?.zone === "multi-az";
      if (alreadyDurable) continue;
      mutations.push({
        change: {
          strategy: "durable-replication",
          nodeIds: [node.id],
          title: `Make ${node.name} quorum durable`,
          detail:
            "Use at least two replicas, quorum replication, bounded failover, and multi-zone placement; this trades recurring cost and coordination for recovery and acknowledged-write safety.",
        },
        apply: (candidate) =>
          updateNode(candidate, node.id, (target) => {
            const behavior = target.config.behavior;
            target.config.replicas = Math.max(2, target.config.replicas);
            target.config.behavior = {
              ...behavior,
              storage: {
                ...behavior?.storage,
                replicationMode: "quorum",
                failoverSeconds: Math.min(
                  behavior?.storage?.failoverSeconds ?? 20,
                  20,
                ),
              },
              topology: {
                ...behavior?.topology,
                zone: "multi-az",
                failureDomain:
                  behavior?.topology?.failureDomain ?? "replica-set",
              },
            };
          }),
      });
    }
  }

  if (permits("storage-partitioning")) {
    for (const node of nodes) {
      if (
        (node.kind !== "database" && node.kind !== "object-store") ||
        !canChange(node.id)
      )
        continue;
      const storage = node.config.behavior?.storage;
      const nextPartitions = Math.min(
        100_000,
        Math.max(2, (storage?.partitions ?? 1) * 2),
      );
      if (nextPartitions === storage?.partitions) continue;
      mutations.push({
        change: {
          strategy: "storage-partitioning",
          nodeIds: [node.id],
          title: `Repartition ${node.name}`,
          detail: `Increase modeled partitions to ${nextPartitions}, reduce hot-partition concentration, and lower lock contention; operational complexity increases with partition count.`,
        },
        apply: (candidate) =>
          updateNode(candidate, node.id, (target) => {
            const behavior = target.config.behavior;
            const currentStorage = behavior?.storage;
            target.config.behavior = {
              ...behavior,
              storage: {
                ...currentStorage,
                partitions: nextPartitions,
                hotPartitionFraction: Math.max(
                  0,
                  (currentStorage?.hotPartitionFraction ?? 0.1) * 0.5,
                ),
                lockContention: Math.max(
                  0,
                  (currentStorage?.lockContention ?? 0.04) * 0.75,
                ),
              },
            };
          }),
      });
    }
  }

  if (permits("cache-efficiency")) {
    for (const node of nodes) {
      if (
        (node.kind !== "cache" && node.kind !== "cdn") ||
        !canChange(node.id) ||
        node.config.cacheHitRate >= 0.98
      )
        continue;
      const nextHitRate = Math.min(0.98, node.config.cacheHitRate + 0.08);
      mutations.push({
        change: {
          strategy: "cache-efficiency",
          nodeIds: [node.id],
          title: `Improve ${node.name} cache efficiency`,
          detail: `Raise the modeled steady-state hit rate to ${rounded(nextHitRate * 100, 1)}% and add capacity without pretending that hit-rate gains are free of cache memory.`,
        },
        apply: (candidate) =>
          updateNode(candidate, node.id, (target) => {
            const behavior = target.config.behavior;
            const cache = behavior?.cache;
            target.config.cacheHitRate = nextHitRate;
            target.config.behavior = {
              ...behavior,
              cache: {
                ...cache,
                capacityGb: Math.min(
                  1_000_000,
                  Math.max(1, (cache?.capacityGb ?? 16) * 1.5),
                ),
              },
            };
          }),
      });
    }
  }

  if (permits("consumer-parallelism")) {
    const workers = nodes.filter((node) => node.kind === "worker");
    for (const node of nodes) {
      if (
        (node.kind !== "queue" && node.kind !== "stream") ||
        workers.length === 0 ||
        !canChange(node.id, ...workers.map((worker) => worker.id))
      )
        continue;
      const partitions = node.config.behavior?.messaging?.partitions ?? 1;
      const nextPartitions = Math.min(100_000, Math.max(2, partitions * 2));
      const workerNames = workers.map((worker) => worker.name).join(", ");
      mutations.push({
        change: {
          strategy: "consumer-parallelism",
          nodeIds: [node.id, ...workers.map((worker) => worker.id)],
          title: `Increase ${node.name} consumer parallelism`,
          detail: `Raise partition parallelism to ${nextPartitions} and add active consumer capacity in ${workerNames}; this trades recurring compute cost for lower queue age.`,
        },
        apply: (candidate) => {
          updateNode(candidate, node.id, (target) => {
            const behavior = target.config.behavior;
            target.config.behavior = {
              ...behavior,
              messaging: {
                ...behavior?.messaging,
                partitions: nextPartitions,
              },
            };
          });
          for (const worker of workers)
            updateNode(candidate, worker.id, (target) => {
              const nextInstances = Math.min(
                10_000,
                Math.max(
                  target.config.instances + 1,
                  Math.ceil(target.config.instances * 1.5),
                ),
              );
              target.config.instances = nextInstances;
              target.config.maxInstances = Math.max(
                target.config.maxInstances,
                nextInstances,
              );
            });
        },
      });
    }
  }

  return mutations;
};

const candidateBlueprints = (
  architecture: Architecture,
  mutations: Mutation[],
  maxChangesPerCandidate: 1 | 2,
  limit: number,
): {
  blueprints: Array<{
    id: string;
    label: string;
    architecture: Architecture;
    changes: SolverChange[];
  }>;
  truncated: boolean;
} => {
  const blueprints: Array<{
    id: string;
    label: string;
    architecture: Architecture;
    changes: SolverChange[];
  }> = [];
  const fingerprints = new Set<string>();
  const baselineFingerprint = JSON.stringify(architecture);
  const append = (selected: Mutation[]) => {
    const candidate = structuredClone(architecture);
    for (const mutation of selected) mutation.apply(candidate);
    const fingerprint = JSON.stringify(candidate);
    if (fingerprint === baselineFingerprint || fingerprints.has(fingerprint))
      return;
    fingerprints.add(fingerprint);
    const changes = selected.map((mutation) => mutation.change);
    const id = changes
      .map((change) =>
        `${change.strategy}-${change.nodeIds.join("-")}`.toLowerCase(),
      )
      .join("__")
      .replaceAll(/[^a-z0-9_-]/g, "-");
    blueprints.push({
      id,
      label: changes.map((change) => change.title).join(" + "),
      architecture: candidate,
      changes,
    });
  };

  if (limit === 0) return { blueprints, truncated: mutations.length > 0 };
  for (const mutation of mutations) {
    if (blueprints.length >= limit) return { blueprints, truncated: true };
    append([mutation]);
  }
  if (maxChangesPerCandidate === 2) {
    for (let left = 0; left < mutations.length; left += 1) {
      for (let right = left + 1; right < mutations.length; right += 1) {
        const first = mutations[left];
        const second = mutations[right];
        if (
          !first ||
          !second ||
          first.change.strategy === second.change.strategy
        )
          continue;
        if (blueprints.length >= limit) return { blueprints, truncated: true };
        append([first, second]);
      }
    }
  }
  return { blueprints, truncated: false };
};

const normalizedWeights = (
  partial: Partial<SolverWeights> | undefined,
): SolverWeights => {
  const weights = { ...DEFAULT_WEIGHTS, ...partial };
  for (const [name, value] of Object.entries(weights))
    if (!Number.isFinite(value) || value < 0)
      throw new Error(
        `Solver weight ${name} must be a finite non-negative number.`,
      );
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (total <= 0)
    throw new Error("At least one solver weight must be positive.");
  return Object.fromEntries(
    Object.entries(weights).map(([name, value]) => [name, value / total]),
  ) as unknown as SolverWeights;
};

const validateOptions = (
  options: SolveArchitectureOptions,
  architecture: Architecture,
) => {
  const maxCandidates = options.maxCandidates ?? 36;
  if (
    !Number.isInteger(maxCandidates) ||
    maxCandidates < 1 ||
    maxCandidates > MAX_SOLVER_CANDIDATES
  )
    throw new Error(
      `maxCandidates must be an integer between 1 and ${MAX_SOLVER_CANDIDATES}.`,
    );
  const maxChangesPerCandidate = options.maxChangesPerCandidate ?? 2;
  if (maxChangesPerCandidate !== 1 && maxChangesPerCandidate !== 2)
    throw new Error("maxChangesPerCandidate must be 1 or 2.");
  const workUnitBudget =
    options.workUnitBudget ?? DEFAULT_SOLVER_WORK_UNIT_BUDGET;
  if (!Number.isFinite(workUnitBudget) || workUnitBudget < 1)
    throw new Error("workUnitBudget must be a positive finite number.");
  const allowedStrategies = options.allowedStrategies
    ? [...new Set(options.allowedStrategies)]
    : [...SOLVER_STRATEGIES];
  if (allowedStrategies.length === 0)
    throw new Error("At least one solver strategy must be allowed.");
  for (const strategy of allowedStrategies)
    if (!(SOLVER_STRATEGIES as readonly string[]).includes(strategy))
      throw new Error(`Unsupported solver strategy: ${strategy}.`);
  const lockedNodeIds = [...new Set(options.lockedNodeIds ?? [])];
  const knownNodeIds = new Set(architecture.nodes.map((node) => node.id));
  for (const nodeId of lockedNodeIds)
    if (!knownNodeIds.has(nodeId))
      throw new Error(`Locked solver node does not exist: ${nodeId}.`);
  for (const [name, value] of [
    ["maximumMonthlyCostEur", options.maximumMonthlyCostEur],
    ["maximumOperationalComplexity", options.maximumOperationalComplexity],
  ] as const)
    if (value !== undefined && (!Number.isFinite(value) || value < 0))
      throw new Error(`${name} must be a finite non-negative number.`);

  return {
    maxCandidates,
    maxChangesPerCandidate,
    workUnitBudget,
    allowedStrategies,
    lockedNodeIds,
    includeHiddenRequirements: options.includeHiddenRequirements ?? false,
    maximumMonthlyCostEur: options.maximumMonthlyCostEur,
    maximumOperationalComplexity: options.maximumOperationalComplexity,
    weights: normalizedWeights(options.weights),
  };
};

const constraintViolations = (
  metrics: SolverMetrics,
  options: ReturnType<typeof validateOptions>,
): string[] => {
  const violations: string[] = [];
  if (
    options.maximumMonthlyCostEur !== undefined &&
    metrics.monthlyCostEur > options.maximumMonthlyCostEur
  )
    violations.push(
      `Monthly cost ${rounded(metrics.monthlyCostEur, 2)} exceeds the ${rounded(options.maximumMonthlyCostEur, 2)} EUR ceiling.`,
    );
  if (
    options.maximumOperationalComplexity !== undefined &&
    metrics.operationalComplexity > options.maximumOperationalComplexity
  )
    violations.push(
      `Operational complexity ${rounded(metrics.operationalComplexity, 2)} exceeds the ${rounded(options.maximumOperationalComplexity, 2)} ceiling.`,
    );
  return violations;
};

const directionValues = (metrics: SolverMetrics) => ({
  requirements: metrics.requirementFitness,
  resilience: metrics.resilienceFitness,
  latency: metrics.p95LatencyMs,
  cost: metrics.monthlyCostEur,
  complexity: metrics.operationalComplexity,
});

const dominates = (left: SolverMetrics, right: SolverMetrics): boolean => {
  const a = directionValues(left);
  const b = directionValues(right);
  const epsilon = 0.000_001;
  const noWorse =
    a.requirements + epsilon >= b.requirements &&
    a.resilience + epsilon >= b.resilience &&
    a.latency <= b.latency + epsilon &&
    a.cost <= b.cost + epsilon &&
    a.complexity <= b.complexity + epsilon;
  const strictlyBetter =
    a.requirements > b.requirements + epsilon ||
    a.resilience > b.resilience + epsilon ||
    a.latency + epsilon < b.latency ||
    a.cost + epsilon < b.cost ||
    a.complexity + epsilon < b.complexity;
  return noWorse && strictlyBetter;
};

const scoreEvaluations = (
  baseline: SolverEvaluation,
  baselineEligible: boolean,
  candidates: InternalCandidate[],
  weights: SolverWeights,
): number => {
  const eligible = [
    ...(baselineEligible ? [{ evaluation: baseline, eligible: true }] : []),
    ...candidates.filter((candidate) => candidate.eligible),
  ];
  if (eligible.length === 0) {
    for (const candidate of candidates) candidate.utility = -1;
    return -1;
  }
  const values = eligible.map(({ evaluation }) =>
    directionValues(evaluation.metrics),
  );
  const range = (key: keyof ReturnType<typeof directionValues>) => ({
    minimum: Math.min(...values.map((value) => value[key])),
    maximum: Math.max(...values.map((value) => value[key])),
  });
  const ranges = {
    requirements: range("requirements"),
    resilience: range("resilience"),
    latency: range("latency"),
    cost: range("cost"),
    complexity: range("complexity"),
  };
  const normalize = (
    value: number,
    limits: { minimum: number; maximum: number },
    lowerIsBetter: boolean,
  ) => {
    if (Math.abs(limits.maximum - limits.minimum) < 0.000_001) return 0.5;
    const normalized =
      (value - limits.minimum) / (limits.maximum - limits.minimum);
    return lowerIsBetter ? 1 - normalized : normalized;
  };
  const utility = (evaluation: SolverEvaluation) => {
    const metrics = directionValues(evaluation.metrics);
    return (
      normalize(metrics.requirements, ranges.requirements, false) *
        weights.requirements +
      normalize(metrics.resilience, ranges.resilience, false) *
        weights.resilience +
      normalize(metrics.latency, ranges.latency, true) * weights.latency +
      normalize(metrics.cost, ranges.cost, true) * weights.cost +
      normalize(metrics.complexity, ranges.complexity, true) *
        weights.complexity
    );
  };
  const baselineUtility = baselineEligible ? utility(baseline) : -1;
  for (const candidate of candidates)
    candidate.utility = candidate.eligible ? utility(candidate.evaluation) : -1;
  return baselineUtility;
};

const deltasFrom = (
  baseline: SolverMetrics,
  candidate: SolverMetrics,
): SolverMetricDeltas => ({
  requirementsPassed:
    candidate.requirementsPassed - baseline.requirementsPassed,
  requirementFitness: rounded(
    candidate.requirementFitness - baseline.requirementFitness,
    6,
  ),
  resilienceFitness: rounded(
    candidate.resilienceFitness - baseline.resilienceFitness,
    6,
  ),
  p95LatencyMs: rounded(candidate.p95LatencyMs - baseline.p95LatencyMs),
  availability: rounded(candidate.availability - baseline.availability, 6),
  monthlyCostEur: rounded(candidate.monthlyCostEur - baseline.monthlyCostEur),
  dataLoss: rounded(candidate.dataLoss - baseline.dataLoss),
  operationalComplexity: rounded(
    candidate.operationalComplexity - baseline.operationalComplexity,
  ),
});

const explain = (
  baseline: SolverEvaluation,
  candidate: SolverEvaluation,
): { improvements: string[]; tradeoffs: string[] } => {
  const before = baseline.metrics;
  const after = candidate.metrics;
  const improvements: string[] = [];
  const tradeoffs: string[] = [];
  const gained = candidate.requirements.filter((result) => {
    const previous = baseline.requirements.find(
      (entry) => entry.requirement.id === result.requirement.id,
    );
    return result.passed && previous && !previous.passed;
  });
  const lost = candidate.requirements.filter((result) => {
    const previous = baseline.requirements.find(
      (entry) => entry.requirement.id === result.requirement.id,
    );
    return !result.passed && previous?.passed;
  });
  if (gained.length > 0)
    improvements.push(
      `Newly satisfies ${gained.map((result) => result.requirement.label).join(", ")}.`,
    );
  if (lost.length > 0)
    tradeoffs.push(
      `No longer satisfies ${lost.map((result) => result.requirement.label).join(", ")}.`,
    );
  if (after.p95LatencyMs < before.p95LatencyMs)
    improvements.push(
      `Worst modeled p95 latency falls by ${rounded(before.p95LatencyMs - after.p95LatencyMs, 2)} ms.`,
    );
  if (after.availability > before.availability)
    improvements.push(
      `Average modeled availability rises by ${rounded(after.availability - before.availability, 5)} percentage points.`,
    );
  if (after.dataLoss < before.dataLoss)
    improvements.push(
      `Modeled data loss falls by ${rounded(before.dataLoss - after.dataLoss, 2)} writes.`,
    );
  if (after.resilienceFitness > before.resilienceFitness)
    improvements.push("Composite modeled resilience improves.");
  if (after.monthlyCostEur > before.monthlyCostEur)
    tradeoffs.push(
      `Modeled monthly cost rises by EUR ${rounded(after.monthlyCostEur - before.monthlyCostEur, 2)}.`,
    );
  if (after.operationalComplexity > before.operationalComplexity)
    tradeoffs.push(
      `Operational complexity rises by ${rounded(after.operationalComplexity - before.operationalComplexity, 2)} points.`,
    );
  if (after.p95LatencyMs > before.p95LatencyMs)
    tradeoffs.push(
      `Worst modeled p95 latency rises by ${rounded(after.p95LatencyMs - before.p95LatencyMs, 2)} ms.`,
    );
  if (after.availability < before.availability)
    tradeoffs.push(
      `Average modeled availability falls by ${rounded(before.availability - after.availability, 5)} percentage points.`,
    );
  if (improvements.length === 0)
    improvements.push(
      "No measured objective improves over the current design.",
    );
  if (tradeoffs.length === 0)
    tradeoffs.push(
      "No modeled cost, complexity, latency, availability, or requirement regression was detected.",
    );
  return { improvements, tradeoffs };
};

export const estimateSolverWorkUnits = (
  scenario: Scenario,
  architecture: Architecture,
  candidateCount: number,
): number =>
  (scenario.workload.durationSeconds + 1) *
  (architecture.nodes.length + architecture.edges.length * 0.25) *
  (candidateCount + 1);

export function solveArchitecture(
  inputScenario: Scenario,
  inputArchitecture: Architecture,
  inputOptions: SolveArchitectureOptions = {},
): SolveArchitectureResult {
  const scenario = structuredClone(inputScenario);
  const architecture = structuredClone(inputArchitecture);
  const options = validateOptions(inputOptions, architecture);
  const hiddenRequirementCount = scenario.requirements.filter(
    (requirement) => requirement.visibility === "hidden",
  ).length;
  if (!options.includeHiddenRequirements)
    scenario.requirements = scenario.requirements.filter(
      (requirement) => requirement.visibility !== "hidden",
    );

  const baseline = summarize(simulate(scenario, architecture));
  const mutations = mutationCatalog(
    architecture,
    baseline.analysis.bottleneckNodeId,
    new Set(options.allowedStrategies),
    new Set(options.lockedNodeIds),
  );
  const singleEvaluationWorkUnits = estimateSolverWorkUnits(
    scenario,
    architecture,
    0,
  );
  if (singleEvaluationWorkUnits > options.workUnitBudget)
    throw new Error(
      `The baseline alone requires ${rounded(singleEvaluationWorkUnits, 2)} solver work units, above the ${rounded(options.workUnitBudget, 2)} budget. Reduce duration or topology size.`,
    );
  const budgetCandidateLimit = Math.max(
    0,
    Math.floor(options.workUnitBudget / singleEvaluationWorkUnits) - 1,
  );
  const generation = candidateBlueprints(
    architecture,
    mutations,
    options.maxChangesPerCandidate,
    Math.min(options.maxCandidates, budgetCandidateLimit),
  );
  const selected = generation.blueprints;
  const candidates: InternalCandidate[] = selected.map((blueprint) => {
    const evaluation = summarize(simulate(scenario, blueprint.architecture));
    const violations = constraintViolations(evaluation.metrics, options);
    return {
      ...blueprint,
      evaluation,
      constraintViolations: violations,
      eligible: violations.length === 0,
      utility: -1,
      paretoOptimal: false,
      dominatedByBaseline: false,
    };
  });
  const baselineConstraintViolations = constraintViolations(
    baseline.metrics,
    options,
  );
  const baselineEligible = baselineConstraintViolations.length === 0;
  const baselineUtility = scoreEvaluations(
    baseline,
    baselineEligible,
    candidates,
    options.weights,
  );
  const eligibleEvaluations = [
    { id: "baseline", evaluation: baseline, eligible: baselineEligible },
    ...candidates.map((candidate) => ({
      id: candidate.id,
      evaluation: candidate.evaluation,
      eligible: candidate.eligible,
    })),
  ];
  for (const candidate of candidates) {
    candidate.dominatedByBaseline =
      baselineEligible &&
      dominates(baseline.metrics, candidate.evaluation.metrics);
    candidate.paretoOptimal =
      candidate.eligible &&
      !eligibleEvaluations.some(
        (other) =>
          other.eligible &&
          other.id !== candidate.id &&
          dominates(other.evaluation.metrics, candidate.evaluation.metrics),
      );
  }
  const baselinePareto =
    baselineEligible &&
    !candidates.some(
      (candidate) =>
        candidate.eligible &&
        dominates(candidate.evaluation.metrics, baseline.metrics),
    );
  candidates.sort(
    (left, right) =>
      Number(right.eligible) - Number(left.eligible) ||
      right.utility - left.utility ||
      right.evaluation.metrics.requirementsPassed -
        left.evaluation.metrics.requirementsPassed ||
      left.id.localeCompare(right.id),
  );

  const publicCandidates = candidates.map((candidate, index) => {
    const explanation = explain(baseline, candidate.evaluation);
    return {
      id: candidate.id,
      rank: index + 1,
      label: candidate.label,
      architecture: candidate.architecture,
      changes: candidate.changes,
      evaluation: candidate.evaluation,
      deltas: deltasFrom(baseline.metrics, candidate.evaluation.metrics),
      score: rounded(Math.max(0, candidate.utility) * 100, 3),
      paretoOptimal: candidate.paretoOptimal,
      dominatedByBaseline: candidate.dominatedByBaseline,
      eligible: candidate.eligible,
      constraintViolations: candidate.constraintViolations,
      improvements: explanation.improvements,
      tradeoffs: explanation.tradeoffs,
    } satisfies SolverCandidate;
  });
  const recommended = publicCandidates.find(
    (candidate) =>
      candidate.eligible &&
      candidate.paretoOptimal &&
      !candidate.dominatedByBaseline &&
      candidate.score > rounded(Math.max(0, baselineUtility) * 100, 3),
  );
  const paretoFrontierIds = [
    ...(baselinePareto ? ["baseline"] : []),
    ...publicCandidates
      .filter((candidate) => candidate.paretoOptimal)
      .map((candidate) => candidate.id),
  ];
  const workUnits = estimateSolverWorkUnits(
    scenario,
    architecture,
    selected.length,
  );

  return {
    engineVersion: ENGINE_VERSION,
    solverVersion: SOLVER_VERSION,
    baseline: {
      ...baseline,
      score: rounded(Math.max(0, baselineUtility) * 100, 3),
      eligible: baselineEligible,
      constraintViolations: baselineConstraintViolations,
    },
    candidates: publicCandidates,
    paretoFrontierIds,
    recommendedCandidateId: recommended?.id,
    exploredCandidates: selected.length,
    generatedCandidates: generation.blueprints.length,
    truncated: generation.truncated,
    excludedHiddenRequirementCount: options.includeHiddenRequirements
      ? 0
      : hiddenRequirementCount,
    workUnits: rounded(workUnits, 2),
    options,
  };
}
