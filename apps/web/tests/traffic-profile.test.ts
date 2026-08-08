import { describe, expect, it } from "vitest";
import { DEFAULT_SCENARIO } from "@systemforge/sim-core";
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
    expect(
      calibrated.incidents.some(
        (incident) => incident.kind === "traffic-spike",
      ),
    ).toBe(true);
    expect(calibrated.summary).toContain("Imported traffic profile");
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
