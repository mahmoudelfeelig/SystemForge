import {
  architectureSchema,
  scenarioSchema,
  type Architecture,
  type Scenario,
} from "@systemforge/contracts";
import { DEFAULT_ARCHITECTURE, DEFAULT_SCENARIO } from "@systemforge/sim-core";

export interface ScenarioLibraryEntry {
  id: string;
  domain: string;
  difficulty: "foundation" | "advanced" | "expert";
  scenario: Scenario;
  architecture: Architecture;
}

const architectureFor = (
  id: string,
  name: string,
  transform?: (architecture: Architecture) => void,
): Architecture => {
  const architecture = structuredClone(DEFAULT_ARCHITECTURE);
  architecture.id = id;
  architecture.name = name;
  transform?.(architecture);
  return architectureSchema.parse(architecture);
};

const scenarioFor = (
  scenario: Scenario,
  architecture: Architecture,
): ScenarioLibraryEntry => ({
  id: scenario.id,
  domain:
    scenario.id === "realtime-chat"
      ? "Realtime messaging"
      : scenario.id === "ticket-launch"
        ? "Contention and fairness"
        : scenario.id === "video-processing"
          ? "Asynchronous media"
          : scenario.id === "financial-ledger"
            ? "Correctness and durability"
            : "Commerce resilience",
  difficulty:
    scenario.id === "black-friday-checkout"
      ? "foundation"
      : scenario.id === "realtime-chat" || scenario.id === "video-processing"
        ? "advanced"
        : "expert",
  scenario: scenarioSchema.parse(scenario),
  architecture,
});

const chatArchitecture = architectureFor(
  "realtime-chat-v1",
  "Realtime chat architecture",
  (architecture) => {
    architecture.nodes.find((node) => node.id === "api")!.name =
      "WebSocket Gateway";
    const queue = architecture.nodes.find((node) => node.id === "queue")!;
    queue.name = "Message Stream";
    queue.kind = "stream";
    queue.config.behavior = {
      ...queue.config.behavior,
      messaging: {
        ...queue.config.behavior?.messaging,
        partitions: 64,
        retentionHours: 72,
      },
    };
  },
);

const ticketArchitecture = architectureFor(
  "ticket-launch-v1",
  "Fair ticket allocation architecture",
  (architecture) => {
    const cache = architecture.nodes.find((node) => node.id === "cache")!;
    cache.name = "Availability Cache";
    cache.config.cacheHitRate = 0.78;
    const database = architecture.nodes.find((node) => node.id === "db")!;
    database.name = "Inventory Ledger";
    database.config.consistency = "strong";
  },
);

const mediaArchitecture = architectureFor(
  "video-processing-v1",
  "Video processing pipeline",
  (architecture) => {
    const queue = architecture.nodes.find((node) => node.id === "queue")!;
    queue.name = "Transcode Queue";
    queue.config.behavior = {
      ...queue.config.behavior,
      messaging: {
        ...queue.config.behavior?.messaging,
        partitions: 96,
        retentionHours: 168,
        batchSize: 8,
      },
    };
    const worker = architecture.nodes.find((node) => node.id === "worker")!;
    worker.name = "Transcode Workers";
    worker.config.instances = 48;
    worker.config.maxInstances = 160;
    worker.config.autoscale = true;
  },
);

const ledgerArchitecture = architectureFor(
  "financial-ledger-v1",
  "Multi-zone financial ledger",
  (architecture) => {
    const database = architecture.nodes.find((node) => node.id === "db")!;
    database.name = "Double-entry Ledger";
    database.config.replicas = 3;
    database.config.consistency = "strong";
    database.config.behavior = {
      ...database.config.behavior,
      storage: {
        ...database.config.behavior?.storage,
        replicationMode: "quorum",
        replicationLagMs: 4,
      },
      topology: {
        ...database.config.behavior?.topology,
        zone: "multi-az",
      },
    };
  },
);

const chatScenario: Scenario = {
  ...structuredClone(DEFAULT_SCENARIO),
  id: "realtime-chat",
  title: "Global Realtime Chat",
  summary:
    "Preserve low-latency message delivery through a regional partition and a reconnect storm.",
  seed: 430_211,
  workload: {
    ...structuredClone(DEFAULT_SCENARIO.workload),
    baseRps: 92_000,
    peakRps: 310_000,
    readRatio: 0.62,
    durationSeconds: 150,
    concurrentUsers: 8_500_000,
    arrivalPattern: "bursty",
    requestMix: [
      {
        name: "Receive messages",
        share: 0.52,
        readRatio: 1,
        payloadKb: 2,
        computeMs: 2,
        databaseQueries: 0.2,
        cacheable: false,
        critical: true,
      },
      {
        name: "Send message",
        share: 0.32,
        readRatio: 0,
        payloadKb: 3,
        computeMs: 5,
        databaseQueries: 1,
        cacheable: false,
        critical: true,
      },
      {
        name: "Presence update",
        share: 0.16,
        readRatio: 0.3,
        payloadKb: 1,
        computeMs: 2,
        databaseQueries: 0.2,
        cacheable: true,
        critical: false,
      },
    ],
  },
  requirements: [
    {
      id: "chat-p95",
      label: "Message p95 at or below 180 ms",
      metric: "p95LatencyMs",
      operator: "lte",
      target: 180,
      unit: "ms",
      visibility: "public",
      owner: "scenario",
    },
    {
      id: "chat-availability",
      label: "Availability at or above 99.95%",
      metric: "availability",
      operator: "gte",
      target: 99.95,
      unit: "%",
      visibility: "public",
      owner: "scenario",
    },
    {
      id: "chat-queue",
      label: "Oldest message below 5 seconds",
      metric: "maxQueueAgeMs",
      operator: "lte",
      target: 5_000,
      unit: "ms",
      visibility: "public",
      owner: "scenario",
    },
  ],
  incidents: [
    {
      id: "partition",
      atSecond: 38,
      kind: "network-partition",
      magnitude: 1,
      durationSeconds: 38,
      region: "Europe",
      label: "Regional partition",
    },
    {
      id: "reconnect",
      atSecond: 78,
      kind: "thundering-herd",
      magnitude: 3.4,
      durationSeconds: 30,
      label: "Client reconnect storm",
    },
  ],
};

const ticketScenario: Scenario = {
  ...structuredClone(DEFAULT_SCENARIO),
  id: "ticket-launch",
  title: "Stadium Ticket Launch",
  summary:
    "Allocate limited inventory fairly while bots, lock contention and retries converge on one release window.",
  seed: 991_404,
  workload: {
    ...structuredClone(DEFAULT_SCENARIO.workload),
    baseRps: 28_000,
    peakRps: 640_000,
    readRatio: 0.58,
    durationSeconds: 135,
    concurrentUsers: 4_200_000,
    requestMix: [
      {
        name: "Browse seats",
        share: 0.5,
        readRatio: 1,
        payloadKb: 22,
        computeMs: 4,
        databaseQueries: 2,
        cacheable: true,
        critical: false,
      },
      {
        name: "Hold seat",
        share: 0.3,
        readRatio: 0.1,
        payloadKb: 4,
        computeMs: 12,
        databaseQueries: 5,
        cacheable: false,
        critical: true,
      },
      {
        name: "Confirm purchase",
        share: 0.2,
        readRatio: 0,
        payloadKb: 8,
        computeMs: 18,
        databaseQueries: 7,
        cacheable: false,
        critical: true,
      },
    ],
  },
  requirements: [
    {
      id: "no-oversell",
      label: "No inventory consistency violations",
      metric: "consistencyViolations",
      operator: "eq",
      target: 0,
      unit: "seats",
      visibility: "public",
      owner: "scenario",
    },
    {
      id: "ticket-p99",
      label: "p99 latency at or below 900 ms",
      metric: "p99LatencyMs",
      operator: "lte",
      target: 900,
      unit: "ms",
      visibility: "public",
      owner: "scenario",
    },
    {
      id: "ticket-errors",
      label: "Error rate at or below 1%",
      metric: "errorRate",
      operator: "lte",
      target: 1,
      unit: "%",
      visibility: "public",
      owner: "scenario",
    },
  ],
  incidents: [
    {
      id: "bot-wave",
      atSecond: 18,
      kind: "bot-attack",
      magnitude: 5.8,
      durationSeconds: 72,
      label: "Automated buyer wave",
    },
    {
      id: "locks",
      atSecond: 44,
      kind: "database-lock-contention",
      magnitude: 3.6,
      durationSeconds: 40,
      targetId: "db",
      label: "Inventory lock contention",
    },
    {
      id: "retry",
      atSecond: 63,
      kind: "retry-storm",
      magnitude: 2.7,
      durationSeconds: 28,
      label: "Checkout retries amplify",
    },
  ],
  domain: {
    acknowledgedWritesMustSurvive: true,
    preventOversell: true,
    maximumRecoverySeconds: 45,
  },
};

const mediaScenario: Scenario = {
  ...structuredClone(DEFAULT_SCENARIO),
  id: "video-processing",
  title: "Creator Video Pipeline",
  summary:
    "Absorb a large upload burst while poison jobs and slow consumers pressure asynchronous processing.",
  seed: 125_870,
  workload: {
    ...structuredClone(DEFAULT_SCENARIO.workload),
    baseRps: 3_200,
    peakRps: 18_000,
    readRatio: 0.24,
    durationSeconds: 180,
    concurrentUsers: 750_000,
    requestMix: [
      {
        name: "Upload video",
        share: 0.28,
        readRatio: 0,
        payloadKb: 380_000,
        computeMs: 18,
        databaseQueries: 2,
        cacheable: false,
        critical: true,
      },
      {
        name: "Poll status",
        share: 0.46,
        readRatio: 1,
        payloadKb: 2,
        computeMs: 2,
        databaseQueries: 1,
        cacheable: true,
        critical: false,
      },
      {
        name: "Fetch playback",
        share: 0.26,
        readRatio: 1,
        payloadKb: 48,
        computeMs: 4,
        databaseQueries: 1,
        cacheable: true,
        critical: true,
      },
    ],
  },
  requirements: [
    {
      id: "media-age",
      label: "Oldest job below 90 seconds",
      metric: "maxQueueAgeMs",
      operator: "lte",
      target: 90_000,
      unit: "ms",
      visibility: "public",
      owner: "scenario",
    },
    {
      id: "media-loss",
      label: "No accepted upload loss",
      metric: "dataLoss",
      operator: "eq",
      target: 0,
      unit: "uploads",
      visibility: "public",
      owner: "scenario",
    },
    {
      id: "media-cost",
      label: "Monthly cost below EUR 190,000",
      metric: "monthlyCostEur",
      operator: "lte",
      target: 190_000,
      unit: "EUR",
      visibility: "public",
      owner: "scenario",
    },
  ],
  incidents: [
    {
      id: "upload-wave",
      atSecond: 24,
      kind: "large-payload",
      magnitude: 4.2,
      durationSeconds: 60,
      label: "Creator upload wave",
    },
    {
      id: "poison",
      atSecond: 58,
      kind: "poison-message",
      magnitude: 2.2,
      durationSeconds: 36,
      targetId: "queue",
      label: "Malformed transcode jobs",
    },
    {
      id: "consumer",
      atSecond: 96,
      kind: "queue-consumer-slowdown",
      magnitude: 3.2,
      durationSeconds: 42,
      targetId: "worker",
      label: "GPU consumer slowdown",
    },
  ],
};

const ledgerScenario: Scenario = {
  ...structuredClone(DEFAULT_SCENARIO),
  id: "financial-ledger",
  title: "Regional Financial Ledger",
  summary:
    "Preserve double-entry correctness and acknowledged writes through leader loss and cross-zone lag.",
  seed: 708_303,
  workload: {
    ...structuredClone(DEFAULT_SCENARIO.workload),
    baseRps: 18_000,
    peakRps: 44_000,
    readRatio: 0.36,
    durationSeconds: 165,
    concurrentUsers: 1_100_000,
    requestMix: [
      {
        name: "Post transfer",
        share: 0.44,
        readRatio: 0,
        payloadKb: 4,
        computeMs: 16,
        databaseQueries: 8,
        cacheable: false,
        critical: true,
      },
      {
        name: "Read balance",
        share: 0.38,
        readRatio: 1,
        payloadKb: 3,
        computeMs: 5,
        databaseQueries: 2,
        cacheable: false,
        critical: true,
      },
      {
        name: "Export statement",
        share: 0.18,
        readRatio: 1,
        payloadKb: 80,
        computeMs: 22,
        databaseQueries: 12,
        cacheable: false,
        critical: false,
      },
    ],
  },
  requirements: [
    {
      id: "ledger-loss",
      label: "No acknowledged transfer loss",
      metric: "dataLoss",
      operator: "eq",
      target: 0,
      unit: "transfers",
      visibility: "public",
      owner: "scenario",
    },
    {
      id: "ledger-consistency",
      label: "No ledger consistency violations",
      metric: "consistencyViolations",
      operator: "eq",
      target: 0,
      unit: "entries",
      visibility: "public",
      owner: "scenario",
    },
    {
      id: "ledger-rto",
      label: "Recovery within 30 seconds",
      metric: "recoveryTimeSeconds",
      operator: "lte",
      target: 30,
      unit: "seconds",
      visibility: "public",
      owner: "scenario",
    },
    {
      id: "ledger-durability",
      label: "Durability at or above 99.9999%",
      metric: "durabilityPercent",
      operator: "gte",
      target: 99.9999,
      unit: "%",
      visibility: "public",
      owner: "scenario",
    },
  ],
  incidents: [
    {
      id: "lag",
      atSecond: 35,
      kind: "replication-lag",
      magnitude: 4,
      durationSeconds: 36,
      targetId: "db",
      label: "Cross-zone replica lag",
    },
    {
      id: "leader",
      atSecond: 76,
      kind: "leader-election",
      magnitude: 1,
      durationSeconds: 24,
      targetId: "db",
      label: "Ledger leader election",
    },
    {
      id: "partition",
      atSecond: 112,
      kind: "network-partition",
      magnitude: 1,
      durationSeconds: 30,
      label: "Zone isolation",
    },
  ],
  domain: {
    acknowledgedWritesMustSurvive: true,
    preventOversell: true,
    piiRegion: "EU",
    staleReadToleranceSeconds: 0,
    maximumRecoverySeconds: 30,
  },
};

export const SCENARIO_LIBRARY: ScenarioLibraryEntry[] = [
  scenarioFor(
    structuredClone(DEFAULT_SCENARIO),
    structuredClone(DEFAULT_ARCHITECTURE),
  ),
  scenarioFor(chatScenario, chatArchitecture),
  scenarioFor(ticketScenario, ticketArchitecture),
  scenarioFor(mediaScenario, mediaArchitecture),
  scenarioFor(ledgerScenario, ledgerArchitecture),
];
