import {
  architectureDraftSchema,
  candidateScenario,
  scenarioSchema,
  type Architecture,
  type Scenario,
} from "@systemforge/contracts";
import { compressToEncodedURIComponent } from "lz-string";
import { decompressUriComponentBounded } from "./boundedLzString";
import {
  MAX_DECOMPRESSED_SHARE_LENGTH,
  MAX_ENCODED_SHARE_LENGTH,
} from "./shareLimits";

export {
  MAX_DECOMPRESSED_SHARE_LENGTH,
  MAX_ENCODED_SHARE_LENGTH,
} from "./shareLimits";

export interface LocalSharePayload {
  scenario: Scenario;
  architecture?: Architecture;
  role: "participant" | "interviewer";
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

const LOCAL_SHARE_VERSION = "sf2";

export class LocalShareTooLargeError extends Error {
  constructor(
    readonly encodedLength: number,
    readonly maximumLength = MAX_ENCODED_SHARE_LENGTH,
  ) {
    super(
      `This local share needs ${encodedLength.toLocaleString()} characters; the safe browser-link limit is ${maximumLength.toLocaleString()}.`,
    );
    this.name = "LocalShareTooLargeError";
  }
}

interface CompactLocalSharePayload {
  v: 2;
  s: Scenario;
  a?: Architecture;
  r: "p" | "i";
}

function checksum(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

function validatePayload(
  parsed: Partial<LocalSharePayload>,
): LocalSharePayload {
  const scenario = scenarioSchema.parse(parsed.scenario);
  const architecture =
    parsed.architecture === undefined
      ? undefined
      : architectureDraftSchema.parse(parsed.architecture);
  const role = parsed.role === "interviewer" ? "interviewer" : "participant";
  return { scenario, architecture, role };
}

export function encodeLocalShare(payload: LocalSharePayload): string {
  const compact: CompactLocalSharePayload = {
    v: 2,
    s: payload.scenario,
    ...(payload.architecture ? { a: payload.architecture } : {}),
    r: payload.role === "interviewer" ? "i" : "p",
  };
  const serialized = JSON.stringify(compact);
  const encoded = `${LOCAL_SHARE_VERSION}.${checksum(serialized)}.${compressToEncodedURIComponent(serialized)}`;
  if (encoded.length > MAX_ENCODED_SHARE_LENGTH)
    throw new LocalShareTooLargeError(encoded.length);
  return encoded;
}

export function decodeLocalShare(value: string): LocalSharePayload | null {
  if (!value || value.length > MAX_ENCODED_SHARE_LENGTH) return null;
  try {
    if (value.startsWith(`${LOCAL_SHARE_VERSION}.`)) {
      const [version, expectedChecksum, compressed, ...extra] =
        value.split(".");
      if (
        version !== LOCAL_SHARE_VERSION ||
        !expectedChecksum ||
        !compressed ||
        extra.length
      )
        return null;
      const serialized = decompressUriComponentBounded(
        compressed,
        MAX_DECOMPRESSED_SHARE_LENGTH,
      );
      if (
        !serialized ||
        serialized.length > MAX_DECOMPRESSED_SHARE_LENGTH ||
        checksum(serialized) !== expectedChecksum
      )
        return null;
      const compact = JSON.parse(
        serialized,
      ) as Partial<CompactLocalSharePayload>;
      if (compact.v !== 2 || !compact.s) return null;
      return validatePayload({
        scenario: compact.s,
        architecture: compact.a,
        role: compact.r === "i" ? "interviewer" : "participant",
      });
    }

    // Version 1 migration: uncompressed base64url JSON links remain readable.
    const legacy = fromBase64Url(value);
    if (legacy.length > MAX_DECOMPRESSED_SHARE_LENGTH) return null;
    return validatePayload(JSON.parse(legacy) as Partial<LocalSharePayload>);
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

export function candidateLocalShareLink(
  scenario: Scenario,
  architecture?: Architecture,
  origin = window.location.origin,
): string {
  const base = `${origin.replace(/\/$/, "")}/lab`;
  return `${base}#share=${encodeLocalShare({
    scenario: scenarioForLocalShare(scenario, "participant"),
    architecture,
    role: "participant",
  })}`;
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
