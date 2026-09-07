import { architectureSchema } from "@systemforge/contracts";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  simulate,
} from "@systemforge/sim-core";
import { describe, expect, it } from "vitest";
import {
  calibrateNodeFromTelemetry,
  parseNodeTelemetry,
} from "../src/lib/telemetryCalibration";
import {
  applyTrafficProfile,
  parseTrafficProfile,
} from "../src/lib/trafficProfile";

const observedScenario = () =>
  applyTrafficProfile(
    { ...structuredClone(DEFAULT_SCENARIO), incidents: [] },
    parseTrafficProfile(
      `second,rps\n${Array.from({ length: 21 }, (_, second) => `${second},${25_000 + second * 1_500}`).join("\n")}`,
    ),
  );

describe("node telemetry calibration", () => {
  it("parses ratio and percent CSV without guessing units", () => {
    const ratio = parseNodeTelemetry(
      `second,latencyMs,cpuUtilization\n${Array.from({ length: 10 }, (_, second) => `${second},20,0.5`).join("\n")}`,
    );
    const percent = parseNodeTelemetry(
      `second,latencyMs,cpuPercent\n${Array.from({ length: 10 }, (_, second) => `${second},20,50`).join("\n")}`,
    );

    expect(ratio.samples[0]?.cpuUtilization).toBe(0.5);
    expect(percent.samples[0]?.cpuUtilization).toBe(0.5);
    expect(() =>
      parseNodeTelemetry(
        `second,latencyMs,cpuUtilization\n${Array.from({ length: 10 }, (_, second) => `${second},20,50`).join("\n")}`,
      ),
    ).toThrow(/ratio between 0 and 1.99/);
  });

  it("accepts only a fitted model that improves deterministic holdout samples", () => {
    const scenario = observedScenario();
    const truth = structuredClone(DEFAULT_ARCHITECTURE);
    const api = truth.nodes.find((node) => node.id === "api")!;
    api.config.capacityRps = 6_000;
    api.config.baseLatencyMs = 34;
    api.config.autoscale = false;
    api.config.maxInstances = api.config.instances;
    const baseline = structuredClone(truth);
    const baselineApi = baseline.nodes.find((node) => node.id === "api")!;
    baselineApi.config.capacityRps = 10_000;
    baselineApi.config.baseLatencyMs = 18;
    const truthResult = simulate(scenario, truth, { includeTraces: false });
    const profile = {
      source: "json" as const,
      samples: truthResult.frames.slice(0, 20).map((frame) => ({
        second: frame.second,
        latencyMs: frame.nodeMetrics.api!.latencyMs,
        cpuUtilization: frame.nodeMetrics.api!.cpuUtilization,
      })),
    };

    const report = calibrateNodeFromTelemetry(
      scenario,
      baseline,
      "api",
      profile,
      {
        source: "production-prometheus",
        reference: "api-canary-2026-09-07",
        observedAt: "2026-09-07T12:00:00+02:00",
      },
    );

    expect(report.accepted).toBe(true);
    expect(report.holdoutSamples).toBe(4);
    expect(report.holdoutError.after.aggregate).toBeLessThan(
      report.holdoutError.before.aggregate,
    );
    expect(report.fitted.capacityRps).toBeGreaterThanOrEqual(5_000);
    expect(report.fitted.capacityRps).toBeLessThanOrEqual(7_000);
    expect(report.fitted.baseLatencyMs).toBeGreaterThanOrEqual(30);
    const calibrated = report.architecture.nodes.find(
      (node) => node.id === "api",
    )!;
    expect(calibrated.config.inputEvidence?.at(-1)).toMatchObject({
      kind: "telemetry-calibration",
      source: "production-prometheus",
      reference: "api-canary-2026-09-07",
      fields: ["config.capacityRps", "config.baseLatencyMs"],
    });
    expect(architectureSchema.safeParse(report.architecture).success).toBe(
      true,
    );
  });

  it("refuses telemetry fitting until observed demand is retained", () => {
    const profile = parseNodeTelemetry(
      `second,latencyMs,cpuUtilization\n${Array.from({ length: 10 }, (_, second) => `${second},20,0.5`).join("\n")}`,
    );
    expect(() =>
      calibrateNodeFromTelemetry(
        DEFAULT_SCENARIO,
        DEFAULT_ARCHITECTURE,
        "api",
        profile,
        {
          source: "test",
          reference: "test-run",
          observedAt: "2026-09-07T12:00:00Z",
        },
      ),
    ).toThrow(/observed demand profile/);
  });

  it("rejects a training fit that does not generalize to held-out observations", () => {
    const scenario = observedScenario();
    const truth = structuredClone(DEFAULT_ARCHITECTURE);
    const truthApi = truth.nodes.find((node) => node.id === "api")!;
    truthApi.config.capacityRps = 6_000;
    truthApi.config.baseLatencyMs = 34;
    truthApi.config.autoscale = false;
    truthApi.config.maxInstances = truthApi.config.instances;
    const baselineResult = simulate(scenario, DEFAULT_ARCHITECTURE, {
      includeTraces: false,
    });
    const truthResult = simulate(scenario, truth, { includeTraces: false });
    const profile = {
      source: "json" as const,
      samples: truthResult.frames.slice(0, 20).map((frame, index) => {
        const observed =
          index % 5 === 4
            ? baselineResult.frames[index]!.nodeMetrics.api!
            : frame.nodeMetrics.api!;
        return {
          second: frame.second,
          latencyMs: observed.latencyMs,
          cpuUtilization: observed.cpuUtilization,
        };
      }),
    };

    const report = calibrateNodeFromTelemetry(
      scenario,
      DEFAULT_ARCHITECTURE,
      "api",
      profile,
      {
        source: "production-prometheus",
        reference: "inconsistent-window",
        observedAt: "2026-09-07T12:00:00+02:00",
      },
    );

    expect(report.accepted).toBe(false);
    expect(report.reason).toMatch(/held-out|regressed/);
    expect(report.architecture).toEqual(DEFAULT_ARCHITECTURE);
  });

  it("rejects calibration jobs that could freeze the browser workbench", () => {
    const scenario = observedScenario();
    scenario.workload.durationSeconds = 4_000;
    scenario.workload.observedTraffic!.samples = [
      { second: 0, rps: 25_000 },
      { second: 4_000, rps: 25_000 },
    ];
    const profile = parseNodeTelemetry(
      `second,latencyMs,cpuUtilization\n${Array.from({ length: 10 }, (_, index) => `${index * 400},20,0.5`).join("\n")}`,
    );

    expect(() =>
      calibrateNodeFromTelemetry(
        scenario,
        DEFAULT_ARCHITECTURE,
        "api",
        profile,
        {
          source: "test",
          reference: "oversized-window",
          observedAt: "2026-09-07T12:00:00Z",
        },
      ),
    ).toThrow(/browser calibration budget/);
  });
});
