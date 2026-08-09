import { architectureSchema } from "@systemforge/contracts";
import { describe, expect, it } from "vitest";
import {
  applyBehavioralProfile,
  BEHAVIORAL_PROFILES,
  behavioralProfileEvidenceForNode,
  compatibleBehavioralProfiles,
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  simulate,
} from "../src";

const databaseNode = () =>
  structuredClone(DEFAULT_ARCHITECTURE.nodes.find((node) => node.id === "db")!);

describe("versioned behavioral-profile registry", () => {
  it("covers every required technology with community and credible provider variants", () => {
    for (const family of [
      "PostgreSQL",
      "Redis",
      "Kafka",
      "RabbitMQ",
      "DynamoDB",
    ] as const) {
      const entries = BEHAVIORAL_PROFILES.filter(
        (profile) => profile.family === family,
      );
      expect(entries.some((profile) => profile.provider !== "AWS")).toBe(true);
      expect(entries.some((profile) => profile.provider === "AWS")).toBe(true);
      expect(
        entries.every(
          (profile) =>
            Object.keys(profile.config).length > 3 &&
            profile.assumptions.length >= 3 &&
            profile.provenance.length > 0,
        ),
      ).toBe(true);
    }
    expect(Object.isFrozen(BEHAVIORAL_PROFILES)).toBe(true);
    expect(Object.isFrozen(BEHAVIORAL_PROFILES[0]?.config.behavior)).toBe(true);
  });

  it("applies validated primitive behavior and retains unrelated placement", () => {
    const original = databaseNode();
    original.config.behavior = {
      ...original.config.behavior,
      topology: {
        region: "eu-central-1",
        zone: "multi-az",
        dataResidency: "EU",
      },
    };

    const applied = applyBehavioralProfile(
      original,
      "aws.rds-postgresql.db-r7g-large",
      1,
    );

    expect(applied.config).toMatchObject({
      capacityRps: 8_000,
      maxConnections: 700,
      behavioralProfile: {
        id: "aws.rds-postgresql.db-r7g-large",
        version: 1,
      },
      behavior: {
        compute: { cpuCores: 2, memoryGb: 16 },
        storage: {
          readIops: 12_000,
          replicationMode: "sync",
          failoverSeconds: 60,
        },
        topology: { region: "eu-central-1", dataResidency: "EU" },
        operations: { managed: true },
      },
    });
    expect(
      architectureSchema.safeParse({
        ...DEFAULT_ARCHITECTURE,
        nodes: DEFAULT_ARCHITECTURE.nodes.map((node) =>
          node.id === applied.id ? applied : node,
        ),
      }).success,
    ).toBe(true);
    expect(behavioralProfileEvidenceForNode(applied)).toMatchObject({
      status: "resolved",
      localOverrides: false,
      overriddenFields: [],
    });
  });

  it("changes modeled behavior through composed primitives, not profile labels", () => {
    const architecture = structuredClone(DEFAULT_ARCHITECTURE);
    architecture.nodes = architecture.nodes.map((node) =>
      node.id === "db"
        ? applyBehavioralProfile(node, "postgresql.community-balanced", 1)
        : node,
    );

    const baseline = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const profiled = simulate(DEFAULT_SCENARIO, architecture);

    expect(profiled.frames.map((frame) => frame.nodeMetrics.db)).not.toEqual(
      baseline.frames.map((frame) => frame.nodeMetrics.db),
    );
    expect(
      profiled.behavioralProfiles.find((entry) => entry.nodeId === "db"),
    ).toMatchObject({
      profileId: "postgresql.community-balanced",
      profileVersion: 1,
      localOverrides: false,
    });
  });

  it("emits deterministic, complete provenance and detects controlled overrides", () => {
    const architecture = structuredClone(DEFAULT_ARCHITECTURE);
    const applied = applyBehavioralProfile(
      databaseNode(),
      "aws.dynamodb.standard-on-demand",
      1,
    );
    applied.config.behavior = {
      ...applied.config.behavior,
      storage: {
        ...applied.config.behavior?.storage,
        hotPartitionFraction: 0.4,
      },
      topology: {
        ...applied.config.behavior?.topology,
        region: "eu-central-1",
      },
    };
    architecture.nodes = architecture.nodes.map((node) =>
      node.id === "db" ? applied : node,
    );

    const first = simulate(DEFAULT_SCENARIO, architecture);
    const second = simulate(DEFAULT_SCENARIO, architecture);
    const evidence = first.behavioralProfiles.find(
      (entry) => entry.nodeId === "db",
    );

    expect(second).toEqual(first);
    expect(first.behavioralProfiles).toHaveLength(architecture.nodes.length);
    expect(evidence).toMatchObject({
      status: "resolved",
      profileId: "aws.dynamodb.standard-on-demand",
      profileVersion: 1,
      localOverrides: true,
      overriddenFields: ["config.behavior.storage.hotPartitionFraction"],
    });
    expect(evidence?.assumptions.length).toBeGreaterThan(2);
    expect(evidence?.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          publisher: "Amazon Web Services",
          scope: "vendor-characteristics",
        }),
      ]),
    );
  });

  it("rejects unknown, incompatible, and version-mismatched references before execution", () => {
    const unknown = structuredClone(DEFAULT_ARCHITECTURE);
    unknown.nodes.find((node) => node.id === "db")!.config.behavioralProfile = {
      id: "vendor.unknown-profile",
      version: 1,
    };
    expect(() => simulate(DEFAULT_SCENARIO, unknown)).toThrow(
      "behavioral_profile_unknown:vendor.unknown-profile@1:db",
    );

    const incompatible = structuredClone(DEFAULT_ARCHITECTURE);
    incompatible.nodes.find(
      (node) => node.id === "api",
    )!.config.behavioralProfile = {
      id: "redis.community-balanced",
      version: 1,
    };
    expect(() => simulate(DEFAULT_SCENARIO, incompatible)).toThrow(
      "behavioral_profile_incompatible:redis.community-balanced:api:api",
    );

    const mismatched = structuredClone(DEFAULT_ARCHITECTURE);
    mismatched.nodes.find(
      (node) => node.id === "db",
    )!.config.behavioralProfile = {
      id: "postgresql.community-balanced",
      version: 2,
    };
    expect(() => simulate(DEFAULT_SCENARIO, mismatched)).toThrow(
      "behavioral_profile_version_mismatch:postgresql.community-balanced:2:1:db",
    );
  });

  it("keeps legacy architectures valid and reports every node as unprofiled", () => {
    const legacy = structuredClone(DEFAULT_ARCHITECTURE);
    const parsed = architectureSchema.parse(legacy);
    const result = simulate(DEFAULT_SCENARIO, parsed);

    expect(parsed.nodes.every((node) => !node.config.behavioralProfile)).toBe(
      true,
    );
    expect(result.behavioralProfiles).toHaveLength(parsed.nodes.length);
    expect(
      result.behavioralProfiles.every(
        (entry) =>
          entry.status === "unprofiled" &&
          entry.profileId === null &&
          entry.localOverrides === false,
      ),
    ).toBe(true);
  });

  it("lists only profiles compatible with the selected primitive", () => {
    expect(
      compatibleBehavioralProfiles("cache").map((profile) => profile.family),
    ).toEqual(["Redis", "Redis"]);
    expect(
      compatibleBehavioralProfiles("queue").map((profile) => profile.family),
    ).toEqual(["Kafka", "Kafka", "RabbitMQ", "RabbitMQ"]);
    expect(() =>
      applyBehavioralProfile(
        databaseNode(),
        "aws.elasticache-redis.cache-r7g-large",
      ),
    ).toThrow(
      "behavioral_profile_incompatible:aws.elasticache-redis.cache-r7g-large:database:db",
    );
  });
});
