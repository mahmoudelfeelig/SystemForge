import {
  architectureSchema,
  candidateScenario,
  scenarioSchema,
  type Architecture,
  type Scenario,
} from "@systemforge/contracts";

export interface LocalSharePayload {
  scenario: Scenario;
  architecture?: Architecture;
  role: "participant" | "interviewer";
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function fromBase64Url(value: string): string {
  const base64 = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

export function encodeLocalShare(payload: LocalSharePayload): string {
  return toBase64Url(JSON.stringify(payload));
}

export function decodeLocalShare(value: string): LocalSharePayload | null {
  try {
    const parsed = JSON.parse(
      fromBase64Url(value),
    ) as Partial<LocalSharePayload>;
    const scenario = scenarioSchema.parse(parsed.scenario);
    const architecture =
      parsed.architecture === undefined
        ? undefined
        : architectureSchema.parse(parsed.architecture);
    const role = parsed.role === "interviewer" ? "interviewer" : "participant";
    return { scenario, architecture, role };
  } catch {
    return null;
  }
}

export function scenarioForLocalShare(
  scenario: Scenario,
  role: "participant" | "interviewer",
): Scenario {
  return role === "interviewer" ? scenario : candidateScenario(scenario);
}

export function interviewShareLinks(
  scenario: Scenario,
  architecture?: Architecture,
): { interviewer: string; candidate: string } {
  const base = `${window.location.origin}/lab`;
  return {
    interviewer: `${base}#share=${encodeLocalShare({ scenario, architecture, role: "interviewer" })}`,
    candidate: `${base}#share=${encodeLocalShare({ scenario: scenarioForLocalShare(scenario, "participant"), architecture, role: "participant" })}`,
  };
}
