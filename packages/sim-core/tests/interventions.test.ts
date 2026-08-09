import type { SimulationAction } from "@systemforge/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_ARCHITECTURE, DEFAULT_SCENARIO, simulate } from "../src";

const shortScenario = () => {
  const scenario = structuredClone(DEFAULT_SCENARIO);
  scenario.workload.durationSeconds = 15;
  scenario.workload.baseRps = 40_000;
  scenario.workload.peakRps = 40_000;
  scenario.workload.arrivalPattern = "steady";
  scenario.incidents = [];
  return scenario;
};

type InterventionAction = Extract<
  SimulationAction,
  { type: "apply-intervention" }
>;

const scaleAction = (atSecond = 5): InterventionAction => ({
  type: "apply-intervention",
  id: "scale-api",
  atSecond,
  nodeId: "api",
  intervention: { kind: "scale", instances: 12 },
});

describe("scheduled simulation actions", () => {
  it("keeps every frame and event before a future intervention byte-identical", () => {
    const scenario = shortScenario();
    const baseline = simulate(scenario, DEFAULT_ARCHITECTURE);
    const intervened = simulate(scenario, DEFAULT_ARCHITECTURE, {
      actions: [scaleAction()],
    });

    expect(intervened.frames.slice(0, 5)).toEqual(baseline.frames.slice(0, 5));
    expect(intervened.events.filter((event) => event.second < 5)).toEqual(
      baseline.events.filter((event) => event.second < 5),
    );
    expect(intervened.frames[5]).not.toEqual(baseline.frames[5]);
    expect(intervened.events).toContainEqual(
      expect.objectContaining({
        id: "intervention-scale-api",
        second: 5,
        kind: "operator-intervention",
        entityId: "api",
      }),
    );
    expect(intervened.frames[5]!.nodeMetrics.api!.activeInstances).toBe(12);
  });

  it("injects a scheduled incident without changing its earlier prefix", () => {
    const scenario = shortScenario();
    const baseline = simulate(scenario, DEFAULT_ARCHITECTURE);
    const action: SimulationAction = {
      type: "inject-incident",
      id: "inject-api-outage",
      atSecond: 6,
      incident: {
        id: "paused-api-outage",
        kind: "node-failure",
        magnitude: 1,
        durationSeconds: 3,
        targetId: "api",
        label: "Injected API outage",
      },
    };

    const first = simulate(scenario, DEFAULT_ARCHITECTURE, {
      actions: [action],
    });
    const second = simulate(scenario, DEFAULT_ARCHITECTURE, {
      actions: [action],
    });
    expect(first).toEqual(second);
    expect(first.frames.slice(0, 6)).toEqual(baseline.frames.slice(0, 6));
    expect(first.frames[6]!.nodeMetrics.api!.state).not.toBe("offline");
    expect(first.frames[6]!.edgeMetrics["e-api-db"]!.attemptedRps).toBeLessThan(
      baseline.frames[6]!.edgeMetrics["e-api-db"]!.attemptedRps,
    );
    expect(first.events).toContainEqual(
      expect.objectContaining({
        id: "incident-paused-api-outage",
        second: 6,
        entityId: "api",
      }),
    );
  });

  it("applies future circuit-breaker and load-shedding policies without mutating input", () => {
    const scenario = shortScenario();
    const architecture = structuredClone(DEFAULT_ARCHITECTURE);
    const originalArchitecture = structuredClone(architecture);
    const baseline = simulate(scenario, architecture);
    const breaker: SimulationAction = {
      type: "apply-intervention",
      id: "disable-api-breaker",
      atSecond: 5,
      nodeId: "api",
      intervention: { kind: "circuit-breaker", enabled: false },
    };
    const shedding: SimulationAction = {
      type: "apply-intervention",
      id: "lower-api-shedding-threshold",
      atSecond: 7,
      nodeId: "api",
      intervention: { kind: "load-shedding", threshold: 0.4 },
    };

    const intervened = simulate(scenario, architecture, {
      actions: [breaker, shedding],
    });

    expect(intervened.frames.slice(0, 5)).toEqual(baseline.frames.slice(0, 5));
    expect(intervened.frames[5]).not.toEqual(baseline.frames[5]);
    expect(intervened.frames[7]).not.toEqual(baseline.frames[7]);
    expect(intervened.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "intervention-disable-api-breaker",
          second: 5,
          entityId: "api",
        }),
        expect.objectContaining({
          id: "intervention-lower-api-shedding-threshold",
          second: 7,
          entityId: "api",
        }),
      ]),
    );
    expect(architecture).toEqual(originalArchitecture);
  });

  it("rejects unknown, non-future, out-of-duration and oversized actions", () => {
    const scenario = shortScenario();
    expect(() =>
      simulate(scenario, DEFAULT_ARCHITECTURE, {
        actions: [{ ...scaleAction(), nodeId: "missing" }],
      }),
    ).toThrow("invalid_action:unknown-node:missing");
    expect(() =>
      simulate(scenario, DEFAULT_ARCHITECTURE, {
        actions: [scaleAction(16)],
      }),
    ).toThrow("invalid_action:outside-duration:scale-api");
    expect(() =>
      simulate(scenario, DEFAULT_ARCHITECTURE, {
        actions: [scaleAction(0)],
      }),
    ).toThrow();
    expect(() =>
      simulate(scenario, DEFAULT_ARCHITECTURE, {
        actions: [
          {
            ...scaleAction(),
            intervention: { kind: "scale", instances: 10_001 },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      simulate(scenario, DEFAULT_ARCHITECTURE, {
        actions: Array.from({ length: 65 }, (_, index) => ({
          ...scaleAction(),
          id: `scale-${index}`,
        })),
      }),
    ).toThrow();
    expect(() =>
      simulate(scenario, DEFAULT_ARCHITECTURE, {
        actions: [
          {
            type: "inject-incident",
            id: "bad-target",
            atSecond: 5,
            incident: {
              id: "bad-target-incident",
              kind: "node-failure",
              magnitude: 1,
              label: "Unknown node outage",
              targetId: "missing",
            },
          },
        ],
      }),
    ).toThrow(
      "invalid_scenario:incident:bad-target-incident:unknown-target:missing",
    );
  });
});
