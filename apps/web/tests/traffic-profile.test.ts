import { describe, expect, it } from "vitest";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  simulate,
} from "@systemforge/sim-core";
import {
  applyTrafficProfile,
  parseTrafficProfile,
} from "../src/lib/trafficProfile";

describe("traffic profile calibration", () => {
  it("imports CSV observations into a bounded scenario workload", () => {
    const profile = parseTrafficProfile(
      "second,rps\n0,1200\n30,1800\n60,7200\n90,2100\n120,1500",
    );
    const calibrated = applyTrafficProfile(DEFAULT_SCENARIO, profile);

    expect(calibrated.workload.baseRps).toBe(1800);
    expect(calibrated.workload.peakRps).toBe(7200);
    expect(calibrated.workload.durationSeconds).toBe(120);
    expect(calibrated.workload.arrivalPattern).toBe("steady");
    expect(calibrated.workload.observedTraffic).toEqual({
      source: "csv",
      interpolation: "linear",
      samples: [
        { second: 0, rps: 1200 },
        { second: 30, rps: 1800 },
        { second: 60, rps: 7200 },
        { second: 90, rps: 2100 },
        { second: 120, rps: 1500 },
      ],
    });
    expect(
      calibrated.incidents.some(
        (incident) => incident.id === "imported-traffic-peak",
      ),
    ).toBe(false);
    expect(calibrated.summary).toContain("Imported traffic profile");
  });

  it("replays retained observations instead of reducing them to one synthetic peak", () => {
    const scenario = structuredClone(DEFAULT_SCENARIO);
    scenario.incidents = [];
    const calibrated = applyTrafficProfile(
      scenario,
      parseTrafficProfile("second,rps\n0,1000\n10,3000\n20,1000"),
    );
    const result = simulate(calibrated, DEFAULT_ARCHITECTURE, {
      includeTraces: false,
    });

    expect(result.frames[0]!.rps).toBe(1000);
    expect(result.frames[5]!.rps).toBe(2000);
    expect(result.frames[10]!.rps).toBe(3000);
    expect(result.frames[15]!.rps).toBe(2000);
    expect(result.frames[20]!.rps).toBe(1000);
  });

  it("keeps the derived base rate inside the scenario contract for very large observations", () => {
    const calibrated = applyTrafficProfile(
      DEFAULT_SCENARIO,
      parseTrafficProfile("second,rps\n0,6000000\n10,7000000\n20,8000000"),
    );

    expect(calibrated.workload.baseRps).toBe(5_000_000);
    expect(calibrated.workload.peakRps).toBe(8_000_000);
    expect(calibrated.workload.observedTraffic?.samples).toHaveLength(3);
  });

  it("accepts OpenTelemetry-like JSON observations", () => {
    const profile = parseTrafficProfile(
      JSON.stringify([
        { timestamp: 0, requestsPerSecond: 90 },
        { timestamp: 15, requestsPerSecond: 150 },
        { timestamp: 30, requestsPerSecond: 220 },
      ]),
    );

    expect(profile.source).toBe("otel-json");
    expect(profile.samples.at(-1)).toEqual({ second: 30, rps: 220 });
  });

  it("rejects malformed or oversized profiles", () => {
    expect(() => parseTrafficProfile("second,rps\n0,10")).toThrow(
      /two samples/i,
    );
    expect(() => parseTrafficProfile("second,rps\n0,10\n90000,20")).toThrow(
      /86400/i,
    );
  });
});
