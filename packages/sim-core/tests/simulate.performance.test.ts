import { describe, expect, it } from "vitest";
import { DEFAULT_ARCHITECTURE, DEFAULT_SCENARIO, simulate } from "../src";

describe("simulation performance budget", () => {
  it("completes 250 representative simulations within two seconds", () => {
    const startedAt = performance.now();
    for (let iteration = 0; iteration < 250; iteration += 1) {
      simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    }
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2_000);
  });
});
