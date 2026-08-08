import { z } from "zod";

export const COMPONENT_KINDS = [
  "users",
  "region",
  "dns",
  "cdn",
  "network",
  "load-balancer",
  "api",
  "cache",
  "database",
  "queue",
  "stream",
  "worker",
  "object-store",
  "third-party",
] as const;

export const METRIC_NAMES = [
  "availability",
  "p50LatencyMs",
  "p95LatencyMs",
  "p99LatencyMs",
  "errorRate",
  "monthlyCostEur",
  "dataLoss",
  "consistencyViolations",
  "throughputRps",
  "queueDepth",
  "maxQueueAgeMs",
  "durabilityPercent",
  "replicaLagMs",
  "recoveryTimeSeconds",
  "residencyViolations",
  "operationalComplexity",
] as const;

export const requirementSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(160),
  metric: z.enum(METRIC_NAMES),
  operator: z.enum(["lte", "gte", "eq"]),
  target: z.number().finite(),
  unit: z.string().max(24).default(""),
  visibility: z.enum(["public", "hidden", "derived"]).default("public"),
  owner: z.enum(["scenario", "interviewer", "candidate"]).default("scenario"),
});

export type Requirement = z.infer<typeof requirementSchema>;

export const workloadSchema = z.object({
  baseRps: z.number().int().min(1).max(5_000_000),
  peakRps: z.number().int().min(1).max(10_000_000),
  readRatio: z.number().min(0).max(1),
  durationSeconds: z.number().int().min(15).max(86_400),
  regions: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        trafficShare: z.number().min(0).max(1),
        roundTripMs: z.number().min(0).max(2_000),
      }),
    )
    .min(1)
    .max(12),
  concurrentUsers: z.number().int().min(1).max(1_000_000_000).optional(),
  arrivalPattern: z.enum(["steady", "poisson", "bursty"]).optional(),
  clientTimeoutMs: z.number().int().min(50).max(120_000).optional(),
  retryPolicy: z
    .object({
      maxRetries: z.number().int().min(0).max(12),
      backoffBaseMs: z.number().int().min(0).max(60_000),
      jitter: z.boolean(),
      retryOnTimeout: z.boolean(),
    })
    .optional(),
  requestMix: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        share: z.number().min(0).max(1),
        readRatio: z.number().min(0).max(1),
        payloadKb: z.number().min(0).max(1_000_000),
        computeMs: z.number().min(0).max(60_000),
        databaseQueries: z.number().min(0).max(1_000),
        cacheable: z.boolean(),
        critical: z.boolean(),
      }),
    )
    .max(40)
    .optional(),
});

export const INCIDENT_KINDS = [
  "traffic-spike",
  "bot-attack",
  "ddos",
  "thundering-herd",
  "large-payload",
  "cache-failure",
  "cache-recovery",
  "cache-eviction-storm",
  "cache-stampede",
  "hot-key",
  "database-degradation",
  "database-recovery",
  "database-lock-contention",
  "disk-saturation",
  "hot-shard",
  "replication-lag",
  "leader-election",
  "queue-consumer-slowdown",
  "poison-message",
  "partition-imbalance",
  "node-failure",
  "zone-outage",
  "region-outage",
  "network-partition",
  "packet-loss",
  "slow-network",
  "dns-failure",
  "certificate-expiry",
  "gc-pause",
  "memory-leak",
  "deployment-regression",
  "bad-autoscaling",
  "retry-storm",
  "third-party-slowdown",
  "third-party-outage",
] as const;

export const incidentSchema = z.object({
  id: z.string().min(1).max(80),
  atSecond: z.number().int().min(0).max(86_400),
  kind: z.enum(INCIDENT_KINDS),
  magnitude: z.number().positive().max(100).default(1),
  label: z.string().min(1).max(160),
  targetId: z.string().min(1).max(80).optional(),
  region: z.string().min(1).max(80).optional(),
  zone: z.string().min(1).max(80).optional(),
  failureDomain: z.string().min(1).max(80).optional(),
  durationSeconds: z.number().int().min(1).max(86_400).optional(),
});

export type Incident = z.infer<typeof incidentSchema>;

export const scenarioSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(80),
    title: z.string().min(1).max(120),
    summary: z.string().min(1).max(600),
    mode: z.enum(["guided", "custom", "interview"]),
    seed: z.number().int().min(0).max(2_147_483_647),
    workload: workloadSchema,
    requirements: z.array(requirementSchema).max(40),
    incidents: z.array(incidentSchema).max(40),
    domain: z
      .object({
        acknowledgedWritesMustSurvive: z.boolean().optional(),
        preventOversell: z.boolean().optional(),
        piiRegion: z.string().min(1).max(80).optional(),
        staleReadToleranceSeconds: z.number().min(0).max(86_400).optional(),
        maximumRecoverySeconds: z.number().min(0).max(86_400).optional(),
      })
      .optional(),
    interview: z
      .object({
        candidateBrief: z.string().min(1).max(2_000),
        interviewerBrief: z.string().max(4_000).default(""),
        timeboxMinutes: z.number().int().min(5).max(240).default(45),
        allowCandidateRequirements: z.boolean().default(true),
        revealPolicy: z
          .enum(["never", "after-run", "interviewer-controlled"])
          .default("interviewer-controlled"),
      })
      .optional(),
  })
  .superRefine((scenario, context) => {
    if (scenario.workload.peakRps < scenario.workload.baseRps) {
      context.addIssue({
        code: "custom",
        path: ["workload", "peakRps"],
        message: "Peak RPS must be greater than or equal to base RPS.",
      });
    }
    const regionShare = scenario.workload.regions.reduce(
      (total, region) => total + region.trafficShare,
      0,
    );
    if (Math.abs(regionShare - 1) > 0.001) {
      context.addIssue({
        code: "custom",
        path: ["workload", "regions"],
        message: "Regional traffic shares must total 1.",
      });
    }
    if (scenario.workload.requestMix?.length) {
      const requestShare = scenario.workload.requestMix.reduce(
        (total, request) => total + request.share,
        0,
      );
      if (Math.abs(requestShare - 1) > 0.001) {
        context.addIssue({
          code: "custom",
          path: ["workload", "requestMix"],
          message: "Request-mix shares must total 1.",
        });
      }
    }
    const requirementIds = new Set<string>();
    for (const [index, requirement] of scenario.requirements.entries()) {
      if (requirementIds.has(requirement.id))
        context.addIssue({
          code: "custom",
          path: ["requirements", index, "id"],
          message: "Requirement identifiers must be unique.",
        });
      requirementIds.add(requirement.id);
      if (scenario.mode !== "interview" && requirement.visibility !== "public")
        context.addIssue({
          code: "custom",
          path: ["requirements", index, "visibility"],
          message:
            "Hidden and candidate-derived requirements are only valid in interview scenarios.",
        });
      if (
        requirement.visibility === "derived" &&
        requirement.owner !== "candidate"
      )
        context.addIssue({
          code: "custom",
          path: ["requirements", index, "owner"],
          message: "Candidate-derived requirements must be candidate-owned.",
        });
      if (
        requirement.owner === "candidate" &&
        requirement.visibility !== "derived"
      )
        context.addIssue({
          code: "custom",
          path: ["requirements", index, "visibility"],
          message: "Candidate-owned requirements must use derived visibility.",
        });
      if (
        requirement.visibility === "hidden" &&
        requirement.owner !== "interviewer"
      )
        context.addIssue({
          code: "custom",
          path: ["requirements", index, "owner"],
          message: "Hidden requirements must be interviewer-owned.",
        });
    }
    for (const [index, incident] of scenario.incidents.entries()) {
      if (incident.atSecond > scenario.workload.durationSeconds)
        context.addIssue({
          code: "custom",
          path: ["incidents", index, "atSecond"],
          message: "Incidents must start within the simulation duration.",
        });
    }
    if (scenario.mode === "interview" && !scenario.interview) {
      context.addIssue({
        code: "custom",
        path: ["interview"],
        message: "Interview configuration is required for interview scenarios.",
      });
    }
  });

export type Scenario = z.infer<typeof scenarioSchema>;

export const architectureNodeSchema = z
  .object({
    id: z.string().min(1).max(80),
    kind: z.enum(COMPONENT_KINDS),
    name: z.string().min(1).max(100),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }),
    config: z.object({
      instances: z.number().int().min(1).max(10_000).default(1),
      capacityRps: z.number().int().min(1).max(10_000_000),
      baseLatencyMs: z.number().min(0).max(60_000),
      maxConnections: z.number().int().min(1).max(10_000_000).default(1_000),
      cacheHitRate: z.number().min(0).max(1).default(0),
      replicas: z.number().int().min(0).max(100).default(0),
      monthlyCostEur: z.number().min(0).max(10_000_000).default(0),
      autoscale: z.boolean().default(false),
      maxInstances: z.number().int().min(1).max(10_000).default(1),
      consistency: z.enum(["strong", "eventual"]).default("strong"),
      behavior: z
        .object({
          compute: z
            .object({
              cpuCores: z.number().positive().max(4_096).optional(),
              memoryGb: z.number().positive().max(65_536).optional(),
              concurrencyPerInstance: z
                .number()
                .int()
                .positive()
                .max(10_000_000)
                .optional(),
              serviceTimeMs: z.number().min(0).max(60_000).optional(),
              gcPauseMs: z.number().min(0).max(60_000).optional(),
              gcIntervalSeconds: z.number().int().min(1).max(86_400).optional(),
              memoryLeakMbPerMinute: z
                .number()
                .min(0)
                .max(1_000_000)
                .optional(),
            })
            .optional(),
          network: z
            .object({
              bandwidthMbps: z.number().positive().max(100_000_000).optional(),
              rttMs: z.number().min(0).max(60_000).optional(),
              jitterMs: z.number().min(0).max(60_000).optional(),
              packetLossRate: z.number().min(0).max(1).optional(),
              egressCostPerGb: z.number().min(0).max(10_000).optional(),
            })
            .optional(),
          cache: z
            .object({
              capacityGb: z.number().positive().max(1_000_000).optional(),
              ttlSeconds: z.number().int().min(0).max(31_536_000).optional(),
              evictionPolicy: z
                .enum(["lru", "lfu", "fifo", "random"])
                .optional(),
              hotKeyFraction: z.number().min(0).max(1).optional(),
              warmupSeconds: z.number().int().min(0).max(86_400).optional(),
            })
            .optional(),
          storage: z
            .object({
              readIops: z.number().positive().max(1_000_000_000).optional(),
              writeIops: z.number().positive().max(1_000_000_000).optional(),
              diskThroughputMbps: z
                .number()
                .positive()
                .max(100_000_000)
                .optional(),
              bufferHitRate: z.number().min(0).max(1).optional(),
              lockContention: z.number().min(0).max(1).optional(),
              partitions: z.number().int().min(1).max(100_000).optional(),
              hotPartitionFraction: z.number().min(0).max(1).optional(),
              replicationMode: z
                .enum(["none", "async", "sync", "quorum"])
                .optional(),
              replicationLagMs: z.number().min(0).max(86_400_000).optional(),
              failoverSeconds: z.number().min(0).max(86_400).optional(),
            })
            .optional(),
          messaging: z
            .object({
              partitions: z.number().int().min(1).max(100_000).optional(),
              delivery: z
                .enum(["at-most-once", "at-least-once", "exactly-once"])
                .optional(),
              retentionHours: z.number().min(0).max(1_000_000).optional(),
              poisonMessageRate: z.number().min(0).max(1).optional(),
              batchSize: z.number().int().min(1).max(1_000_000).optional(),
            })
            .optional(),
          resilience: z
            .object({
              timeoutMs: z.number().int().min(1).max(120_000).optional(),
              maxRetries: z.number().int().min(0).max(12).optional(),
              backoffBaseMs: z.number().int().min(0).max(60_000).optional(),
              jitter: z.boolean().optional(),
              circuitBreaker: z.boolean().optional(),
              loadSheddingThreshold: z.number().min(0.1).max(10).optional(),
              bulkhead: z.boolean().optional(),
            })
            .optional(),
          scaling: z
            .object({
              minInstances: z.number().int().min(1).max(10_000).optional(),
              targetUtilization: z.number().min(0.1).max(1).optional(),
              cooldownSeconds: z.number().int().min(0).max(86_400).optional(),
              startupSeconds: z.number().int().min(0).max(86_400).optional(),
            })
            .optional(),
          topology: z
            .object({
              region: z.string().min(1).max(80).optional(),
              zone: z.string().min(1).max(80).optional(),
              dataResidency: z.string().min(1).max(80).optional(),
              failureDomain: z.string().min(1).max(80).optional(),
            })
            .optional(),
          operations: z
            .object({
              complexityWeight: z.number().min(0).max(100).optional(),
              managed: z.boolean().optional(),
            })
            .optional(),
        })
        .optional(),
    }),
  })
  .superRefine((node, context) => {
    if (node.config.maxInstances < node.config.instances)
      context.addIssue({
        code: "custom",
        path: ["config", "maxInstances"],
        message: "Maximum instances cannot be lower than active instances.",
      });
    const minimumInstances = node.config.behavior?.scaling?.minInstances;
    if (
      minimumInstances !== undefined &&
      minimumInstances > node.config.maxInstances
    )
      context.addIssue({
        code: "custom",
        path: ["config", "behavior", "scaling", "minInstances"],
        message: "Minimum instances cannot exceed maximum instances.",
      });
  });

export const architectureEdgeSchema = z.object({
  id: z.string().min(1).max(80),
  source: z.string().min(1).max(80),
  target: z.string().min(1).max(80),
  config: z
    .object({
      bandwidthMbps: z.number().positive().max(100_000_000).optional(),
      baseLatencyMs: z.number().min(0).max(60_000).optional(),
      jitterMs: z.number().min(0).max(60_000).optional(),
      packetLossRate: z.number().min(0).max(1).optional(),
      asynchronous: z.boolean().optional(),
      trafficShare: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

export const architectureSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(120),
    nodes: z.array(architectureNodeSchema).min(1).max(500),
    edges: z.array(architectureEdgeSchema).max(2_000),
  })
  .superRefine((architecture, context) => {
    const nodeIds = new Set<string>();
    for (const [index, node] of architecture.nodes.entries()) {
      if (nodeIds.has(node.id))
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "id"],
          message: "Architecture node identifiers must be unique.",
        });
      nodeIds.add(node.id);
    }
    const edgeIds = new Set<string>();
    for (const [index, edge] of architecture.edges.entries()) {
      if (edgeIds.has(edge.id))
        context.addIssue({
          code: "custom",
          path: ["edges", index, "id"],
          message: "Architecture edge identifiers must be unique.",
        });
      edgeIds.add(edge.id);
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target))
        context.addIssue({
          code: "custom",
          path: ["edges", index],
          message: "Architecture edges must reference existing nodes.",
        });
    }
  });

export type ArchitectureNode = z.infer<typeof architectureNodeSchema>;
export type ArchitectureEdge = z.infer<typeof architectureEdgeSchema>;
export type Architecture = z.infer<typeof architectureSchema>;

export interface MetricFrame {
  second: number;
  rps: number;
  throughputRps: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  errorRate: number;
  availability: number;
  queueDepth: number;
  retryAmplification: number;
  monthlyCostEur: number;
  dataLoss: number;
  consistencyViolations: number;
  durabilityPercent: number;
  replicaLagMs: number;
  maxQueueAgeMs: number;
  recoveryTimeSeconds: number;
  residencyViolations: number;
  operationalComplexity: number;
  nodeUtilization: Record<string, number>;
  nodeMetrics: Record<string, NodeMetricSnapshot>;
}

export interface NodeMetricSnapshot {
  utilization: number;
  cpuUtilization: number;
  memoryUtilization: number;
  connectionUtilization: number;
  iopsUtilization: number;
  networkUtilization: number;
  queueDepth: number;
  replicaLagMs: number;
  activeInstances: number;
  latencyMs: number;
  errorRate: number;
  state: "healthy" | "warning" | "critical" | "offline";
}

export interface CausalEvent {
  id: string;
  second: number;
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  entityId?: string;
  parentIds: string[];
  effects?: Array<{ metric: string; delta: number; label: string }>;
  recommendations?: string[];
}

export interface RequirementResult {
  requirement: Requirement;
  actual: number;
  passed: boolean;
}

export interface SimulationResult {
  engineVersion: string;
  seed: number;
  frames: MetricFrame[];
  events: CausalEvent[];
  requirements: RequirementResult[];
  score: { passed: number; total: number };
  analysis: {
    bottleneckNodeId?: string;
    bottleneckLabel: string;
    tradeoffs: string[];
    strengths: string[];
    risks: string[];
  };
  digest?: string;
}

export const runSubmissionSchema = z.object({
  scenario: scenarioSchema,
  architecture: architectureSchema,
  clientEngineVersion: z.string().min(1).max(40),
});

export type RunSubmission = z.infer<typeof runSubmissionSchema>;

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
    retryAfterSeconds?: number;
    localModeAvailable: true;
  };
}

export function candidateScenario(
  scenario: Scenario,
  revealHiddenRequirements = false,
): Scenario {
  if (scenario.mode !== "interview") return scenario;
  return {
    ...scenario,
    requirements: revealHiddenRequirements
      ? scenario.requirements.map((requirement) =>
          requirement.visibility === "hidden"
            ? { ...requirement, visibility: "public" as const }
            : requirement,
        )
      : scenario.requirements.filter(
          (requirement) => requirement.visibility !== "hidden",
        ),
    interview: scenario.interview
      ? { ...scenario.interview, interviewerBrief: "" }
      : undefined,
  };
}
