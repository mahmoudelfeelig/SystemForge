import {
  architectureSchema,
  configurationEvidenceSchema,
  estimateSimulationExecutionWorkUnits,
  type Architecture,
  type ArchitectureNode,
  type MetricFrame,
  type Scenario,
} from "@systemforge/contracts";
import { simulate } from "@systemforge/sim-core";

export interface NodeTelemetrySample {
  second: number;
  latencyMs: number;
  cpuUtilization: number;
}

export interface NodeTelemetryProfile {
  source: "csv" | "json";
  samples: NodeTelemetrySample[];
}

export interface TelemetryCalibrationEvidence {
  source: string;
  reference: string;
  observedAt: string;
}

export interface TelemetryFitError {
  aggregate: number;
  cpu: number;
  latency: number;
}

export interface TelemetryCalibrationReport {
  accepted: boolean;
  reason: string;
  architecture: Architecture;
  nodeId: string;
  trainSamples: number;
  holdoutSamples: number;
  previous: {
    capacityRps: number;
    baseLatencyMs: number;
  };
  fitted: {
    capacityRps: number;
    baseLatencyMs: number;
  };
  trainingError: {
    before: TelemetryFitError;
    after: TelemetryFitError;
  };
  holdoutError: {
    before: TelemetryFitError;
    after: TelemetryFitError;
  };
}

const finiteNumber = (value: unknown, label: string): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be numeric.`);
  return parsed;
};

const normalizeSamples = (
  source: NodeTelemetryProfile["source"],
  samples: NodeTelemetrySample[],
): NodeTelemetryProfile => {
  if (samples.length < 10)
    throw new Error(
      "Node telemetry requires at least 10 samples so two observations can be held out.",
    );
  if (samples.length > 2_000)
    throw new Error("Node telemetry may contain at most 2,000 samples.");
  const ordered = [...samples].sort(
    (left, right) => left.second - right.second,
  );
  for (const [index, sample] of ordered.entries()) {
    if (!Number.isInteger(sample.second) || sample.second < 0)
      throw new Error("Telemetry seconds must be non-negative integers.");
    if (sample.second > 86_400)
      throw new Error("Telemetry seconds may not exceed 86400.");
    if (index > 0 && ordered[index - 1]!.second === sample.second)
      throw new Error("Telemetry seconds must be unique.");
    if (
      !Number.isFinite(sample.latencyMs) ||
      sample.latencyMs < 0 ||
      sample.latencyMs > 60_000
    )
      throw new Error("Telemetry latencyMs must be between 0 and 60000.");
    if (
      !Number.isFinite(sample.cpuUtilization) ||
      sample.cpuUtilization < 0 ||
      sample.cpuUtilization > 1.99
    )
      throw new Error(
        "Telemetry cpuUtilization must be a ratio between 0 and 1.99.",
      );
  }
  return { source, samples: ordered };
};

export function parseNodeTelemetry(input: string): NodeTelemetryProfile {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("The node telemetry profile is empty.");
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("The node telemetry JSON is invalid.");
    }
    const records = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && "samples" in parsed
        ? parsed.samples
        : undefined;
    if (!Array.isArray(records))
      throw new Error("Telemetry JSON must be an array or contain samples.");
    return normalizeSamples(
      "json",
      records.map((record, index) => {
        if (typeof record !== "object" || record === null)
          throw new Error(`Telemetry sample ${index + 1} must be an object.`);
        const item = record as Record<string, unknown>;
        return {
          second: Math.round(finiteNumber(item.second, "second")),
          latencyMs: finiteNumber(
            item.latencyMs ?? item.latency_ms,
            "latencyMs",
          ),
          cpuUtilization: finiteNumber(
            item.cpuUtilization ?? item.cpu_utilization,
            "cpuUtilization",
          ),
        };
      }),
    );
  }

  const rows = trimmed.split(/\r?\n/).filter(Boolean);
  const header = rows
    .shift()
    ?.split(",")
    .map((value) => value.trim().toLowerCase().replaceAll("_", ""));
  const secondIndex =
    header?.findIndex((value) =>
      ["second", "seconds", "time"].includes(value),
    ) ?? -1;
  const latencyIndex =
    header?.findIndex((value) => ["latencyms", "latency"].includes(value)) ??
    -1;
  const cpuRatioIndex =
    header?.findIndex((value) =>
      ["cpuutilization", "cpuratio"].includes(value),
    ) ?? -1;
  const cpuPercentIndex =
    header?.findIndex((value) =>
      ["cpupercent", "cpupercentage"].includes(value),
    ) ?? -1;
  const cpuIndex = cpuRatioIndex >= 0 ? cpuRatioIndex : cpuPercentIndex;
  if (secondIndex < 0 || latencyIndex < 0 || cpuIndex < 0)
    throw new Error(
      "CSV must contain second, latencyMs, and cpuUtilization or cpuPercent columns.",
    );
  return normalizeSamples(
    "csv",
    rows.map((row, index) => {
      const values = row.split(",").map((value) => value.trim());
      const cpu = finiteNumber(values[cpuIndex], `row ${index + 2} CPU`);
      return {
        second: Math.round(
          finiteNumber(values[secondIndex], `row ${index + 2} second`),
        ),
        latencyMs: finiteNumber(
          values[latencyIndex],
          `row ${index + 2} latencyMs`,
        ),
        cpuUtilization: cpuPercentIndex >= 0 ? cpu / 100 : cpu,
      };
    }),
  );
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

// Calibration currently runs on the UI thread. Keep the complete bounded
// search below a stricter aggregate budget than a single canonical run so a
// large imported profile cannot make the workbench unresponsive.
export const MAX_TELEMETRY_CALIBRATION_WORK_UNITS = 400_000;
const MAX_TELEMETRY_CALIBRATION_RUNS = 44;

const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
};

const metricFor = (
  frames: readonly MetricFrame[],
  nodeId: string,
  sample: NodeTelemetrySample,
) => frames[sample.second]?.nodeMetrics[nodeId];

const score = (
  frames: readonly MetricFrame[],
  nodeId: string,
  samples: readonly NodeTelemetrySample[],
): TelemetryFitError => {
  let cpu = 0;
  let latency = 0;
  for (const sample of samples) {
    const metric = metricFor(frames, nodeId, sample);
    if (!metric)
      throw new Error(
        `Telemetry second ${sample.second} is outside the modeled result.`,
      );
    cpu +=
      Math.abs(metric.cpuUtilization - sample.cpuUtilization) /
      Math.max(0.05, sample.cpuUtilization);
    latency +=
      Math.abs(metric.latencyMs - sample.latencyMs) /
      Math.max(1, sample.latencyMs);
  }
  cpu /= samples.length;
  latency /= samples.length;
  return { aggregate: (cpu + latency) / 2, cpu, latency };
};

const withNodeInputs = (
  architecture: Architecture,
  nodeId: string,
  capacityRps: number,
  baseLatencyMs: number,
): Architecture => ({
  ...structuredClone(architecture),
  nodes: architecture.nodes.map((node) =>
    node.id === nodeId
      ? {
          ...structuredClone(node),
          config: {
            ...structuredClone(node.config),
            capacityRps,
            baseLatencyMs,
          },
        }
      : structuredClone(node),
  ),
});

const nodeFrom = (
  architecture: Architecture,
  nodeId: string,
): ArchitectureNode => {
  const node = architecture.nodes.find((candidate) => candidate.id === nodeId);
  if (!node)
    throw new Error("Select an existing architecture node to calibrate.");
  return node;
};

export function calibrateNodeFromTelemetry(
  scenario: Scenario,
  inputArchitecture: Architecture,
  nodeId: string,
  profile: NodeTelemetryProfile,
  evidence: TelemetryCalibrationEvidence,
): TelemetryCalibrationReport {
  const configurationEvidence = configurationEvidenceSchema.parse({
    kind: "telemetry-calibration",
    source: evidence.source,
    reference: evidence.reference,
    observedAt: evidence.observedAt,
    fields: ["config.capacityRps", "config.baseLatencyMs"],
  });
  if (!scenario.workload.observedTraffic)
    throw new Error(
      "Retain an observed demand profile before fitting node telemetry.",
    );
  const calibrationWorkUnits =
    estimateSimulationExecutionWorkUnits(scenario, inputArchitecture) *
    MAX_TELEMETRY_CALIBRATION_RUNS;
  if (calibrationWorkUnits > MAX_TELEMETRY_CALIBRATION_WORK_UNITS)
    throw new Error(
      `Telemetry calibration requires up to ${calibrationWorkUnits.toLocaleString("en-US")} work units, above the browser calibration budget of ${MAX_TELEMETRY_CALIBRATION_WORK_UNITS.toLocaleString("en-US")}. Trim the observed window or topology before fitting.`,
    );
  const node = nodeFrom(inputArchitecture, nodeId);
  const samples = profile.samples.filter(
    (sample) => sample.second <= scenario.workload.durationSeconds,
  );
  if (samples.length < 10)
    throw new Error(
      "At least 10 telemetry samples must fall inside the modeled duration.",
    );
  const holdout = samples.filter((_, index) => index % 5 === 4);
  const training = samples.filter((_, index) => index % 5 !== 4);
  if (holdout.length < 2)
    throw new Error(
      "Telemetry calibration requires at least two holdout samples.",
    );

  const baselineResult = simulate(scenario, inputArchitecture, {
    includeTraces: false,
  });
  const baselineTraining = score(baselineResult.frames, nodeId, training);
  const baselineHoldout = score(baselineResult.frames, nodeId, holdout);
  const capacityRatios = training
    .map((sample) => {
      const predicted = metricFor(baselineResult.frames, nodeId, sample);
      return predicted && sample.cpuUtilization >= 0.01
        ? predicted.cpuUtilization / sample.cpuUtilization
        : null;
    })
    .filter(
      (value): value is number => value !== null && Number.isFinite(value),
    );
  const estimatedCapacity = Math.round(
    node.config.capacityRps *
      (capacityRatios.length ? clamp(median(capacityRatios), 0.2, 5) : 1),
  );
  const capacityCandidates = [0.8, 0.9, 1, 1.1, 1.25]
    .map((factor) =>
      Math.round(clamp(estimatedCapacity * factor, 1, 10_000_000)),
    )
    .concat(node.config.capacityRps);

  let bestArchitecture = structuredClone(inputArchitecture);
  let bestTraining = baselineTraining;
  for (const capacityRps of new Set(capacityCandidates)) {
    const capacityArchitecture = withNodeInputs(
      inputArchitecture,
      nodeId,
      capacityRps,
      node.config.baseLatencyMs,
    );
    const capacityResult = simulate(scenario, capacityArchitecture, {
      includeTraces: false,
    });
    const estimatedLatency = clamp(
      median(
        training.map((sample) => {
          const predicted = metricFor(capacityResult.frames, nodeId, sample)!;
          return (
            node.config.baseLatencyMs + sample.latencyMs - predicted.latencyMs
          );
        }),
      ),
      0,
      60_000,
    );
    const latencyCandidates = [0.8, 0.9, 1, 1.1, 1.25]
      .map((factor) => clamp(estimatedLatency * factor, 0, 60_000))
      .concat(node.config.baseLatencyMs);
    for (const baseLatencyMs of new Set(latencyCandidates)) {
      const candidate = withNodeInputs(
        inputArchitecture,
        nodeId,
        capacityRps,
        Math.round(baseLatencyMs * 100) / 100,
      );
      const candidateResult = simulate(scenario, candidate, {
        includeTraces: false,
      });
      const candidateTraining = score(candidateResult.frames, nodeId, training);
      if (candidateTraining.aggregate < bestTraining.aggregate) {
        bestArchitecture = candidate;
        bestTraining = candidateTraining;
      }
    }
  }

  const fittedNode = nodeFrom(bestArchitecture, nodeId);
  const fittedResult = simulate(scenario, bestArchitecture, {
    includeTraces: false,
  });
  const fittedHoldout = score(fittedResult.frames, nodeId, holdout);
  const materialChange =
    fittedNode.config.capacityRps !== node.config.capacityRps ||
    fittedNode.config.baseLatencyMs !== node.config.baseLatencyMs;
  const improvesHoldout =
    fittedHoldout.aggregate <= baselineHoldout.aggregate * 0.98;
  const avoidsMetricRegression =
    fittedHoldout.cpu <= baselineHoldout.cpu * 1.1 + 0.000_001 &&
    fittedHoldout.latency <= baselineHoldout.latency * 1.1 + 0.000_001;
  const accepted = materialChange && improvesHoldout && avoidsMetricRegression;
  const architecture = accepted
    ? architectureSchema.parse({
        ...bestArchitecture,
        nodes: bestArchitecture.nodes.map((candidate) =>
          candidate.id === nodeId
            ? {
                ...candidate,
                config: {
                  ...candidate.config,
                  inputEvidence: [
                    ...(candidate.config.inputEvidence ?? []).filter(
                      (item) => item.kind !== "telemetry-calibration",
                    ),
                    configurationEvidence,
                  ].slice(-8),
                },
              }
            : candidate,
        ),
      })
    : structuredClone(inputArchitecture);

  return {
    accepted,
    reason: !materialChange
      ? "The fitted inputs did not differ materially from the current model."
      : !improvesHoldout
        ? "Rejected because held-out error did not improve by at least 2%."
        : !avoidsMetricRegression
          ? "Rejected because one held-out metric regressed by more than 10%."
          : "Accepted because the fitted inputs improved held-out observations without a material metric regression.",
    architecture,
    nodeId,
    trainSamples: training.length,
    holdoutSamples: holdout.length,
    previous: {
      capacityRps: node.config.capacityRps,
      baseLatencyMs: node.config.baseLatencyMs,
    },
    fitted: {
      capacityRps: fittedNode.config.capacityRps,
      baseLatencyMs: fittedNode.config.baseLatencyMs,
    },
    trainingError: { before: baselineTraining, after: bestTraining },
    holdoutError: { before: baselineHoldout, after: fittedHoldout },
  };
}
