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

export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/**
 * Components whose modeled replicas represent copies of retained state.
 * Stateless service redundancy remains represented by instances/autoscaling.
 */
export const STATE_OWNING_COMPONENT_KINDS = [
  "cache",
  "database",
  "object-store",
  "queue",
  "stream",
] as const satisfies readonly ComponentKind[];

/** Components for which the strong/eventual read-consistency primitive applies. */
export const READ_CONSISTENCY_COMPONENT_KINDS = [
  "database",
] as const satisfies readonly ComponentKind[];

const stateOwningComponentKinds = new Set<ComponentKind>(
  STATE_OWNING_COMPONENT_KINDS,
);
const readConsistencyComponentKinds = new Set<ComponentKind>(
  READ_CONSISTENCY_COMPONENT_KINDS,
);

export const componentOwnsState = (kind: ComponentKind): boolean =>
  stateOwningComponentKinds.has(kind);

export const componentUsesReadConsistency = (kind: ComponentKind): boolean =>
  readConsistencyComponentKinds.has(kind);

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
        entryNodeId: z.string().min(1).max(80).optional(),
        route: z
          .object({
            edgeIds: z
              .array(z.string().min(1).max(80))
              .min(1)
              .max(128)
              .optional(),
            terminalNodeId: z.string().min(1).max(80).optional(),
          })
          .superRefine((route, context) => {
            if (!route.edgeIds && !route.terminalNodeId)
              context.addIssue({
                code: "custom",
                message:
                  "A request-class route must constrain edges, a terminal node, or both.",
              });
            if (
              route.edgeIds &&
              new Set(route.edgeIds).size !== route.edgeIds.length
            )
              context.addIssue({
                code: "custom",
                path: ["edgeIds"],
                message:
                  "A request-class route cannot traverse the same edge more than once.",
              });
          })
          .optional(),
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

export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const GLOBAL_WORKLOAD_INCIDENT_KINDS = [
  "traffic-spike",
  "bot-attack",
  "ddos",
  "thundering-herd",
  "large-payload",
  "retry-storm",
] as const satisfies readonly IncidentKind[];

const globalWorkloadIncidentKinds = new Set<IncidentKind>(
  GLOBAL_WORKLOAD_INCIDENT_KINDS,
);

export const incidentUsesGlobalWorkload = (kind: IncidentKind): boolean =>
  globalWorkloadIncidentKinds.has(kind);

export const BINARY_INCIDENT_KINDS = [
  "cache-failure",
  "cache-recovery",
  "cache-stampede",
  "database-recovery",
  "leader-election",
  "node-failure",
  "zone-outage",
  "region-outage",
  "network-partition",
  "dns-failure",
  "certificate-expiry",
  "third-party-outage",
] as const satisfies readonly IncidentKind[];

const binaryIncidentKinds = new Set<IncidentKind>(BINARY_INCIDENT_KINDS);

export const incidentUsesMagnitude = (kind: IncidentKind): boolean =>
  !binaryIncidentKinds.has(kind);

export const incidentCanAffectComponent = (
  kind: IncidentKind,
  componentKind: ComponentKind,
): boolean => {
  if (incidentUsesGlobalWorkload(kind)) return false;
  if (
    kind === "node-failure" ||
    kind === "zone-outage" ||
    kind === "region-outage" ||
    kind === "network-partition" ||
    kind === "packet-loss" ||
    kind === "slow-network" ||
    kind === "gc-pause" ||
    kind === "memory-leak" ||
    kind === "deployment-regression" ||
    kind === "bad-autoscaling"
  )
    return true;
  if (
    kind === "cache-failure" ||
    kind === "cache-recovery" ||
    kind === "cache-eviction-storm" ||
    kind === "cache-stampede" ||
    kind === "hot-key"
  )
    return componentKind === "cache";
  if (
    kind === "database-degradation" ||
    kind === "database-recovery" ||
    kind === "database-lock-contention"
  )
    return componentKind === "database";
  if (
    kind === "disk-saturation" ||
    kind === "hot-shard" ||
    kind === "replication-lag"
  )
    return componentKind === "database" || componentKind === "object-store";
  if (kind === "leader-election" || kind === "partition-imbalance")
    return (
      componentKind === "database" ||
      componentKind === "queue" ||
      componentKind === "stream"
    );
  if (kind === "queue-consumer-slowdown") return componentKind === "worker";
  if (kind === "poison-message")
    return componentKind === "queue" || componentKind === "stream";
  if (kind === "dns-failure") return componentKind === "dns";
  if (kind === "certificate-expiry")
    return componentKind === "cdn" || componentKind === "load-balancer";
  if (kind === "third-party-slowdown" || kind === "third-party-outage")
    return componentKind === "third-party";
  return false;
};

const incidentFields = {
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
};

const refineIncidentSemantics = (
  incident: {
    kind: IncidentKind;
    magnitude: number;
    targetId?: string;
    region?: string;
    zone?: string;
    failureDomain?: string;
  },
  context: z.RefinementCtx,
): void => {
  if (!incidentUsesMagnitude(incident.kind) && incident.magnitude !== 1)
    context.addIssue({
      code: "custom",
      path: ["magnitude"],
      message: `${incident.kind} is a binary modeled event and requires magnitude 1.`,
    });
  if (
    incident.kind === "node-failure" &&
    !incident.targetId &&
    !incident.region &&
    !incident.zone &&
    !incident.failureDomain
  )
    context.addIssue({
      code: "custom",
      path: ["targetId"],
      message: "A node failure requires a target node or placement scope.",
    });
  if (incident.kind === "zone-outage" && !incident.zone)
    context.addIssue({
      code: "custom",
      path: ["zone"],
      message: "A zone outage requires one placement zone.",
    });
  if (incident.kind === "region-outage" && !incident.region)
    context.addIssue({
      code: "custom",
      path: ["region"],
      message: "A region outage requires one placement region.",
    });
};

export const incidentSchema = z
  .object(incidentFields)
  .superRefine(refineIncidentSemantics);

const injectedIncidentSchema = z
  .object(incidentFields)
  .omit({ atSecond: true })
  .superRefine(refineIncidentSemantics);

export type Incident = z.infer<typeof incidentSchema>;

/**
 * Resolves the modeled lifetime used by both the engine and read-only UI
 * incident indicators when an authored incident omits an explicit duration.
 */
export const modeledIncidentDurationSeconds = (
  incident: Incident,
  scenarioDurationSeconds: number,
): number => {
  if (incident.durationSeconds !== undefined) return incident.durationSeconds;
  if (
    incident.kind === "traffic-spike" ||
    incident.kind === "memory-leak" ||
    incident.kind === "cache-failure" ||
    incident.kind === "database-degradation"
  )
    return Math.max(1, scenarioDurationSeconds - incident.atSecond);
  if (incident.kind.includes("recovery")) return 1;
  if (incident.kind === "gc-pause" || incident.kind === "leader-election")
    return 8;
  return 30;
};

export const STOCHASTIC_INCIDENT_TRIGGER_METRICS = [
  "p95LatencyMs",
  "errorRate",
  "availability",
  "queueDepth",
  "retryAmplification",
  "throughputRps",
] as const;

export const MAX_STOCHASTIC_INCIDENT_RULES = 16;
export const MAX_GENERATED_INCIDENTS = 64;
export const MAX_STOCHASTIC_RULE_OCCURRENCES = 32;

const STOCHASTIC_TRIGGER_MAXIMUMS: Record<
  (typeof STOCHASTIC_INCIDENT_TRIGGER_METRICS)[number],
  number
> = {
  p95LatencyMs: 1_000_000,
  errorRate: 100,
  availability: 100,
  queueDepth: 1_000_000_000_000,
  retryAmplification: 10,
  throughputRps: 5_000_000_000,
};

export const stochasticIncidentTriggerSchema = z
  .object({
    metric: z.enum(STOCHASTIC_INCIDENT_TRIGGER_METRICS),
    operator: z.enum(["gte", "lte"]),
    threshold: z.number().finite().min(0),
  })
  .superRefine((trigger, context) => {
    if (trigger.threshold > STOCHASTIC_TRIGGER_MAXIMUMS[trigger.metric])
      context.addIssue({
        code: "custom",
        path: ["threshold"],
        message: `The ${trigger.metric} trigger threshold is outside the supported modeled range.`,
      });
  });

export const stochasticIncidentRuleSchema = z
  .object({
    id: z.string().min(1).max(80),
    enabled: z.boolean().default(true),
    kind: z.enum(INCIDENT_KINDS),
    label: z.string().min(1).max(160),
    hazardRatePerSecond: z.number().min(0).max(1),
    cooldownSeconds: z.number().int().min(0).max(86_400),
    maxOccurrences: z
      .number()
      .int()
      .min(1)
      .max(MAX_STOCHASTIC_RULE_OCCURRENCES),
    magnitude: z.number().positive().max(100),
    durationSeconds: z.number().int().min(1).max(86_400),
    scope: z
      .object({
        targetId: z.string().min(1).max(80).optional(),
        region: z.string().min(1).max(80).optional(),
        zone: z.string().min(1).max(80).optional(),
        failureDomain: z.string().min(1).max(80).optional(),
        correlated: z.boolean().default(false),
      })
      .optional(),
    trigger: stochasticIncidentTriggerSchema.optional(),
  })
  .superRefine((rule, context) => {
    if (!incidentUsesMagnitude(rule.kind) && rule.magnitude !== 1)
      context.addIssue({
        code: "custom",
        path: ["magnitude"],
        message: `${rule.kind} is a binary modeled event and requires magnitude 1.`,
      });
    if (
      rule.kind === "zone-outage" &&
      (!rule.scope?.zone || rule.scope.correlated !== true)
    )
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "A stochastic zone outage requires a correlated zone scope.",
      });
    if (
      rule.kind === "region-outage" &&
      (!rule.scope?.region || rule.scope.correlated !== true)
    )
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message:
          "A stochastic region outage requires a correlated region scope.",
      });
  });

export const stochasticIncidentModelSchema = z.object({
  enabled: z.boolean().default(true),
  maxGeneratedIncidents: z.number().int().min(1).max(MAX_GENERATED_INCIDENTS),
  rules: z
    .array(stochasticIncidentRuleSchema)
    .max(MAX_STOCHASTIC_INCIDENT_RULES),
});

export type StochasticIncidentTrigger = z.infer<
  typeof stochasticIncidentTriggerSchema
>;
export type StochasticIncidentRule = z.infer<
  typeof stochasticIncidentRuleSchema
>;
export type StochasticIncidentModel = z.infer<
  typeof stochasticIncidentModelSchema
>;

export const nodeInterventionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("scale"),
    instances: z.number().int().min(1).max(10_000),
  }),
  z.object({
    kind: z.literal("circuit-breaker"),
    enabled: z.boolean(),
  }),
  z.object({
    kind: z.literal("load-shedding"),
    threshold: z.number().min(0.1).max(10),
  }),
]);

export const simulationActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("inject-incident"),
    id: z.string().min(1).max(80),
    atSecond: z.number().int().min(1).max(86_400),
    incident: injectedIncidentSchema,
  }),
  z.object({
    type: z.literal("apply-intervention"),
    id: z.string().min(1).max(80),
    atSecond: z.number().int().min(1).max(86_400),
    nodeId: z.string().min(1).max(80),
    intervention: nodeInterventionSchema,
  }),
]);

export const MAX_SIMULATION_ACTIONS = 64;

export const simulationActionScheduleSchema = z
  .array(simulationActionSchema)
  .max(MAX_SIMULATION_ACTIONS)
  .superRefine((actions, context) => {
    const ids = new Set<string>();
    for (const [index, action] of actions.entries()) {
      if (ids.has(action.id))
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "Simulation action identifiers must be unique.",
        });
      ids.add(action.id);
    }
  });

export type NodeIntervention = z.infer<typeof nodeInterventionSchema>;
export type SimulationAction = z.infer<typeof simulationActionSchema>;

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
    stochasticIncidents: stochasticIncidentModelSchema.optional(),
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
    const regionNames = new Set<string>();
    for (const [index, region] of scenario.workload.regions.entries()) {
      const normalizedName = region.name.trim().toLocaleLowerCase("en-US");
      if (regionNames.has(normalizedName))
        context.addIssue({
          code: "custom",
          path: ["workload", "regions", index, "name"],
          message: "Workload region names must be unique.",
        });
      regionNames.add(normalizedName);
    }
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
    const incidentIds = new Set<string>();
    for (const [index, incident] of scenario.incidents.entries()) {
      if (incidentIds.has(incident.id))
        context.addIssue({
          code: "custom",
          path: ["incidents", index, "id"],
          message: "Incident identifiers must be unique.",
        });
      incidentIds.add(incident.id);
      if (incident.atSecond > scenario.workload.durationSeconds)
        context.addIssue({
          code: "custom",
          path: ["incidents", index, "atSecond"],
          message: "Incidents must start within the simulation duration.",
        });
    }
    const stochasticRuleIds = new Set<string>();
    for (const [index, rule] of (
      scenario.stochasticIncidents?.rules ?? []
    ).entries()) {
      if (stochasticRuleIds.has(rule.id))
        context.addIssue({
          code: "custom",
          path: ["stochasticIncidents", "rules", index, "id"],
          message: "Stochastic incident rule identifiers must be unique.",
        });
      stochasticRuleIds.add(rule.id);
    }
    if (scenario.mode === "interview" && !scenario.interview) {
      context.addIssue({
        code: "custom",
        path: ["interview"],
        message: "Interview configuration is required for interview scenarios.",
      });
    }
    if (scenario.mode !== "interview" && scenario.interview) {
      context.addIssue({
        code: "custom",
        path: ["interview"],
        message:
          "Interview configuration is only valid for interview scenarios.",
      });
    }
  });

export type Scenario = z.infer<typeof scenarioSchema>;

export const behavioralProfileReferenceSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(120)
    .regex(
      /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/,
      "Behavioral profile identifiers must use lowercase dot-separated or hyphenated segments.",
    ),
  version: z.number().int().min(1).max(10_000),
});

export type BehavioralProfileReference = z.infer<
  typeof behavioralProfileReferenceSchema
>;

export const nodeBehaviorSchema = z.object({
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
      memoryLeakMbPerMinute: z.number().min(0).max(1_000_000).optional(),
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
      evictionPolicy: z.enum(["lru", "lfu", "fifo", "random"]).optional(),
      hotKeyFraction: z.number().min(0).max(1).optional(),
      warmupSeconds: z.number().int().min(0).max(86_400).optional(),
    })
    .optional(),
  storage: z
    .object({
      readIops: z.number().positive().max(1_000_000_000).optional(),
      writeIops: z.number().positive().max(1_000_000_000).optional(),
      diskThroughputMbps: z.number().positive().max(100_000_000).optional(),
      bufferHitRate: z.number().min(0).max(1).optional(),
      lockContention: z.number().min(0).max(1).optional(),
      partitions: z.number().int().min(1).max(100_000).optional(),
      hotPartitionFraction: z.number().min(0).max(1).optional(),
      replicationMode: z.enum(["none", "async", "sync", "quorum"]).optional(),
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
});

export type NodeBehavior = z.infer<typeof nodeBehaviorSchema>;

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
      behavior: nodeBehaviorSchema.optional(),
      behavioralProfile: behavioralProfileReferenceSchema.optional(),
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
    if (
      minimumInstances !== undefined &&
      minimumInstances > node.config.instances
    )
      context.addIssue({
        code: "custom",
        path: ["config", "behavior", "scaling", "minInstances"],
        message: "Minimum instances cannot exceed active instances.",
      });
    const replicationMode = node.config.behavior?.storage?.replicationMode;
    if (
      componentOwnsState(node.kind) &&
      replicationMode !== undefined &&
      ((node.config.replicas === 0 && replicationMode !== "none") ||
        (node.config.replicas > 0 && replicationMode === "none"))
    )
      context.addIssue({
        code: "custom",
        path: ["config", "behavior", "storage", "replicationMode"],
        message:
          "Replication mode must agree with the configured durable replica count.",
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

const architectureDraftBaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  nodes: z.array(architectureNodeSchema).max(500),
  edges: z.array(architectureEdgeSchema).max(2_000),
});

const validateArchitectureGraph = (
  architecture: z.infer<typeof architectureDraftBaseSchema>,
  context: z.RefinementCtx,
) => {
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
};

export const architectureDraftSchema = architectureDraftBaseSchema.superRefine(
  validateArchitectureGraph,
);

export const architectureSchema = architectureDraftBaseSchema
  .extend({ nodes: z.array(architectureNodeSchema).min(1).max(500) })
  .superRefine(validateArchitectureGraph);

export type ArchitectureNode = z.infer<typeof architectureNodeSchema>;
export type ArchitectureEdge = z.infer<typeof architectureEdgeSchema>;
export type ArchitectureDraft = z.infer<typeof architectureDraftSchema>;
export type Architecture = z.infer<typeof architectureSchema>;

export const MAX_TOPOLOGY_FANOUT_AMPLIFICATION = 1_000_000;

export interface TopologyExecutionBounds {
  fanoutAmplification: number;
  reachableCycleNodeIds: string[];
}

export const analyzeTopologyExecutionBounds = (
  architecture: ArchitectureDraft,
): TopologyExecutionBounds => {
  const nodeIndexById = new Map(
    architecture.nodes.map((node, index) => [node.id, index]),
  );
  const outgoingByIndex = architecture.nodes.map(
    () => [] as Array<{ targetIndex: number; trafficShare: number }>,
  );
  const positiveIncoming = new Uint32Array(architecture.nodes.length);
  for (const edge of architecture.edges) {
    const sourceIndex = nodeIndexById.get(edge.source);
    const targetIndex = nodeIndexById.get(edge.target);
    const trafficShare = edge.config?.trafficShare ?? 1;
    if (
      sourceIndex === undefined ||
      targetIndex === undefined ||
      trafficShare <= 0
    )
      continue;
    outgoingByIndex[sourceIndex]!.push({ targetIndex, trafficShare });
    positiveIncoming[targetIndex] = (positiveIncoming[targetIndex] ?? 0) + 1;
  }

  const explicitSourceIndexes = architecture.nodes.flatMap((node, index) =>
    node.kind === "users" || node.kind === "region" ? [index] : [],
  );
  const sourceIndexes =
    explicitSourceIndexes.length > 0
      ? explicitSourceIndexes
      : architecture.nodes.flatMap((_, index) =>
          positiveIncoming[index] === 0 ? [index] : [],
        );
  const reachable = new Set<number>();
  const pending = [...sourceIndexes];
  for (let pendingIndex = 0; pendingIndex < pending.length; pendingIndex += 1) {
    const nodeIndex = pending[pendingIndex];
    if (nodeIndex === undefined || reachable.has(nodeIndex)) continue;
    reachable.add(nodeIndex);
    for (const edge of outgoingByIndex[nodeIndex] ?? [])
      pending.push(edge.targetIndex);
  }

  const incomingWithinReachable = new Uint32Array(architecture.nodes.length);
  for (const sourceIndex of reachable) {
    for (const edge of outgoingByIndex[sourceIndex] ?? []) {
      if (!reachable.has(edge.targetIndex)) continue;
      incomingWithinReachable[edge.targetIndex] =
        (incomingWithinReachable[edge.targetIndex] ?? 0) + 1;
    }
  }
  const ready = architecture.nodes.flatMap((_, index) =>
    reachable.has(index) && incomingWithinReachable[index] === 0 ? [index] : [],
  );
  const executionOrder: number[] = [];
  const scheduled = new Set<number>();
  for (let readyIndex = 0; readyIndex < ready.length; readyIndex += 1) {
    const nodeIndex = ready[readyIndex];
    if (nodeIndex === undefined || scheduled.has(nodeIndex)) continue;
    scheduled.add(nodeIndex);
    executionOrder.push(nodeIndex);
    for (const edge of outgoingByIndex[nodeIndex] ?? []) {
      if (!reachable.has(edge.targetIndex)) continue;
      incomingWithinReachable[edge.targetIndex] = Math.max(
        0,
        (incomingWithinReachable[edge.targetIndex] ?? 0) - 1,
      );
      if (incomingWithinReachable[edge.targetIndex] === 0)
        ready.push(edge.targetIndex);
    }
  }
  const reachableCycleNodeIds = architecture.nodes.flatMap((node, index) =>
    reachable.has(index) && !scheduled.has(index) ? [node.id] : [],
  );

  const amplification = new Float64Array(architecture.nodes.length);
  for (const sourceIndex of sourceIndexes) amplification[sourceIndex] = 1;
  let fanoutAmplification = sourceIndexes.length > 0 ? 1 : 0;
  for (const sourceIndex of executionOrder) {
    const sourceAmplification = amplification[sourceIndex] ?? 0;
    fanoutAmplification = Math.max(fanoutAmplification, sourceAmplification);
    for (const edge of outgoingByIndex[sourceIndex] ?? []) {
      const nextAmplification =
        (amplification[edge.targetIndex] ?? 0) +
        sourceAmplification * edge.trafficShare;
      if (!Number.isFinite(nextAmplification))
        return { fanoutAmplification: Infinity, reachableCycleNodeIds };
      amplification[edge.targetIndex] = nextAmplification;
      fanoutAmplification = Math.max(fanoutAmplification, nextAmplification);
    }
  }
  return { fanoutAmplification, reachableCycleNodeIds };
};

export const MAX_SIMULATION_EXECUTION_WORK_UNITS = 10_000_000;
export const MAX_SIMULATION_OUTPUT_METRIC_CELLS = 60_000;
export const MAX_SIMULATION_ESTIMATED_RESULT_BYTES = 8_000_000;

export const estimateSimulationExecutionWorkUnits = (
  scenario: Scenario,
  architecture: ArchitectureDraft,
  actionCount = 0,
): number => {
  const frameCount = scenario.workload.durationSeconds + 1;
  const requestClassCount = Math.max(
    1,
    scenario.workload.requestMix?.length ?? 0,
  );
  const requestExecutionPasses = architecture.nodes.some(
    (node) => node.kind === "cache",
  )
    ? 2
    : 1;
  const stochasticRuleCount = scenario.stochasticIncidents?.rules.length ?? 0;
  return (
    frameCount *
      (architecture.nodes.length +
        (architecture.nodes.length + architecture.edges.length) *
          requestClassCount *
          requestExecutionPasses +
        scenario.incidents.length +
        stochasticRuleCount) +
    Math.max(0, actionCount) *
      (architecture.nodes.length + architecture.edges.length)
  );
};

export const estimateSimulationOutputMetricCells = (
  scenario: Scenario,
  architecture: ArchitectureDraft,
): number =>
  (scenario.workload.durationSeconds + 1) *
  (architecture.nodes.length + architecture.edges.length);

export const estimateSimulationResultBytes = (
  scenario: Scenario,
  architecture: ArchitectureDraft,
): number =>
  (scenario.workload.durationSeconds + 1) *
    (512 + architecture.nodes.length * 320 + architecture.edges.length * 180) +
  scenario.incidents.length * 1_024;

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
  edgeMetrics: Record<string, EdgeMetricSnapshot>;
}

export interface EdgeMetricSnapshot {
  attemptedRps: number;
  throughputRps: number;
  retryRps: number;
  lostRps: number;
  packetLossPercent: number;
  latencyMs: number;
  asynchronous: boolean;
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
  generatedIncident?: {
    ruleId: string;
    occurrence: number;
    affectedNodeIds: string[];
    correlated: boolean;
  };
}

export interface GeneratedIncidentRecord {
  ruleId: string;
  occurrence: number;
  incident: Incident;
  affectedNodeIds: string[];
  correlated: boolean;
  trigger?: StochasticIncidentTrigger & {
    priorFrameSecond: number;
    observedValue: number;
  };
}

export interface RequirementResult {
  requirement: Requirement;
  actual: number;
  passed: boolean;
}

export const behavioralProfileProvenanceSchema = z.object({
  publisher: z.string().min(1).max(160),
  title: z.string().min(1).max(240),
  url: z.url().max(2_000),
  retrievedOn: z.iso.date(),
  scope: z.enum(["vendor-characteristics", "modeling-assumptions"]),
});

export type BehavioralProfileProvenance = z.infer<
  typeof behavioralProfileProvenanceSchema
>;

const behavioralProfileEvidenceBaseSchema = z.object({
  nodeId: z.string().min(1).max(80),
  nodeKind: z.enum(COMPONENT_KINDS),
});

export const nodeBehavioralProfileEvidenceSchema = z.discriminatedUnion(
  "status",
  [
    behavioralProfileEvidenceBaseSchema.extend({
      status: z.literal("unprofiled"),
      profileId: z.null(),
      profileVersion: z.null(),
      profileLabel: z.null(),
      assumptions: z.array(z.string()).max(0),
      provenance: z.array(behavioralProfileProvenanceSchema).max(0),
      localOverrides: z.literal(false),
      overriddenFields: z.array(z.string()).max(0),
    }),
    behavioralProfileEvidenceBaseSchema.extend({
      status: z.literal("resolved"),
      profileId: z.string().min(1).max(120),
      profileVersion: z.number().int().min(1).max(10_000),
      profileLabel: z.string().min(1).max(160),
      assumptions: z.array(z.string().min(1).max(1_000)).min(1).max(20),
      provenance: z.array(behavioralProfileProvenanceSchema).min(1).max(12),
      localOverrides: z.boolean(),
      overriddenFields: z.array(z.string().min(1).max(240)).max(128),
    }),
  ],
);

export type NodeBehavioralProfileEvidence = z.infer<
  typeof nodeBehavioralProfileEvidenceSchema
>;

export interface SimulationResult {
  engineVersion: string;
  inputFingerprint: string;
  seed: number;
  behavioralProfiles: NodeBehavioralProfileEvidence[];
  frames: MetricFrame[];
  events: CausalEvent[];
  generatedIncidents: GeneratedIncidentRecord[];
  requirements: RequirementResult[];
  score: { passed: number; total: number };
  analysis: {
    bottleneckNodeId?: string;
    bottleneckLabel: string;
    tradeoffs: string[];
    strengths: string[];
    risks: string[];
  };
  traces?: SampledTrace[];
  digest?: string;
}

export interface SampledTrace {
  traceId: string;
  second: number;
  requestClass: string;
  modeledRps: number;
  entryNodeId: string;
  entryNodeIds?: string[];
  terminalNodeId?: string;
  truncated: boolean;
  spans: SampledSpan[];
}

export interface SampledSpan {
  spanId: string;
  parentSpanId?: string;
  kind: "entry" | "edge" | "retry" | "cache" | "async-queue" | "terminal";
  name: string;
  nodeId?: string;
  edgeId?: string;
  sourceNodeId?: string;
  targetNodeId?: string;
  attemptedRps: number;
  throughputRps: number;
  retryRps: number;
  lostRps: number;
  latencyMs: number;
  cacheHitRps?: number;
  cacheMissRps?: number;
  retryAttempt?: number;
  queryClass?: "read" | "write" | "mixed";
  messageId?: string;
  parentMessageId?: string;
  connectionPoolWaitMs?: number;
  failureCause?:
    | "transport-loss"
    | "target-offline"
    | "target-error"
    | "timeout"
    | "capacity-pressure";
  asynchronous: boolean;
  status: "ok" | "degraded" | "dropped";
}

export const runSubmissionSchema = z.object({
  scenario: scenarioSchema,
  architecture: architectureSchema,
  clientEngineVersion: z.string().min(1).max(40),
  sharedScenarioId: z.uuid().optional(),
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

export const AI_ASSISTANT_CONTRACT_VERSION = 1 as const;

export const AI_ASSISTANT_PROMPT_VERSION = "systemforge-ai-v1" as const;

export const AI_ASSISTANT_TASKS = [
  "compile-requirements",
  "author-scenario",
  "debrief-run",
  "conduct-interview",
] as const;

export type AiAssistantTask = (typeof AI_ASSISTANT_TASKS)[number];

export interface AiAssistantProviderEvidence {
  id: "openai-responses" | "cloudflare-workers-ai-responses";
  model: string;
}

export interface AiAssistantCapabilities {
  contractVersion: typeof AI_ASSISTANT_CONTRACT_VERSION;
  enabled: boolean;
  tasks: AiAssistantTask[];
  provider: Pick<AiAssistantProviderEvidence, "id"> | null;
  boundaries: string[];
}

export interface AiEvidenceFact {
  id: string;
  label: string;
  value: string;
  source: "frame" | "requirement" | "event" | "trace" | "analysis";
}

export const AI_REQUIREMENT_SCOPES = [
  "custom-public",
  "interview-public",
  "interview-private",
  "candidate-derived",
] as const;

export type AiRequirementScope = (typeof AI_REQUIREMENT_SCOPES)[number];

export interface AiRequirementCompileRequest {
  contractVersion: typeof AI_ASSISTANT_CONTRACT_VERSION;
  sourceText: string;
  scope: AiRequirementScope;
  context: { scenario: Scenario; architecture: Architecture };
}

export interface AiScenarioCompileRequest {
  contractVersion: typeof AI_ASSISTANT_CONTRACT_VERSION;
  sourceText: string;
  mode: "custom" | "interview";
  baseScenario: Scenario;
  architecture: Architecture;
}

export interface AiRunDebriefRequest {
  contractVersion: typeof AI_ASSISTANT_CONTRACT_VERSION;
  runId: string;
  focus?: string;
}

export interface AiInterviewTurnRequest {
  contractVersion: typeof AI_ASSISTANT_CONTRACT_VERSION;
  scenario: Scenario;
  architecture: Architecture;
  candidateNotes: string;
  candidatePhase: string;
  previousQuestions: string[];
  focus?: string;
}

export interface AiDebriefObservation {
  finding: string;
  evidenceIds: string[];
}

interface AiAssistantResponseBase {
  contractVersion: typeof AI_ASSISTANT_CONTRACT_VERSION;
  promptVersion: typeof AI_ASSISTANT_PROMPT_VERSION;
  provider: AiAssistantProviderEvidence;
  assumptions: string[];
  boundary: string;
}

export interface AiRequirementCompileResponse extends AiAssistantResponseBase {
  task: "compile-requirements";
  requirements: Requirement[];
  unresolvedQuestions: string[];
}

export interface AiScenarioChange {
  path: string;
  provenance: "quoted-source" | "ai-wording" | "retained-base";
}

export interface AiScenarioCompileResponse extends AiAssistantResponseBase {
  task: "author-scenario";
  scenario: Scenario;
  changes: AiScenarioChange[];
  unresolvedQuestions: string[];
}

export interface AiRunDebriefResponse extends AiAssistantResponseBase {
  task: "debrief-run";
  runId: string;
  engineVersion: string;
  digest: string;
  privacyScope: "public" | "interviewer";
  headline: string;
  observations: AiDebriefObservation[];
  nextTests: string[];
  evidence: AiEvidenceFact[];
}

export interface AiInterviewTurnResponse extends AiAssistantResponseBase {
  task: "conduct-interview";
  question: string;
  purpose: string;
}

export function candidateScenario(
  scenario: Scenario,
  revealHiddenRequirements = false,
): Scenario {
  return {
    ...scenario,
    requirements:
      scenario.mode === "interview" && revealHiddenRequirements
        ? scenario.requirements.map((requirement) =>
            requirement.visibility === "hidden"
              ? { ...requirement, visibility: "public" as const }
              : requirement,
          )
        : scenario.requirements.filter(
            (requirement) => requirement.visibility !== "hidden",
          ),
    interview:
      scenario.mode === "interview" && scenario.interview
        ? { ...scenario.interview, interviewerBrief: "" }
        : undefined,
  };
}
