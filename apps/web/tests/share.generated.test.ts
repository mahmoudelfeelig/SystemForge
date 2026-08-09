// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { DEFAULT_ARCHITECTURE, DEFAULT_SCENARIO } from "@systemforge/sim-core";
import {
  decodeLocalShare,
  encodeLocalShare,
  scenarioForLocalShare,
} from "../src/lib/share";

const seeds = [11, 29, 47, 83, 131, 197, 269, 353] as const;

const generatedPayload = (seed: number) => ({
  scenario: {
    ...structuredClone(DEFAULT_SCENARIO),
    id: `generated-scenario-${seed}`,
    title: `Generated scenario ${seed}`,
    seed,
  },
  architecture: {
    ...structuredClone(DEFAULT_ARCHITECTURE),
    id: `generated-architecture-${seed}`,
    name: `Generated architecture ${seed}`,
  },
  role: "participant" as const,
});

const generatedPrivateScenario = (seed: number) => ({
  ...structuredClone(DEFAULT_SCENARIO),
  id: `private-scenario-${seed}`,
  title: `Private interview scenario ${seed}`,
  mode: "interview" as const,
  seed,
  interview: {
    candidateBrief: `Design the service for case ${seed}.`,
    interviewerBrief: `Private interviewer evidence ${seed}.`,
    timeboxMinutes: 45,
    allowCandidateRequirements: true,
    revealPolicy: "interviewer-controlled" as const,
  },
  requirements: [
    ...structuredClone(DEFAULT_SCENARIO.requirements),
    {
      id: `hidden-generated-${seed}`,
      label: `Private durability target ${seed}`,
      metric: "dataLoss" as const,
      operator: "eq" as const,
      target: 0,
      unit: "writes",
      visibility: "hidden" as const,
      owner: "interviewer" as const,
    },
  ],
});

describe("deterministically generated local shares", () => {
  it.each(seeds)("round-trips generated valid payload %i", (seed) => {
    const payload = generatedPayload(seed);
    expect(decodeLocalShare(encodeLocalShare(payload))).toEqual(payload);
  });

  it.each(seeds)("rejects generated checksum tampering %i", (seed) => {
    const encoded = encodeLocalShare(generatedPayload(seed));
    const [version, checksum, compressed] = encoded.split(".");
    const tamperedChecksum = `${checksum?.startsWith("0") ? "1" : "0"}${checksum?.slice(1) ?? ""}`;

    expect(
      decodeLocalShare(`${version}.${tamperedChecksum}.${compressed}`),
    ).toBeNull();
  });

  it.each(seeds)("keeps generated participant shares private %i", (seed) => {
    const privateScenario = generatedPrivateScenario(seed);
    const candidate = scenarioForLocalShare(privateScenario, "participant");
    const decoded = decodeLocalShare(
      encodeLocalShare({
        scenario: candidate,
        architecture: generatedPayload(seed).architecture,
        role: "participant",
      }),
    );

    expect(decoded?.scenario.interview?.interviewerBrief).toBe("");
    expect(decoded?.scenario.requirements).not.toContainEqual(
      expect.objectContaining({ id: `hidden-generated-${seed}` }),
    );
  });
});
