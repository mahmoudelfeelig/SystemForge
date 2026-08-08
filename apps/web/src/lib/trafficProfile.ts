import {
  scenarioSchema,
  type Incident,
  type Scenario,
} from "@systemforge/contracts";

export interface TrafficSample {
  second: number;
  rps: number;
}

export interface TrafficProfile {
  source: "csv" | "otel-json";
  samples: TrafficSample[];
}

const parseFinite = (value: unknown, label: string): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be numeric.`);
  return parsed;
};

const validateSamples = (
  source: TrafficProfile["source"],
  samples: TrafficSample[],
): TrafficProfile => {
  if (samples.length < 2)
    throw new Error("A traffic profile requires at least two samples.");
  if (samples.length > 2_000)
    throw new Error("A traffic profile may contain at most 2,000 samples.");
  const ordered = [...samples].sort(
    (left, right) => left.second - right.second,
  );
  for (const [index, sample] of ordered.entries()) {
    if (!Number.isInteger(sample.second) || sample.second < 0)
      throw new Error("Profile seconds must be non-negative integers.");
    if (sample.second > 86_400)
      throw new Error("Profile seconds may not exceed 86400.");
    if (
      !Number.isFinite(sample.rps) ||
      sample.rps < 1 ||
      sample.rps > 10_000_000
    )
      throw new Error("Profile RPS must be between 1 and 10000000.");
    if (index > 0 && ordered[index - 1]!.second === sample.second)
      throw new Error("Profile seconds must be unique.");
  }
  return { source, samples: ordered };
};

export function parseTrafficProfile(input: string): TrafficProfile {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("The traffic profile is empty.");
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("The traffic profile JSON is invalid.");
    }
    const records = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && "spans" in parsed
        ? parsed.spans
        : undefined;
    if (!Array.isArray(records))
      throw new Error(
        "OpenTelemetry JSON must be an array or contain a spans array.",
      );
    const samples = records.map((record, index) => {
      if (typeof record !== "object" || record === null)
        throw new Error(`Observation ${index + 1} must be an object.`);
      const item = record as Record<string, unknown>;
      return {
        second: Math.round(
          parseFinite(item.second ?? item.timestamp ?? item.time, "timestamp"),
        ),
        rps: parseFinite(
          item.rps ?? item.requestsPerSecond ?? item.request_rate,
          "requests per second",
        ),
      };
    });
    return validateSamples("otel-json", samples);
  }

  const rows = trimmed.split(/\r?\n/).filter(Boolean);
  const header = rows
    .shift()
    ?.split(",")
    .map((value) => value.trim().toLowerCase());
  const secondIndex =
    header?.findIndex((value) =>
      ["second", "seconds", "time"].includes(value),
    ) ?? -1;
  const rpsIndex =
    header?.findIndex((value) =>
      ["rps", "requestspersecond", "request_rate"].includes(
        value.replaceAll("_", ""),
      ),
    ) ?? -1;
  if (secondIndex < 0 || rpsIndex < 0)
    throw new Error("CSV must contain second and rps columns.");
  const samples = rows.map((row, index) => {
    const values = row.split(",").map((value) => value.trim());
    return {
      second: Math.round(
        parseFinite(values[secondIndex], `row ${index + 2} second`),
      ),
      rps: parseFinite(values[rpsIndex], `row ${index + 2} rps`),
    };
  });
  return validateSamples("csv", samples);
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
};

export function applyTrafficProfile(
  inputScenario: Scenario,
  profile: TrafficProfile,
): Scenario {
  const values = profile.samples.map((sample) => Math.round(sample.rps));
  const baseRps = Math.max(1, median(values));
  const peakRps = Math.max(baseRps, ...values);
  const durationSeconds = Math.max(15, profile.samples.at(-1)!.second);
  const peakSample = profile.samples.reduce((current, sample) =>
    sample.rps > current.rps ? sample : current,
  );
  const importedIncident: Incident = {
    id: "imported-traffic-peak",
    atSecond: Math.min(durationSeconds, peakSample.second),
    kind: "traffic-spike",
    magnitude: Math.max(1, Math.min(100, peakRps / baseRps)),
    durationSeconds: Math.max(1, Math.round(durationSeconds * 0.12)),
    label: `Imported peak ${peakRps.toLocaleString("en-US")} RPS`,
  };
  const summaryPrefix = `Imported traffic profile (${profile.source}, ${profile.samples.length} samples). `;
  return scenarioSchema.parse({
    ...structuredClone(inputScenario),
    summary: `${summaryPrefix}${inputScenario.summary}`.slice(0, 600),
    workload: {
      ...structuredClone(inputScenario.workload),
      baseRps,
      peakRps,
      durationSeconds,
    },
    incidents: [
      ...inputScenario.incidents.filter(
        (incident) => incident.id !== importedIncident.id,
      ),
      importedIncident,
    ].map((incident) => ({
      ...incident,
      atSecond: Math.min(incident.atSecond, durationSeconds),
      durationSeconds: incident.durationSeconds
        ? Math.min(incident.durationSeconds, durationSeconds)
        : undefined,
    })),
  });
}
