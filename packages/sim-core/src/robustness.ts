import type { Architecture, Scenario } from "@systemforge/contracts";
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
  (scenario.workload.durationSeconds + 1) *
  (architecture.nodes.length + architecture.edges.length * 0.25) *
  seedCount;

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

  const seeds = Array.from(
    { length: seedCount },
    (_, index) => (inputScenario.seed + index * seedStride) % 2_147_483_648,
  );
  const results = seeds.map((seed) =>
    simulate(
      { ...structuredClone(inputScenario), seed },
      structuredClone(inputArchitecture),
    ),
  );
  const totalRequirements = results.reduce(
    (total, result) => total + result.score.total,
    0,
  );
  const passedRequirements = results.reduce(
    (total, result) => total + result.score.passed,
    0,
  );
  const metricValues = {
    requirementsPassed: results.map((result) => result.score.passed),
    p95LatencyMs: results.map((result) =>
      maximum(result.frames.map((frame) => frame.p95LatencyMs)),
    ),
    availability: results.map((result) =>
      average(result.frames.map((frame) => frame.availability)),
    ),
    errorRate: results.map((result) =>
      maximum(result.frames.map((frame) => frame.errorRate)),
    ),
    monthlyCostEur: results.map((result) =>
      maximum(result.frames.map((frame) => frame.monthlyCostEur)),
    ),
    recoveryTimeSeconds: results.map((result) =>
      maximum(result.frames.map((frame) => frame.recoveryTimeSeconds)),
    ),
  };

  return {
    seeds,
    requirementPassRate:
      totalRequirements === 0
        ? 1
        : rounded(passedRequirements / totalRequirements, 6),
    completeRunPassRate: rounded(
      results.filter((result) => result.score.passed === result.score.total)
        .length / results.length,
      6,
    ),
    metrics: {
      requirementsPassed: summarize(metricValues.requirementsPassed),
      p95LatencyMs: summarize(metricValues.p95LatencyMs),
      availability: summarize(metricValues.availability),
      errorRate: summarize(metricValues.errorRate),
      monthlyCostEur: summarize(metricValues.monthlyCostEur),
      recoveryTimeSeconds: summarize(metricValues.recoveryTimeSeconds),
    },
    workUnits: rounded(workUnits, 2),
  };
}
