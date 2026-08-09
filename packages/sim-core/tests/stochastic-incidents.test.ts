import type {
  Architecture,
  SimulationAction,
  StochasticIncidentRule,
} from "@systemforge/contracts";
import { incidentUsesMagnitude } from "@systemforge/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_ARCHITECTURE, DEFAULT_SCENARIO, simulate } from "../src";

const baseScenario = () => {
  const scenario = structuredClone(DEFAULT_SCENARIO);
  scenario.seed = 37;
  scenario.workload.durationSeconds = 15;
  scenario.workload.baseRps = 20_000;
  scenario.workload.peakRps = 20_000;
  scenario.workload.arrivalPattern = "steady";
  scenario.incidents = [];
  delete scenario.stochasticIncidents;
  return scenario;
};

const rule = (
  overrides: Partial<StochasticIncidentRule> = {},
): StochasticIncidentRule => {
  const kind = overrides.kind ?? "traffic-spike";
  return {
    id: "seeded-traffic",
    enabled: true,
    kind,
    label: "Seeded traffic pressure",
    hazardRatePerSecond: 0.4,
    cooldownSeconds: 0,
    maxOccurrences: 8,
    magnitude: overrides.magnitude ?? (incidentUsesMagnitude(kind) ? 2 : 1),
    durationSeconds: 2,
    ...overrides,
  };
};

const withRules = (
  rules: StochasticIncidentRule[],
  maximum = 16,
  enabled = true,
) => {
  const scenario = baseScenario();
  scenario.stochasticIncidents = {
    enabled,
    maxGeneratedIncidents: maximum,
    rules,
  };
  return scenario;
};

const correlatedArchitecture = (): Architecture => {
  const architecture = structuredClone(DEFAULT_ARCHITECTURE);
  const api = architecture.nodes.find((node) => node.id === "api")!;
  api.config.behavior = {
    ...api.config.behavior,
    topology: {
      ...api.config.behavior?.topology,
      region: "EU",
      failureDomain: "compute-cell",
    },
  };
  architecture.nodes.push({
    ...structuredClone(api),
    id: "api-b",
    name: "API Gateway B",
    position: { x: api.position.x, y: api.position.y + 90 },
  });
  architecture.edges.push(
    { id: "e-lb-api-b", source: "lb", target: "api-b" },
    { id: "e-api-b-db", source: "api-b", target: "db" },
  );
  return architecture;
};

const incidentSeconds = (result: ReturnType<typeof simulate>) =>
  result.generatedIncidents.map((generated) => generated.incident.atSecond);

describe("seeded stochastic incident execution", () => {
  it("is byte-identical for the same seed and produces explicit replay evidence", () => {
    const scenario = withRules([rule()]);
    const first = simulate(scenario, DEFAULT_ARCHITECTURE);
    const second = simulate(scenario, DEFAULT_ARCHITECTURE);

    expect(first).toEqual(second);
    expect(first.generatedIncidents.length).toBeGreaterThan(0);
    for (const generated of first.generatedIncidents) {
      expect(first.events).toContainEqual(
        expect.objectContaining({
          id: `incident-${generated.incident.id}`,
          second: generated.incident.atSecond,
          generatedIncident: {
            ruleId: generated.ruleId,
            occurrence: generated.occurrence,
            affectedNodeIds: generated.affectedNodeIds,
            correlated: generated.correlated,
          },
        }),
      );
    }
  });

  it("uses a seed-derived incident stream independent of workload draws", () => {
    const steady = withRules([rule({ hazardRatePerSecond: 0.35 })]);
    const poisson = structuredClone(steady);
    poisson.workload.arrivalPattern = "poisson";

    expect(incidentSeconds(simulate(steady, DEFAULT_ARCHITECTURE))).toEqual(
      incidentSeconds(simulate(poisson, DEFAULT_ARCHITECTURE)),
    );
  });

  it("allows different seeds to produce materially different disaster sequences", () => {
    const firstScenario = withRules([rule({ hazardRatePerSecond: 0.45 })]);
    const secondScenario = structuredClone(firstScenario);
    firstScenario.seed = 7;
    secondScenario.seed = 91;

    const first = simulate(firstScenario, DEFAULT_ARCHITECTURE);
    const second = simulate(secondScenario, DEFAULT_ARCHITECTURE);

    expect(incidentSeconds(first)).not.toEqual(incidentSeconds(second));
    expect(first.frames).not.toEqual(second.frames);
  });

  it("fans correlated failure-domain incidents across every matching node", () => {
    const architecture = correlatedArchitecture();
    const correlated = withRules([
      rule({
        id: "compute-cell-outage",
        kind: "node-failure",
        label: "Compute cell outage",
        hazardRatePerSecond: 1,
        maxOccurrences: 1,
        magnitude: 1,
        durationSeconds: 3,
        scope: { failureDomain: "compute-cell", correlated: true },
      }),
    ]);

    const result = simulate(correlated, architecture);
    expect(result.generatedIncidents[0]).toMatchObject({
      affectedNodeIds: ["api", "api-b"],
      correlated: true,
      incident: { failureDomain: "compute-cell", atSecond: 0 },
    });
    expect(result.frames[0]!.nodeMetrics.api!.errorRate).toBeGreaterThan(0);
    expect(result.frames[0]!.nodeMetrics["api-b"]!.errorRate).toBeGreaterThan(
      0,
    );

    const noncorrelated = structuredClone(correlated);
    noncorrelated.stochasticIncidents!.rules[0]!.scope!.correlated = false;
    const single = simulate(noncorrelated, architecture);
    expect(single.generatedIncidents[0]!.affectedNodeIds).toHaveLength(1);
    expect(
      ["api", "api-b"].filter(
        (nodeId) => single.frames[0]!.nodeMetrics[nodeId]!.errorRate > 0,
      ),
    ).toEqual(single.generatedIncidents[0]!.affectedNodeIds);
  });

  it("evaluates state triggers against the previous delivered frame", () => {
    const scenario = withRules([
      rule({
        hazardRatePerSecond: 1,
        maxOccurrences: 1,
        trigger: {
          metric: "throughputRps",
          operator: "gte",
          threshold: 1,
        },
      }),
    ]);

    const result = simulate(scenario, DEFAULT_ARCHITECTURE);
    expect(result.generatedIncidents[0]).toMatchObject({
      incident: { atSecond: 1 },
      trigger: {
        metric: "throughputRps",
        priorFrameSecond: 0,
        observedValue: result.frames[0]!.throughputRps,
      },
    });
    expect(result.events).toContainEqual(
      expect.objectContaining({
        id: `incident-${result.generatedIncidents[0]!.incident.id}`,
        second: 1,
      }),
    );
  });

  it("enforces cooldown, per-rule occurrence, and global generation caps", () => {
    const bounded = simulate(
      withRules([
        rule({
          hazardRatePerSecond: 1,
          cooldownSeconds: 2,
          maxOccurrences: 3,
        }),
      ]),
      DEFAULT_ARCHITECTURE,
    );
    expect(incidentSeconds(bounded)).toEqual([0, 3, 6]);

    const globallyBounded = simulate(
      withRules(
        [
          rule({ id: "first", hazardRatePerSecond: 1 }),
          rule({ id: "second", hazardRatePerSecond: 1 }),
        ],
        2,
      ),
      DEFAULT_ARCHITECTURE,
    );
    expect(globallyBounded.generatedIncidents).toHaveLength(2);
    expect(
      globallyBounded.generatedIncidents.map(({ ruleId }) => ruleId),
    ).toEqual(["first", "second"]);
  });

  it("rejects unknown, impossible, and physically inapplicable scopes", () => {
    expect(() =>
      simulate(
        withRules([
          rule({
            kind: "node-failure",
            scope: { targetId: "missing", correlated: false },
          }),
        ]),
        DEFAULT_ARCHITECTURE,
      ),
    ).toThrow("invalid_stochastic_rule:seeded-traffic:unknown-target:missing");
    expect(() =>
      simulate(
        withRules([
          rule({
            kind: "node-failure",
            scope: { region: "missing", correlated: false },
          }),
        ]),
        DEFAULT_ARCHITECTURE,
      ),
    ).toThrow("invalid_stochastic_rule:seeded-traffic:unknown-region:missing");
    expect(() =>
      simulate(
        withRules([
          rule({
            kind: "node-failure",
            scope: { failureDomain: "missing", correlated: false },
          }),
        ]),
        DEFAULT_ARCHITECTURE,
      ),
    ).toThrow(
      "invalid_stochastic_rule:seeded-traffic:unknown-failure-domain:missing",
    );
    expect(() =>
      simulate(
        withRules([
          rule({
            kind: "node-failure",
            scope: {
              region: "global",
              failureDomain: "cluster",
              correlated: true,
            },
          }),
        ]),
        DEFAULT_ARCHITECTURE,
      ),
    ).toThrow("invalid_stochastic_rule:seeded-traffic:impossible-scope");
    expect(() =>
      simulate(
        withRules([
          rule({
            kind: "database-degradation",
            scope: { targetId: "cache", correlated: false },
          }),
        ]),
        DEFAULT_ARCHITECTURE,
      ),
    ).toThrow("invalid_stochastic_rule:seeded-traffic:inapplicable-kind-scope");
    expect(() =>
      simulate(
        withRules([
          rule({
            scope: { region: "EU", correlated: false },
          }),
        ]),
        DEFAULT_ARCHITECTURE,
      ),
    ).toThrow("invalid_stochastic_rule:seeded-traffic:inapplicable-kind-scope");
  });

  it("keeps disabled models at exact legacy parity", () => {
    const baselineScenario = baseScenario();
    const disabled = structuredClone(baselineScenario);
    disabled.stochasticIncidents = {
      enabled: false,
      maxGeneratedIncidents: 4,
      rules: [rule({ hazardRatePerSecond: 1 })],
    };

    const disabledResult = simulate(disabled, DEFAULT_ARCHITECTURE);
    const baselineResult = simulate(baselineScenario, DEFAULT_ARCHITECTURE);
    expect({ ...disabledResult, inputFingerprint: undefined }).toEqual({
      ...baselineResult,
      inputFingerprint: undefined,
    });
  });

  it("replays generated incidents deterministically alongside action schedules", () => {
    const scenario = withRules([rule({ hazardRatePerSecond: 0.45 })]);
    const actions: SimulationAction[] = [
      {
        type: "apply-intervention",
        id: "scale-api-at-five",
        atSecond: 5,
        nodeId: "api",
        intervention: { kind: "scale", instances: 12 },
      },
      {
        type: "inject-incident",
        id: "inject-cache-failure",
        atSecond: 8,
        incident: {
          id: "operator-cache-failure",
          kind: "cache-failure",
          label: "Operator cache failure",
          magnitude: 1,
          durationSeconds: 2,
          targetId: "cache",
        },
      },
    ];

    const first = simulate(scenario, DEFAULT_ARCHITECTURE, { actions });
    const second = simulate(scenario, DEFAULT_ARCHITECTURE, { actions });
    expect(first).toEqual(second);
    expect(first.generatedIncidents).toEqual(
      simulate(scenario, DEFAULT_ARCHITECTURE).generatedIncidents,
    );
    expect(first.events).toContainEqual(
      expect.objectContaining({ id: "incident-operator-cache-failure" }),
    );
  });
});
