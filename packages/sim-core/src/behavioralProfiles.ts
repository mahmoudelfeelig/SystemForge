import {
  architectureNodeSchema,
  type Architecture,
  type ArchitectureNode,
  type BehavioralProfileProvenance,
  type NodeBehavior,
  type NodeBehavioralProfileEvidence,
} from "@systemforge/contracts";

type ComponentKind = ArchitectureNode["kind"];

export type BehavioralProfileConfig = Partial<
  Omit<ArchitectureNode["config"], "behavior" | "behavioralProfile">
> & {
  behavior?: NodeBehavior;
};

export interface BehavioralProfile {
  readonly id: string;
  readonly version: number;
  readonly family: "PostgreSQL" | "Redis" | "Kafka" | "RabbitMQ" | "DynamoDB";
  readonly label: string;
  readonly provider: "Open-source baseline" | "SystemForge baseline" | "AWS";
  readonly variant: string;
  readonly summary: string;
  readonly compatibleKinds: readonly ComponentKind[];
  readonly config: Readonly<BehavioralProfileConfig>;
  readonly assumptions: readonly string[];
  readonly provenance: readonly BehavioralProfileProvenance[];
}

const RETRIEVED_ON = "2026-08-09";

const source = (
  publisher: string,
  title: string,
  url: string,
): BehavioralProfileProvenance => ({
  publisher,
  title,
  url,
  retrievedOn: RETRIEVED_ON,
  scope: "vendor-characteristics",
});

const commonAssumptions = [
  "Primitive capacities are deterministic SystemForge modeling inputs, not a benchmark, provider quota, SLA, or sizing recommendation.",
  "Workload shape, data model, client behavior, deployment topology, software version, and tuning can materially change observed performance.",
] as const;

export const BEHAVIORAL_PROFILES = [
  {
    id: "postgresql.community-balanced",
    version: 1,
    family: "PostgreSQL",
    label: "PostgreSQL · community balanced",
    provider: "Open-source baseline",
    variant: "16 / balanced baseline",
    summary:
      "A self-managed relational baseline with bounded connections, buffer-cache effects, asynchronous replication, and explicit failover delay.",
    compatibleKinds: ["database"],
    config: {
      instances: 1,
      maxInstances: 1,
      autoscale: false,
      capacityRps: 12_000,
      baseLatencyMs: 8,
      maxConnections: 500,
      replicas: 1,
      consistency: "strong",
      behavior: {
        compute: {
          cpuCores: 8,
          memoryGb: 32,
          concurrencyPerInstance: 500,
          serviceTimeMs: 6,
        },
        network: { bandwidthMbps: 10_000, rttMs: 1.5, jitterMs: 0.4 },
        storage: {
          readIops: 40_000,
          writeIops: 15_000,
          diskThroughputMbps: 1_000,
          bufferHitRate: 0.9,
          lockContention: 0.03,
          partitions: 1,
          hotPartitionFraction: 0.02,
          replicationMode: "async",
          replicationLagMs: 100,
          failoverSeconds: 30,
        },
        resilience: {
          timeoutMs: 800,
          maxRetries: 1,
          backoffBaseMs: 100,
          jitter: true,
          circuitBreaker: true,
          loadSheddingThreshold: 0.9,
        },
        operations: { complexityWeight: 7, managed: false },
      },
    },
    assumptions: [
      ...commonAssumptions,
      "The model treats one database node as one primary plus its authored replicas; it does not emulate PostgreSQL query planning, WAL, locks, or vacuum.",
    ],
    provenance: [
      source(
        "PostgreSQL Global Development Group",
        "PostgreSQL resource consumption configuration",
        "https://www.postgresql.org/docs/current/runtime-config-resource.html",
      ),
    ],
  },
  {
    id: "aws.rds-postgresql.db-r7g-large",
    version: 1,
    family: "PostgreSQL",
    label: "AWS RDS PostgreSQL · db.r7g.large",
    provider: "AWS",
    variant: "db.r7g.large / Multi-AZ assumption",
    summary:
      "A managed PostgreSQL shape with memory-oriented compute, bounded storage throughput, synchronous durability pressure, and managed failover assumptions.",
    compatibleKinds: ["database"],
    config: {
      instances: 1,
      maxInstances: 1,
      autoscale: false,
      capacityRps: 8_000,
      baseLatencyMs: 10,
      maxConnections: 700,
      replicas: 1,
      consistency: "strong",
      behavior: {
        compute: {
          cpuCores: 2,
          memoryGb: 16,
          concurrencyPerInstance: 700,
          serviceTimeMs: 8,
        },
        network: { bandwidthMbps: 5_000, rttMs: 2, jitterMs: 0.7 },
        storage: {
          readIops: 12_000,
          writeIops: 8_000,
          diskThroughputMbps: 500,
          bufferHitRate: 0.92,
          lockContention: 0.025,
          partitions: 1,
          hotPartitionFraction: 0.02,
          replicationMode: "sync",
          replicationLagMs: 8,
          failoverSeconds: 60,
        },
        resilience: {
          timeoutMs: 1_000,
          maxRetries: 1,
          backoffBaseMs: 150,
          jitter: true,
          circuitBreaker: true,
          loadSheddingThreshold: 0.88,
        },
        operations: { complexityWeight: 3.5, managed: true },
      },
    },
    assumptions: [
      ...commonAssumptions,
      "The db.r7g.large name and PostgreSQL support come from AWS documentation; modeled throughput, latency, storage, and failover values are conservative aggregate assumptions, not published guarantees.",
      "Multi-AZ is assumed for the replication and failover primitives but is not implied by selecting the AWS instance class alone.",
    ],
    provenance: [
      source(
        "Amazon Web Services",
        "Supported DB engines for DB instance classes",
        "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.DBInstanceClass.Support.html",
      ),
      source(
        "Amazon Web Services",
        "Amazon RDS for PostgreSQL",
        "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html",
      ),
    ],
  },
  {
    id: "redis.community-balanced",
    version: 1,
    family: "Redis",
    label: "Redis · community balanced",
    provider: "Open-source baseline",
    variant: "7 / memory-cache baseline",
    summary:
      "An in-memory cache baseline with finite memory, LFU eviction, hot-key pressure, asynchronous replication, and warm-up behavior.",
    compatibleKinds: ["cache"],
    config: {
      instances: 2,
      maxInstances: 2,
      autoscale: false,
      capacityRps: 55_000,
      baseLatencyMs: 1.2,
      maxConnections: 50_000,
      cacheHitRate: 0.9,
      replicas: 1,
      behavior: {
        compute: { cpuCores: 4, memoryGb: 16, serviceTimeMs: 0.8 },
        network: { bandwidthMbps: 5_000, rttMs: 0.8, jitterMs: 0.2 },
        cache: {
          capacityGb: 14,
          ttlSeconds: 300,
          evictionPolicy: "lfu",
          hotKeyFraction: 0.03,
          warmupSeconds: 15,
        },
        storage: {
          replicationMode: "async",
          failoverSeconds: 20,
        },
        operations: { complexityWeight: 5, managed: false },
      },
    },
    assumptions: [
      ...commonAssumptions,
      "The aggregate cache model does not emulate Redis command complexity, persistence modes, cluster-slot migration, or allocator fragmentation.",
    ],
    provenance: [
      source(
        "Redis",
        "Redis memory optimization",
        "https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/",
      ),
    ],
  },
  {
    id: "aws.elasticache-redis.cache-r7g-large",
    version: 1,
    family: "Redis",
    label: "AWS ElastiCache Redis OSS · cache.r7g.large",
    provider: "AWS",
    variant: "cache.r7g.large / replication-group assumption",
    summary:
      "A managed Redis-compatible cache shape using the documented memory and baseline-network envelope with explicit cache and failover primitives.",
    compatibleKinds: ["cache"],
    config: {
      instances: 2,
      maxInstances: 2,
      autoscale: false,
      capacityRps: 70_000,
      baseLatencyMs: 1.5,
      maxConnections: 65_000,
      cacheHitRate: 0.92,
      replicas: 1,
      behavior: {
        compute: { cpuCores: 2, memoryGb: 13.07, serviceTimeMs: 0.7 },
        network: { bandwidthMbps: 937, rttMs: 1, jitterMs: 0.3 },
        cache: {
          capacityGb: 10.5,
          ttlSeconds: 300,
          evictionPolicy: "lfu",
          hotKeyFraction: 0.025,
          warmupSeconds: 12,
        },
        storage: {
          replicationMode: "async",
          failoverSeconds: 25,
        },
        operations: { complexityWeight: 2.5, managed: true },
      },
    },
    assumptions: [
      ...commonAssumptions,
      "AWS documents 13.07 GiB memory and 0.937 Gbps baseline bandwidth for cache.r7g.large; usable cache capacity is reduced here as a modeling allowance for engine and allocator overhead.",
      "A replication group is assumed for the replica and failover primitives; node type selection alone does not create that topology.",
    ],
    provenance: [
      source(
        "Amazon Web Services",
        "Supported ElastiCache node types",
        "https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/CacheNodes.SupportedTypes.html",
      ),
    ],
  },
  {
    id: "kafka.community-balanced",
    version: 1,
    family: "Kafka",
    label: "Apache Kafka · community balanced",
    provider: "Open-source baseline",
    variant: "3-broker / 24-partition baseline",
    summary:
      "A replicated append-log baseline with partitioned throughput, batching, retention, at-least-once delivery, and quorum failover behavior.",
    compatibleKinds: ["stream", "queue"],
    config: {
      instances: 3,
      maxInstances: 3,
      autoscale: false,
      capacityRps: 22_000,
      baseLatencyMs: 7,
      maxConnections: 20_000,
      replicas: 2,
      behavior: {
        compute: { cpuCores: 8, memoryGb: 32, serviceTimeMs: 3.5 },
        network: { bandwidthMbps: 10_000, rttMs: 1.5, jitterMs: 0.5 },
        storage: {
          readIops: 25_000,
          writeIops: 25_000,
          diskThroughputMbps: 1_200,
          replicationMode: "quorum",
          failoverSeconds: 15,
        },
        messaging: {
          partitions: 24,
          delivery: "at-least-once",
          retentionHours: 72,
          poisonMessageRate: 0.000_01,
          batchSize: 200,
        },
        operations: { complexityWeight: 8, managed: false },
      },
    },
    assumptions: [
      ...commonAssumptions,
      "The queue/stream primitive does not emulate Kafka ISR changes, consumer-group rebalances, compaction, controller behavior, or per-partition ordering.",
    ],
    provenance: [
      source(
        "Apache Software Foundation",
        "Apache Kafka broker configuration",
        "https://kafka.apache.org/documentation/#brokerconfigs",
      ),
    ],
  },
  {
    id: "aws.msk-provisioned.kafka-m5-large",
    version: 1,
    family: "Kafka",
    label: "AWS MSK Provisioned · kafka.m5.large",
    provider: "AWS",
    variant: "3 × kafka.m5.large / Standard brokers",
    summary:
      "A managed three-broker Kafka shape with explicit partition, network, disk, replication, retention, and recovery inputs.",
    compatibleKinds: ["stream", "queue"],
    config: {
      instances: 3,
      maxInstances: 3,
      autoscale: false,
      capacityRps: 18_000,
      baseLatencyMs: 8,
      maxConnections: 15_000,
      replicas: 2,
      behavior: {
        compute: { cpuCores: 2, memoryGb: 8, serviceTimeMs: 4 },
        network: { bandwidthMbps: 1_000, rttMs: 2, jitterMs: 0.7 },
        storage: {
          readIops: 16_000,
          writeIops: 16_000,
          diskThroughputMbps: 750,
          replicationMode: "quorum",
          failoverSeconds: 20,
        },
        messaging: {
          partitions: 24,
          delivery: "at-least-once",
          retentionHours: 72,
          poisonMessageRate: 0.000_01,
          batchSize: 200,
        },
        operations: { complexityWeight: 4.5, managed: true },
      },
    },
    assumptions: [
      ...commonAssumptions,
      "AWS documents kafka.m5.large as an MSK Standard broker option; throughput, connection, storage, latency, and recovery values remain SystemForge assumptions.",
      "The profile assumes three brokers and authored EBS capacity; selecting a broker type alone does not establish partition count, replication, or retention.",
    ],
    provenance: [
      source(
        "Amazon Web Services",
        "Amazon MSK broker types",
        "https://docs.aws.amazon.com/msk/latest/developerguide/broker-instance-types.html",
      ),
      source(
        "Amazon Web Services",
        "Best practices for MSK Standard brokers",
        "https://docs.aws.amazon.com/msk/latest/developerguide/bestpractices.html",
      ),
    ],
  },
  {
    id: "rabbitmq.community-quorum",
    version: 1,
    family: "RabbitMQ",
    label: "RabbitMQ · quorum queue",
    provider: "Open-source baseline",
    variant: "3-node / quorum baseline",
    summary:
      "A quorum-queue baseline with replicated storage, bounded connections, acknowledgement-oriented delivery, batching, and leader recovery.",
    compatibleKinds: ["queue"],
    config: {
      instances: 3,
      maxInstances: 3,
      autoscale: false,
      capacityRps: 8_000,
      baseLatencyMs: 5,
      maxConnections: 12_000,
      replicas: 2,
      behavior: {
        compute: { cpuCores: 4, memoryGb: 16, serviceTimeMs: 3 },
        network: { bandwidthMbps: 5_000, rttMs: 1.5, jitterMs: 0.5 },
        storage: {
          readIops: 12_000,
          writeIops: 12_000,
          diskThroughputMbps: 500,
          replicationMode: "quorum",
          failoverSeconds: 12,
        },
        messaging: {
          partitions: 1,
          delivery: "at-least-once",
          retentionHours: 24,
          poisonMessageRate: 0.000_02,
          batchSize: 64,
        },
        operations: { complexityWeight: 7, managed: false },
      },
    },
    assumptions: [
      ...commonAssumptions,
      "One SystemForge queue node represents an aggregate quorum queue workload; it does not emulate RabbitMQ channels, exchanges, flow control, Raft log behavior, or per-queue hot spots.",
    ],
    provenance: [
      source(
        "Broadcom",
        "RabbitMQ quorum queues",
        "https://www.rabbitmq.com/docs/quorum-queues",
      ),
    ],
  },
  {
    id: "aws.amazon-mq-rabbitmq.mq-m5-large",
    version: 1,
    family: "RabbitMQ",
    label: "AWS Amazon MQ RabbitMQ · mq.m5.large",
    provider: "AWS",
    variant: "mq.m5.large / active-standby assumption",
    summary:
      "A managed RabbitMQ broker shape with explicit resource, delivery, replicated-storage, and failover behavior.",
    compatibleKinds: ["queue"],
    config: {
      instances: 2,
      maxInstances: 2,
      autoscale: false,
      capacityRps: 6_000,
      baseLatencyMs: 7,
      maxConnections: 8_000,
      replicas: 1,
      behavior: {
        compute: { cpuCores: 2, memoryGb: 8, serviceTimeMs: 4 },
        network: { bandwidthMbps: 1_000, rttMs: 2, jitterMs: 0.7 },
        storage: {
          readIops: 8_000,
          writeIops: 8_000,
          diskThroughputMbps: 350,
          replicationMode: "sync",
          failoverSeconds: 45,
        },
        messaging: {
          partitions: 1,
          delivery: "at-least-once",
          retentionHours: 24,
          poisonMessageRate: 0.000_02,
          batchSize: 64,
        },
        operations: { complexityWeight: 3, managed: true },
      },
    },
    assumptions: [
      ...commonAssumptions,
      "AWS documents mq.m5.large as a RabbitMQ broker instance type; SystemForge supplies the throughput, resource, storage, latency, and recovery values as aggregate assumptions.",
      "A redundant broker deployment is assumed for replication and failover; an instance type by itself does not establish redundancy.",
    ],
    provenance: [
      source(
        "Amazon Web Services",
        "Amazon MQ for RabbitMQ broker instance types",
        "https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rmq-broker-instance-types.html",
      ),
    ],
  },
  {
    id: "dynamodb.logical-table-balanced",
    version: 1,
    family: "DynamoDB",
    label: "DynamoDB · logical table baseline",
    provider: "SystemForge baseline",
    variant: "single-region / balanced request units",
    summary:
      "A logical DynamoDB-style table baseline with partition pressure, eventual replication, managed operations, and an aggregate request-unit envelope.",
    compatibleKinds: ["database"],
    config: {
      instances: 1,
      maxInstances: 1,
      autoscale: false,
      capacityRps: 40_000,
      baseLatencyMs: 7,
      maxConnections: 1_000_000,
      replicas: 2,
      consistency: "eventual",
      behavior: {
        compute: {
          cpuCores: 64,
          memoryGb: 256,
          concurrencyPerInstance: 1_000_000,
          serviceTimeMs: 5,
        },
        network: { bandwidthMbps: 50_000, rttMs: 2, jitterMs: 0.8 },
        storage: {
          readIops: 40_000,
          writeIops: 20_000,
          diskThroughputMbps: 5_000,
          bufferHitRate: 0.99,
          lockContention: 0,
          partitions: 32,
          hotPartitionFraction: 0.04,
          replicationMode: "async",
          replicationLagMs: 20,
          failoverSeconds: 5,
        },
        operations: { complexityWeight: 2.5, managed: true },
      },
    },
    assumptions: [
      ...commonAssumptions,
      "The relational database primitive is reused as an aggregate key-value table envelope; it does not emulate DynamoDB request-unit metering, adaptive capacity, indexes, transactions, or item-size rounding.",
    ],
    provenance: [
      source(
        "Amazon Web Services",
        "DynamoDB read and write operations",
        "https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/read-write-operations.html",
      ),
    ],
  },
  {
    id: "aws.dynamodb.standard-on-demand",
    version: 1,
    family: "DynamoDB",
    label: "AWS DynamoDB · Standard on-demand",
    provider: "AWS",
    variant: "Standard table class / on-demand mode",
    summary:
      "A managed on-demand DynamoDB table approximation with fast aggregate scaling, partition pressure, request-unit semantics, and no operator-managed instances.",
    compatibleKinds: ["database"],
    config: {
      instances: 1,
      maxInstances: 128,
      autoscale: true,
      capacityRps: 50_000,
      baseLatencyMs: 6,
      maxConnections: 1_000_000,
      replicas: 2,
      consistency: "eventual",
      behavior: {
        compute: {
          cpuCores: 64,
          memoryGb: 256,
          concurrencyPerInstance: 1_000_000,
          serviceTimeMs: 4,
        },
        network: { bandwidthMbps: 100_000, rttMs: 2, jitterMs: 0.6 },
        storage: {
          readIops: 50_000,
          writeIops: 25_000,
          diskThroughputMbps: 8_000,
          bufferHitRate: 0.99,
          lockContention: 0,
          partitions: 64,
          hotPartitionFraction: 0.03,
          replicationMode: "quorum",
          replicationLagMs: 8,
          failoverSeconds: 3,
        },
        scaling: {
          minInstances: 1,
          targetUtilization: 0.7,
          cooldownSeconds: 1,
          startupSeconds: 1,
        },
        operations: { complexityWeight: 1.5, managed: true },
      },
    },
    assumptions: [
      ...commonAssumptions,
      "AWS describes on-demand as automatically scaling and request-unit billed; SystemForge's instance and autoscaling primitives are only an aggregate approximation of that managed control plane.",
      "The model assumes the Standard table class, single-Region traffic, warm capacity, sub-4 KB reads, sub-1 KB writes, and no user-set maximum throughput cap.",
    ],
    provenance: [
      source(
        "Amazon Web Services",
        "DynamoDB on-demand capacity mode",
        "https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode.html",
      ),
      source(
        "Amazon Web Services",
        "DynamoDB table classes",
        "https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.TableClasses.html",
      ),
    ],
  },
] as const satisfies readonly BehavioralProfile[];

const deepFreeze = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

deepFreeze(BEHAVIORAL_PROFILES);

const profileById = new Map<string, BehavioralProfile>(
  BEHAVIORAL_PROFILES.map((profile) => [profile.id, profile]),
);

const mergedBehavior = (
  current: NodeBehavior | undefined,
  patch: NodeBehavior | undefined,
): NodeBehavior | undefined => {
  if (!patch) return current ? structuredClone(current) : undefined;
  return {
    ...structuredClone(current ?? {}),
    ...structuredClone(patch),
    ...(current?.compute || patch.compute
      ? { compute: { ...current?.compute, ...patch.compute } }
      : {}),
    ...(current?.network || patch.network
      ? { network: { ...current?.network, ...patch.network } }
      : {}),
    ...(current?.cache || patch.cache
      ? { cache: { ...current?.cache, ...patch.cache } }
      : {}),
    ...(current?.storage || patch.storage
      ? { storage: { ...current?.storage, ...patch.storage } }
      : {}),
    ...(current?.messaging || patch.messaging
      ? { messaging: { ...current?.messaging, ...patch.messaging } }
      : {}),
    ...(current?.resilience || patch.resilience
      ? { resilience: { ...current?.resilience, ...patch.resilience } }
      : {}),
    ...(current?.scaling || patch.scaling
      ? { scaling: { ...current?.scaling, ...patch.scaling } }
      : {}),
    ...(current?.topology || patch.topology
      ? { topology: { ...current?.topology, ...patch.topology } }
      : {}),
    ...(current?.operations || patch.operations
      ? { operations: { ...current?.operations, ...patch.operations } }
      : {}),
  };
};

const profileForReference = (node: ArchitectureNode): BehavioralProfile => {
  const reference = node.config.behavioralProfile;
  if (!reference)
    throw new Error(`behavioral_profile_missing_reference:${node.id}`);
  const profile = profileById.get(reference.id);
  if (!profile)
    throw new Error(
      `behavioral_profile_unknown:${reference.id}@${reference.version}:${node.id}`,
    );
  if (reference.version !== profile.version)
    throw new Error(
      `behavioral_profile_version_mismatch:${reference.id}:${reference.version}:${profile.version}:${node.id}`,
    );
  if (!profile.compatibleKinds.includes(node.kind))
    throw new Error(
      `behavioral_profile_incompatible:${reference.id}:${node.kind}:${node.id}`,
    );
  return profile;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const leafPaths = (value: unknown, prefix = "config"): string[] => {
  if (!isRecord(value)) return [prefix];
  return Object.keys(value)
    .sort()
    .flatMap((key) => leafPaths(value[key], `${prefix}.${key}`));
};

const valueAt = (value: unknown, path: string): unknown => {
  let cursor = value;
  for (const segment of path.split(".")) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
};

const samePrimitive = (left: unknown, right: unknown): boolean =>
  Object.is(left, right);

export const getBehavioralProfile = (
  id: string,
): BehavioralProfile | undefined => profileById.get(id);

export const compatibleBehavioralProfiles = (
  kind: ComponentKind,
): readonly BehavioralProfile[] =>
  BEHAVIORAL_PROFILES.filter((profile) =>
    (profile.compatibleKinds as readonly ComponentKind[]).includes(kind),
  );

export const applyBehavioralProfile = (
  node: ArchitectureNode,
  profileId: string,
  expectedVersion?: number,
): ArchitectureNode => {
  const profile = profileById.get(profileId);
  if (!profile)
    throw new Error(`behavioral_profile_unknown:${profileId}:${node.id}`);
  if (expectedVersion !== undefined && expectedVersion !== profile.version)
    throw new Error(
      `behavioral_profile_version_mismatch:${profile.id}:${expectedVersion}:${profile.version}:${node.id}`,
    );
  if (!profile.compatibleKinds.includes(node.kind))
    throw new Error(
      `behavioral_profile_incompatible:${profile.id}:${node.kind}:${node.id}`,
    );
  const retainedPlacement = node.config.behavior?.topology
    ? { topology: structuredClone(node.config.behavior.topology) }
    : undefined;
  const behavior = mergedBehavior(retainedPlacement, profile.config.behavior);
  return architectureNodeSchema.parse({
    ...structuredClone(node),
    config: {
      ...structuredClone(node.config),
      ...structuredClone(profile.config),
      ...(behavior ? { behavior } : {}),
      behavioralProfile: { id: profile.id, version: profile.version },
    },
  });
};

export const behavioralProfileEvidenceForNode = (
  node: ArchitectureNode,
): NodeBehavioralProfileEvidence => {
  if (!node.config.behavioralProfile)
    return {
      nodeId: node.id,
      nodeKind: node.kind,
      status: "unprofiled",
      profileId: null,
      profileVersion: null,
      profileLabel: null,
      assumptions: [],
      provenance: [],
      localOverrides: false,
      overriddenFields: [],
    };
  const profile = profileForReference(node);
  const overriddenFields = leafPaths(profile.config).filter(
    (path) =>
      !samePrimitive(
        valueAt(node, path),
        valueAt({ config: profile.config }, path),
      ),
  );
  return {
    nodeId: node.id,
    nodeKind: node.kind,
    status: "resolved",
    profileId: profile.id,
    profileVersion: profile.version,
    profileLabel: profile.label,
    assumptions: [...profile.assumptions],
    provenance: profile.provenance.map((entry) => ({ ...entry })),
    localOverrides: overriddenFields.length > 0,
    overriddenFields,
  };
};

export const resolveBehavioralProfileEvidence = (
  architecture: Architecture,
): NodeBehavioralProfileEvidence[] =>
  architecture.nodes.map((node) => behavioralProfileEvidenceForNode(node));
