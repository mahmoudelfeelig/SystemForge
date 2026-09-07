import { describe, expect, it } from "vitest";
import {
  DeterministicRandom,
  advanceFifoQueue,
  arrivalSquaredCoefficientOfVariation,
  estimateQueueingDelay,
  sampleArrivalCount,
  samplePoissonCount,
} from "../src/index";

describe("aggregate arrival and queueing models", () => {
  it("keeps steady arrivals exact and Poisson arrivals deterministic", () => {
    const first = new DeterministicRandom(91_771);
    const second = new DeterministicRandom(91_771);
    const firstSeries = Array.from({ length: 64 }, () =>
      sampleArrivalCount(2_500, "poisson", first),
    );
    const secondSeries = Array.from({ length: 64 }, () =>
      sampleArrivalCount(2_500, "poisson", second),
    );

    expect(firstSeries).toEqual(secondSeries);
    expect(sampleArrivalCount(2_500.4, "steady", first)).toBe(2_500);
    expect(new Set(firstSeries).size).toBeGreaterThan(8);
  });

  it("matches Poisson mean and variance over a deterministic large sample", () => {
    const random = new DeterministicRandom(4_209);
    const samples = Array.from({ length: 20_000 }, () =>
      samplePoissonCount(12, random),
    );
    const mean =
      samples.reduce((total, value) => total + value, 0) / samples.length;
    const variance =
      samples.reduce((total, value) => total + (value - mean) ** 2, 0) /
      samples.length;

    expect(mean).toBeGreaterThan(11.8);
    expect(mean).toBeLessThan(12.2);
    expect(variance).toBeGreaterThan(11.4);
    expect(variance).toBeLessThan(12.6);
  });

  it("makes burst traffic over-dispersed without materially shifting its mean", () => {
    const random = new DeterministicRandom(7_118);
    const samples = Array.from({ length: 10_000 }, () =>
      sampleArrivalCount(1_000, "bursty", random),
    );
    const mean =
      samples.reduce((total, value) => total + value, 0) / samples.length;
    const variance =
      samples.reduce((total, value) => total + (value - mean) ** 2, 0) /
      samples.length;

    expect(mean).toBeGreaterThan(980);
    expect(mean).toBeLessThan(1_020);
    expect(variance).toBeGreaterThan(mean * 50);
    expect(arrivalSquaredCoefficientOfVariation("bursty")).toBeCloseTo(
      1.123,
      3,
    );
  });

  it("raises G/G/c resource wait sharply near saturation and caps unstable wait", () => {
    const low = estimateQueueingDelay({
      arrivalRateRps: 2_000,
      capacityRps: 10_000,
      parallelServers: 4,
      serviceTimeMs: 20,
      arrivalScv: 1,
      timeoutMs: 800,
    });
    const high = estimateQueueingDelay({
      arrivalRateRps: 9_500,
      capacityRps: 10_000,
      parallelServers: 4,
      serviceTimeMs: 20,
      arrivalScv: 1,
      timeoutMs: 800,
    });
    const unstable = estimateQueueingDelay({
      arrivalRateRps: 18_000,
      capacityRps: 10_000,
      parallelServers: 4,
      serviceTimeMs: 20,
      arrivalScv: 1,
      timeoutMs: 800,
    });

    expect(low.stable).toBe(true);
    expect(high.waitMs).toBeGreaterThan(low.waitMs * 20);
    expect(unstable.stable).toBe(false);
    expect(unstable.waitMs).toBe(800);
  });

  it("tracks the oldest undrained FIFO cohort instead of inferring age from depth", () => {
    const cohorts: Array<{ enqueuedSecond: number; count: number }> = [];

    expect(advanceFifoQueue(cohorts, 0, 100, 40)).toEqual({
      processed: 40,
      depth: 60,
      oldestAgeMs: 0,
    });
    expect(advanceFifoQueue(cohorts, 1, 10, 30)).toEqual({
      processed: 30,
      depth: 40,
      oldestAgeMs: 1_000,
    });
    expect(advanceFifoQueue(cohorts, 2, 0, 35)).toEqual({
      processed: 35,
      depth: 5,
      oldestAgeMs: 1_000,
    });
    expect(advanceFifoQueue(cohorts, 3, 0, 35)).toEqual({
      processed: 5,
      depth: 0,
      oldestAgeMs: 0,
    });
  });
});
