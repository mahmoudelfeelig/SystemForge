import {
  architectureSchema,
  scenarioSchema,
  simulationActionScheduleSchema,
  type Architecture,
  type Scenario,
  type SimulationAction,
} from "@systemforge/contracts";

const fastStable64 = (value: string): string => {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;

  // Validated simulation inputs are overwhelmingly ASCII. Hash that common
  // case directly instead of allocating a second UTF-8 copy of the complete
  // scenario and architecture for every run. Fall back to TextEncoder for any
  // non-ASCII input so sf-input-v2 remains byte-for-byte compatible.
  for (let index = 0; index < value.length; index += 1) {
    const byte = value.charCodeAt(index);
    if (byte > 0x7f) {
      const bytes = new TextEncoder().encode(value);
      left = 0x811c9dc5;
      right = 0x9e3779b9;
      for (const encodedByte of bytes) {
        left = Math.imul(left ^ encodedByte, 0x01000193);
        right = Math.imul(right ^ (encodedByte + 0x9d), 0x85ebca6b);
        right ^= left >>> 13;
      }
      return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0)
        .toString(16)
        .padStart(8, "0")}`;
    }
    left = Math.imul(left ^ byte, 0x01000193);
    right = Math.imul(right ^ (byte + 0x9d), 0x85ebca6b);
    right ^= left >>> 13;
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
};

export const simulationInputFingerprintFromParsedInputs = (
  scenario: Scenario,
  architecture: Architecture,
  engineVersion: string,
  actions: readonly SimulationAction[] = [],
): string =>
  `sf-input-v2:${fastStable64(
    JSON.stringify({ engineVersion, scenario, architecture, actions }),
  )}`;

export const simulationInputFingerprint = (
  scenario: Scenario,
  architecture: Architecture,
  engineVersion: string,
  actions: readonly SimulationAction[] = [],
): string => {
  const parsedScenario = scenarioSchema.parse(scenario);
  const parsedArchitecture = architectureSchema.parse(architecture);
  const parsedActions = simulationActionScheduleSchema.parse(actions);
  return simulationInputFingerprintFromParsedInputs(
    parsedScenario,
    parsedArchitecture,
    engineVersion,
    parsedActions,
  );
};
