import {
  candidateScenario,
  type Architecture,
  type Scenario,
  type SimulationResult,
} from "@systemforge/contracts";
import type { SolveArchitectureResult } from "@systemforge/sim-core";
import type { CompletedRunArtifact } from "./completedRun";

interface EvidenceReportInput {
  scenario: Scenario;
  architecture: Architecture;
  result: SimulationResult | null;
  solverResult: SolveArchitectureResult | null;
  role: "participant" | "interviewer";
  format: "json" | "markdown";
}

const compactResult = (
  result: SimulationResult | null,
  visibleRequirementIds: Set<string>,
) =>
  result
    ? {
        engineVersion: result.engineVersion,
        seed: result.seed,
        score: {
          passed: result.requirements.filter(
            (entry) =>
              visibleRequirementIds.has(entry.requirement.id) && entry.passed,
          ).length,
          total: result.requirements.filter((entry) =>
            visibleRequirementIds.has(entry.requirement.id),
          ).length,
        },
        requirements: result.requirements.filter((entry) =>
          visibleRequirementIds.has(entry.requirement.id),
        ),
        analysis: result.analysis,
        eventCount: result.events.length,
        digest: result.digest,
      }
    : null;

export function buildEvidenceReport(input: EvidenceReportInput): string {
  const scenario =
    input.role === "interviewer"
      ? structuredClone(input.scenario)
      : candidateScenario(input.scenario);
  const visibleRequirementIds = new Set(
    scenario.requirements.map((requirement) => requirement.id),
  );
  const result = compactResult(input.result, visibleRequirementIds);
  const report = {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    privacyScope: input.role,
    modeledOutput: true,
    scenario,
    architecture: structuredClone(input.architecture),
    result,
    solver: input.solverResult
      ? {
          engineVersion: input.solverResult.engineVersion,
          solverVersion: input.solverResult.solverVersion,
          baseline: input.solverResult.baseline.metrics,
          exploredCandidates: input.solverResult.exploredCandidates,
          recommendedCandidateId: input.solverResult.recommendedCandidateId,
          candidates: input.solverResult.candidates.map((candidate) => ({
            id: candidate.id,
            rank: candidate.rank,
            label: candidate.label,
            changes: candidate.changes,
            metrics: candidate.evaluation.metrics,
            deltas: candidate.deltas,
            eligible: candidate.eligible,
            paretoOptimal: candidate.paretoOptimal,
            improvements: candidate.improvements,
            tradeoffs: candidate.tradeoffs,
            constraintViolations: candidate.constraintViolations,
          })),
        }
      : null,
  };
  if (input.format === "json") return JSON.stringify(report, null, 2);

  const lines = [
    "# SystemForge run report",
    "",
    `Generated: ${report.generatedAt}`,
    `Privacy scope: ${report.privacyScope}`,
    "Output boundary: deterministic model output, not production telemetry.",
    "",
    `## ${scenario.title}`,
    "",
    scenario.summary,
    "",
    `Architecture: ${input.architecture.name}`,
    `Seed: ${scenario.seed}`,
    `Workload: ${scenario.workload.baseRps.toLocaleString("en-US")} base RPS / ${scenario.workload.peakRps.toLocaleString("en-US")} peak RPS`,
    "",
    "## Objectives",
    "",
    ...scenario.requirements.map((requirement) => {
      const outcome = result?.requirements.find(
        (entry) => entry.requirement.id === requirement.id,
      );
      return `- ${outcome ? (outcome.passed ? "PASS" : "FAIL") : "NOT RUN"}: ${requirement.label}${outcome ? ` — ${outcome.actual} ${requirement.unit}` : ""}`;
    }),
    "",
    "## Modeled analysis",
    "",
    ...(result
      ? [
          `- Score: ${result.score.passed}/${result.score.total}`,
          `- Bottleneck: ${result.analysis.bottleneckLabel}`,
          ...result.analysis.strengths.map((value) => `- Strength: ${value}`),
          ...result.analysis.risks.map((value) => `- Risk: ${value}`),
          ...result.analysis.tradeoffs.map((value) => `- Trade-off: ${value}`),
        ]
      : ["- No simulation has been run for this architecture."]),
    "",
    "## Solver alternatives",
    "",
    ...(report.solver
      ? report.solver.candidates
          .slice(0, 8)
          .flatMap((candidate) => [
            `### ${candidate.rank}. ${candidate.label}`,
            `Eligible: ${candidate.eligible ? "yes" : "no"}; Pareto frontier: ${candidate.paretoOptimal ? "yes" : "no"}`,
            ...candidate.improvements.map((value) => `- Improvement: ${value}`),
            ...candidate.tradeoffs.map((value) => `- Trade-off: ${value}`),
            "",
          ])
      : ["- No architecture solve has been run."]),
  ];
  return lines.join("\n");
}

export function downloadEvidenceReport(input: EvidenceReportInput): void {
  const contents = buildEvidenceReport(input);
  const extension = input.format === "json" ? "json" : "md";
  const type = input.format === "json" ? "application/json" : "text/markdown";
  const blob = new Blob([contents], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `systemforge-${input.scenario.id}-run-report.${extension}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export interface CompletedRunManifestExport {
  manifestExportVersion: 1;
  privacyScope: "completed-run-manifest-only";
  sourceRetention: "browser-session";
  replayable: false;
  replayBoundary: "evidence-only-no-deterministic-inputs";
  manifest: CompletedRunArtifact["manifest"];
}

export function buildCompletedRunManifestExport(
  artifact: CompletedRunArtifact,
): string {
  const exported: CompletedRunManifestExport = {
    manifestExportVersion: 1,
    privacyScope: "completed-run-manifest-only",
    sourceRetention: "browser-session",
    replayable: false,
    replayBoundary: "evidence-only-no-deterministic-inputs",
    manifest: structuredClone(artifact.manifest),
  };
  return JSON.stringify(exported, null, 2);
}

export function downloadCompletedRunManifest(
  artifact: CompletedRunArtifact,
): void {
  const blob = new Blob([buildCompletedRunManifestExport(artifact)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const safeRunId =
    artifact.manifest.runId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) ||
    "completed-run";
  anchor.href = url;
  anchor.download = `systemforge-${safeRunId}-manifest.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
