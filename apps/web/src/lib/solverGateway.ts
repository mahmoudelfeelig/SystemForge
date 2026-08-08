import type { Architecture, Scenario } from "@systemforge/contracts";
import type {
  SolveArchitectureOptions,
  SolveArchitectureResult,
} from "@systemforge/sim-core";
import { solveCanonicalArchitecture, type CanonicalSolveResponse } from "./api";
import { runLocalArchitectureSolver } from "./localSolver";

export interface SolverExecution {
  execution: "canonical" | "local";
  result: SolveArchitectureResult;
  fallbackReason?: string;
}

interface SolverDependencies {
  canonical: (
    scenario: Scenario,
    architecture: Architecture,
    options: SolveArchitectureOptions,
  ) => Promise<CanonicalSolveResponse>;
  local: (
    scenario: Scenario,
    architecture: Architecture,
    options: SolveArchitectureOptions,
  ) => Promise<SolveArchitectureResult>;
}

const defaultDependencies: SolverDependencies = {
  canonical: solveCanonicalArchitecture,
  local: runLocalArchitectureSolver,
};

export async function solveArchitectureWithFallback(
  scenario: Scenario,
  architecture: Architecture,
  options: SolveArchitectureOptions,
  canonicalAvailable: boolean,
  dependencies: SolverDependencies = defaultDependencies,
): Promise<SolverExecution> {
  if (canonicalAvailable) {
    try {
      return await dependencies.canonical(scenario, architecture, options);
    } catch (error) {
      const result = await dependencies.local(scenario, architecture, options);
      return {
        execution: "local",
        result,
        fallbackReason:
          error instanceof Error
            ? error.message
            : "Canonical solving was unavailable.",
      };
    }
  }
  return {
    execution: "local",
    result: await dependencies.local(scenario, architecture, options),
  };
}
