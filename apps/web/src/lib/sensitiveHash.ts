import { MAX_RAW_SENSITIVE_HASH_LENGTH } from "./shareLimits";

const SENSITIVE_HASH_PARAMETERS = ["share", "hostToken"] as const;

export type SensitiveHashParameter = (typeof SENSITIVE_HASH_PARAMETERS)[number];

const capturedValues = new Map<SensitiveHashParameter, string>();

export function captureSensitiveHashParameters(): void {
  const rawHash = window.location.hash.slice(1);
  if (rawHash.length > MAX_RAW_SENSITIVE_HASH_LENGTH) {
    capturedValues.set("share", "");
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    return;
  }
  const parameters = new URLSearchParams(rawHash);
  let changed = false;
  for (const name of SENSITIVE_HASH_PARAMETERS) {
    if (parameters.has(name)) {
      capturedValues.set(name, parameters.get(name) ?? "");
      parameters.delete(name);
      changed = true;
    }
  }
  if (!changed) return;
  const remainingHash = parameters.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}${remainingHash ? `#${remainingHash}` : ""}`,
  );
}

export function readSensitiveHashParameter(
  name: SensitiveHashParameter,
): string | null {
  captureSensitiveHashParameters();
  return capturedValues.get(name) ?? null;
}

export function consumeSensitiveHashParameter(
  name: SensitiveHashParameter,
): string | null {
  const value = readSensitiveHashParameter(name);
  capturedValues.delete(name);
  return value;
}

export function clearSensitiveHashParameter(
  name: SensitiveHashParameter,
  expectedValue?: string | null,
): void {
  if (expectedValue !== undefined && capturedValues.get(name) !== expectedValue)
    return;
  capturedValues.delete(name);
}
