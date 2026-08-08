import { describe, expect, it } from "vitest";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  ENGINE_VERSION,
} from "@systemforge/sim-core";
import { executeCanonical } from "../src/execute";

describe("canonical execution", () => {
  it("produces a stable, result-bound digest", () => {
    const submission = {
      scenario: DEFAULT_SCENARIO,
      architecture: DEFAULT_ARCHITECTURE,
      clientEngineVersion: ENGINE_VERSION,
    };
    const first = executeCanonical(submission);
    const second = executeCanonical(submission);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toEqual(first);
    expect(first.result.digest).toBe(first.digest);
  });

  it("rejects malformed work before consuming simulation capacity", () => {
    expect(() =>
      executeCanonical({
        scenario: {},
        architecture: {},
        clientEngineVersion: ENGINE_VERSION,
      } as never),
    ).toThrow();
  });

  it("rejects a canonical result before it can amplify durable storage", () => {
    expect(() =>
      executeCanonical(
        {
          scenario: DEFAULT_SCENARIO,
          architecture: DEFAULT_ARCHITECTURE,
          clientEngineVersion: ENGINE_VERSION,
        },
        1_000,
      ),
    ).toThrow(/canonical_result_too_large/);

    expect(() =>
      executeCanonical(
        {
          scenario: DEFAULT_SCENARIO,
          architecture: DEFAULT_ARCHITECTURE,
          clientEngineVersion: ENGINE_VERSION,
        },
        10_000_000,
      ),
    ).not.toThrow();
  });
});
