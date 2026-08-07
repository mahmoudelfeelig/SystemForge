import { z } from "zod";

export const COMPONENT_KINDS = [
  "users",
  "cdn",
  "load-balancer",
  "api",
  "cache",
  "database",
  "queue",
  "worker",
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
});

export const incidentSchema = z.object({
  id: z.string().min(1).max(80),
  atSecond: z.number().int().min(0).max(86_400),
  kind: z.enum([
    "traffic-spike",
    "cache-failure",
    "cache-recovery",
    "database-degradation",
    "database-recovery",
    "queue-consumer-slowdown",
  ]),
  magnitude: z.number().positive().max(100).default(1),
  label: z.string().min(1).max(160),
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
    if (scenario.mode === "interview" && !scenario.interview) {
      context.addIssue({
        code: "custom",
        path: ["interview"],
        message: "Interview configuration is required for interview scenarios.",
      });
    }
  });

export type Scenario = z.infer<typeof scenarioSchema>;

export const architectureNodeSchema = z.object({
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
  }),
});

export const architectureEdgeSchema = z.object({
  id: z.string().min(1).max(80),
  source: z.string().min(1).max(80),
  target: z.string().min(1).max(80),
});

export const architectureSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  nodes: z.array(architectureNodeSchema).min(1).max(500),
  edges: z.array(architectureEdgeSchema).max(2_000),
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
  nodeUtilization: Record<string, number>;
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

export function candidateScenario(scenario: Scenario): Scenario {
  if (scenario.mode !== "interview") return scenario;
  return {
    ...scenario,
    requirements: scenario.requirements.filter(
      (requirement) => requirement.visibility !== "hidden",
    ),
    interview: scenario.interview
      ? { ...scenario.interview, interviewerBrief: "" }
      : undefined,
  };
}
