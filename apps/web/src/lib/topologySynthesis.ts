import {
  architectureSchema,
  type Architecture,
  type ArchitectureNode,
  type Scenario,
} from "@systemforge/contracts";

export type TopologyProposalKind =
  "add-cache" | "add-async-lane" | "strengthen-replication";

export interface TopologyProposal {
  id: string;
  kind: TopologyProposalKind;
  title: string;
  rationale: string;
  tradeoff: string;
  affectedNodeIds: string[];
}

const uniqueId = (architecture: Architecture, base: string): string => {
  const ids = new Set(architecture.nodes.map((node) => node.id));
  if (!ids.has(base)) return base;
  let suffix = 2;
  while (ids.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
};

const nodeConfig = (
  overrides: Partial<ArchitectureNode["config"]>,
): ArchitectureNode["config"] => ({
  instances: 1,
  capacityRps: 10_000,
  baseLatencyMs: 5,
  maxConnections: 10_000,
  cacheHitRate: 0,
  replicas: 0,
  monthlyCostEur: 0,
  autoscale: false,
  maxInstances: 1,
  consistency: "strong",
  ...overrides,
});

export function proposeTopologyChanges(
  scenario: Scenario,
  architecture: Architecture,
): TopologyProposal[] {
  const proposals: TopologyProposal[] = [];
  const api = architecture.nodes.find(
    (node) => node.kind === "api" || node.kind === "load-balancer",
  );
  const database = architecture.nodes.find((node) => node.kind === "database");
  if (
    api &&
    database &&
    scenario.workload.readRatio >= 0.55 &&
    !architecture.nodes.some((node) => node.kind === "cache")
  )
    proposals.push({
      id: "assist-add-cache",
      kind: "add-cache",
      title: "Insert a bounded read cache",
      rationale: `${Math.round(scenario.workload.readRatio * 100)}% of modeled traffic is read-oriented and no cache is present.`,
      tradeoff:
        "Reduces repeated storage reads, but introduces invalidation and stale-read policy work.",
      affectedNodeIds: [api.id, database.id],
    });

  const criticalWriteShare =
    scenario.workload.requestMix
      ?.filter((request) => request.critical && request.readRatio < 0.5)
      .reduce((total, request) => total + request.share, 0) ??
    1 - scenario.workload.readRatio;
  if (
    api &&
    database &&
    criticalWriteShare >= 0.12 &&
    !architecture.nodes.some(
      (node) => node.kind === "queue" || node.kind === "stream",
    )
  )
    proposals.push({
      id: "assist-add-async-lane",
      kind: "add-async-lane",
      title: "Add a durable asynchronous lane",
      rationale: `${Math.round(criticalWriteShare * 100)}% of traffic is modeled as critical writes without a queue or stream.`,
      tradeoff:
        "Absorbs bursts and isolates downstream work, but adds eventual completion and poison-message handling.",
      affectedNodeIds: [api.id, database.id],
    });

  if (
    database &&
    database.config.replicas < 2 &&
    scenario.requirements.some(
      (requirement) =>
        requirement.metric === "durabilityPercent" ||
        requirement.metric === "dataLoss" ||
        requirement.metric === "availability",
    )
  )
    proposals.push({
      id: "assist-strengthen-replication",
      kind: "strengthen-replication",
      title: "Strengthen database replication",
      rationale:
        "The mission includes durability or availability objectives while the storage tier has fewer than two replicas.",
      tradeoff:
        "Improves failure tolerance, but raises modeled cost, write coordination and operational complexity.",
      affectedNodeIds: [database.id],
    });
  return proposals;
}

export function applyTopologyProposal(
  inputArchitecture: Architecture,
  proposal: TopologyProposal,
): Architecture {
  const architecture = structuredClone(inputArchitecture);
  const api = architecture.nodes.find(
    (node) => node.kind === "api" || node.kind === "load-balancer",
  );
  const database = architecture.nodes.find((node) => node.kind === "database");
  if (!api || !database)
    throw new Error("Topology assistance requires an API and database node.");

  if (proposal.kind === "add-cache") {
    const id = uniqueId(architecture, "assisted-cache");
    architecture.nodes.push({
      id,
      kind: "cache",
      name: "Assisted Read Cache",
      position: {
        x: (api.position.x + database.position.x) / 2,
        y: Math.min(api.position.y, database.position.y) - 138,
      },
      config: nodeConfig({
        instances: 2,
        maxInstances: 8,
        capacityRps: 60_000,
        baseLatencyMs: 3,
        maxConnections: 80_000,
        cacheHitRate: 0.72,
        replicas: 1,
        monthlyCostEur: 780,
        autoscale: true,
        behavior: {
          cache: {
            capacityGb: 64,
            ttlSeconds: 120,
            evictionPolicy: "lfu",
            hotKeyFraction: 0.03,
            warmupSeconds: 12,
          },
          resilience: {
            timeoutMs: 120,
            maxRetries: 1,
            backoffBaseMs: 25,
            jitter: true,
            circuitBreaker: true,
            loadSheddingThreshold: 0.88,
          },
          topology: { region: "EU", zone: "multi-az" },
          operations: { complexityWeight: 3, managed: true },
        },
      }),
    });
    architecture.edges.push({
      id: `${api.id}-${id}`,
      source: api.id,
      target: id,
      config: { baseLatencyMs: 2, bandwidthMbps: 30_000 },
    });
    architecture.edges.push({
      id: `${id}-${database.id}`,
      source: id,
      target: database.id,
      config: { baseLatencyMs: 3, bandwidthMbps: 20_000 },
    });
  } else if (proposal.kind === "add-async-lane") {
    const queueId = uniqueId(architecture, "assisted-queue");
    const workerId = uniqueId(architecture, "assisted-worker");
    architecture.nodes.push(
      {
        id: queueId,
        kind: "queue",
        name: "Assisted Durable Queue",
        position: { x: api.position.x + 160, y: api.position.y + 170 },
        config: nodeConfig({
          instances: 3,
          maxInstances: 12,
          capacityRps: 45_000,
          baseLatencyMs: 5,
          replicas: 2,
          monthlyCostEur: 1_240,
          autoscale: true,
          behavior: {
            messaging: {
              partitions: 32,
              delivery: "at-least-once",
              retentionHours: 72,
              poisonMessageRate: 0,
              batchSize: 32,
            },
            topology: { region: "EU", zone: "multi-az" },
            operations: { complexityWeight: 5, managed: true },
          },
        }),
      },
      {
        id: workerId,
        kind: "worker",
        name: "Assisted Consumers",
        position: { x: api.position.x + 350, y: api.position.y + 170 },
        config: nodeConfig({
          instances: 8,
          maxInstances: 48,
          capacityRps: 8_000,
          baseLatencyMs: 16,
          monthlyCostEur: 420,
          autoscale: true,
          behavior: {
            compute: {
              cpuCores: 4,
              memoryGb: 8,
              concurrencyPerInstance: 2_000,
              serviceTimeMs: 18,
            },
            scaling: {
              minInstances: 4,
              targetUtilization: 0.65,
              cooldownSeconds: 10,
              startupSeconds: 6,
            },
            operations: { complexityWeight: 4, managed: false },
          },
        }),
      },
    );
    architecture.edges.push(
      {
        id: `${api.id}-${queueId}`,
        source: api.id,
        target: queueId,
        config: { asynchronous: true, baseLatencyMs: 3 },
      },
      {
        id: `${queueId}-${workerId}`,
        source: queueId,
        target: workerId,
        config: { asynchronous: true, baseLatencyMs: 3 },
      },
      {
        id: `${workerId}-${database.id}`,
        source: workerId,
        target: database.id,
        config: { baseLatencyMs: 5 },
      },
    );
  } else {
    database.config.replicas = Math.max(2, database.config.replicas);
    database.config.monthlyCostEur = Math.round(
      database.config.monthlyCostEur * 1.45,
    );
    database.config.behavior = {
      ...database.config.behavior,
      storage: {
        ...database.config.behavior?.storage,
        replicationMode: "quorum",
        replicationLagMs: Math.min(
          database.config.behavior?.storage?.replicationLagMs ?? 20,
          20,
        ),
      },
      topology: {
        ...database.config.behavior?.topology,
        zone: "multi-az",
      },
      operations: {
        ...database.config.behavior?.operations,
        complexityWeight:
          (database.config.behavior?.operations?.complexityWeight ?? 2) + 2,
      },
    };
  }
  architecture.id = `${architecture.id}-${proposal.kind}`.slice(0, 80);
  architecture.name = `${architecture.name} · assisted`;
  return architectureSchema.parse(architecture);
}
