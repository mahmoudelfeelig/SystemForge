import {
  estimateSimulationExecutionWorkUnits,
  estimateSimulationOutputMetricCells,
  estimateSimulationResultBytes,
  MAX_SIMULATION_ESTIMATED_RESULT_BYTES,
  MAX_SIMULATION_OUTPUT_METRIC_CELLS,
  type Architecture,
  type Scenario,
  type SimulationResult,
} from "@systemforge/contracts";
import { simulate } from "./simulate";

export const MAX_ROBUSTNESS_SEEDS = 64;
export const DEFAULT_ROBUSTNESS_WORK_UNIT_BUDGET = 2_000_000;

export interface RobustnessOptions {
  seedCount?: number;
  seedStride?: number;
  workUnitBudget?: number;
}

export interface RobustnessSummary {
  minimum: number;
  median: number;
  p95: number;
  maximum: number;
  mean: number;
}

export interface RobustnessResult {
  seeds: number[];
  requirementPassRate: number;
  completeRunPassRate: number;
  metrics: {
    requirementsPassed: RobustnessSummary;
    p95LatencyMs: RobustnessSummary;
    availability: RobustnessSummary;
    errorRate: RobustnessSummary;
    monthlyCostEur: RobustnessSummary;
    recoveryTimeSeconds: RobustnessSummary;
  };
  workUnits: number;
}

export interface RobustnessSeedSample {
  requirementsPassed: number;
  requirementsTotal: number;
  completeRunPassed: boolean;
  p95LatencyMs: number;
  availability: number;
  errorRate: number;
  monthlyCostEur: number;
  recoveryTimeSeconds: number;
}

const quantile = (values: number[], ratio: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index]!;
};

const rounded = (value: number, digits = 5): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const summarize = (values: number[]): RobustnessSummary => ({
  minimum: rounded(Math.min(...values)),
  median: rounded(quantile(values, 0.5)),
  p95: rounded(quantile(values, 0.95)),
  maximum: rounded(Math.max(...values)),
  mean: rounded(
    values.reduce((total, value) => total + value, 0) / values.length,
  ),
});

const maximum = (values: number[]): number =>
  values.length === 0 ? 0 : Math.max(...values);

const average = (values: number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;

export const estimateRobustnessWorkUnits = (
  scenario: Scenario,
  architecture: Architecture,
  seedCount: number,
): number =>
  estimateSimulationExecutionWorkUnits(scenario, architecture) * seedCount;

export const robustnessSeedSample = (
  result: SimulationResult,
): RobustnessSeedSample => ({
  requirementsPassed: result.score.passed,
  requirementsTotal: result.score.total,
  completeRunPassed: result.score.passed === result.score.total,
  p95LatencyMs: maximum(result.frames.map((frame) => frame.p95LatencyMs)),
  availability: average(result.frames.map((frame) => frame.availability)),
  errorRate: maximum(result.frames.map((frame) => frame.errorRate)),
  monthlyCostEur: maximum(result.frames.map((frame) => frame.monthlyCostEur)),
  recoveryTimeSeconds: maximum(
    result.frames.map((frame) => frame.recoveryTimeSeconds),
  ),
});

export const aggregateRobustnessSamples = (
  seeds: number[],
  samples: RobustnessSeedSample[],
  workUnits: number,
): RobustnessResult => {
  const totalRequirements = samples.reduce(
    (total, sample) => total + sample.requirementsTotal,
    0,
  );
  const passedRequirements = samples.reduce(
    (total, sample) => total + sample.requirementsPassed,
    0,
  );
  return {
    seeds,
    requirementPassRate:
      totalRequirements === 0
        ? 1
        : rounded(passedRequirements / totalRequirements, 6),
    completeRunPassRate: rounded(
      samples.filter((sample) => sample.completeRunPassed).length /
        samples.length,
      6,
    ),
    metrics: {
      requirementsPassed: summarize(
        samples.map((sample) => sample.requirementsPassed),
      ),
      p95LatencyMs: summarize(samples.map((sample) => sample.p95LatencyMs)),
      availability: summarize(samples.map((sample) => sample.availability)),
      errorRate: summarize(samples.map((sample) => sample.errorRate)),
      monthlyCostEur: summarize(samples.map((sample) => sample.monthlyCostEur)),
      recoveryTimeSeconds: summarize(
        samples.map((sample) => sample.recoveryTimeSeconds),
      ),
    },
    workUnits: rounded(workUnits, 2),
  };
};

export function analyzeRobustness(
  inputScenario: Scenario,
  inputArchitecture: Architecture,
  options: RobustnessOptions = {},
): RobustnessResult {
  const seedCount = options.seedCount ?? 9;
  const seedStride = options.seedStride ?? 7_919;
  const workUnitBudget =
    options.workUnitBudget ?? DEFAULT_ROBUSTNESS_WORK_UNIT_BUDGET;
  if (!Number.isInteger(seedCount) || seedCount < 2 || seedCount > 64)
    throw new Error(
      `seedCount must be an integer between 2 and ${MAX_ROBUSTNESS_SEEDS}.`,
    );
  if (!Number.isInteger(seedStride) || seedStride < 1)
    throw new Error("seedStride must be a positive integer.");
  if (!Number.isFinite(workUnitBudget) || workUnitBudget < 1)
    throw new Error("workUnitBudget must be positive.");
  const workUnits = estimateRobustnessWorkUnits(
    inputScenario,
    inputArchitecture,
    seedCount,
  );
  if (workUnits > workUnitBudget)
    throw new Error(
      `Robustness analysis requires ${Math.round(workUnits).toLocaleString("en-US")} work units, above the ${Math.round(workUnitBudget).toLocaleString("en-US")} budget.`,
    );
  const outputMetricCells = estimateSimulationOutputMetricCells(
    inputScenario,
    inputArchitecture,
  );
  if (outputMetricCells > MAX_SIMULATION_OUTPUT_METRIC_CELLS)
    throw new Error(
      `Each robustness seed would emit ${outputMetricCells.toLocaleString("en-US")} frame-metric cells, above the ${MAX_SIMULATION_OUTPUT_METRIC_CELLS.toLocaleString("en-US")} result-size limit.`,
    );
  const estimatedResultBytes = estimateSimulationResultBytes(
    inputScenario,
    inputArchitecture,
  );
  if (estimatedResultBytes > MAX_SIMULATION_ESTIMATED_RESULT_BYTES)
    throw new Error(
      `Each robustness seed's estimated ${estimatedResultBytes.toLocaleString("en-US")}-byte result exceeds the ${MAX_SIMULATION_ESTIMATED_RESULT_BYTES.toLocaleString("en-US")}-byte retention limit.`,
    );

  const seeds = Array.from(
    { length: seedCount },
    (_, index) => (inputScenario.seed + index * seedStride) % 2_147_483_648,
  );
  const samples = seeds.map((seed) =>
    robustnessSeedSample(
      simulate(
        { ...structuredClone(inputScenario), seed },
        structuredClone(inputArchitecture),
        { includeTraces: false },
      ),
    ),
  );
  return aggregateRobustnessSamples(seeds, samples, workUnits);
}
