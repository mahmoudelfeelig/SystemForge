import { describe, expect, it } from "vitest";
import { architectureSchema, scenarioSchema } from "@systemforge/contracts";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  simulate,
} from "@systemforge/sim-core";
import { buildEvidenceReport } from "../src/lib/evidenceReport";
import { SCENARIO_LIBRARY } from "../src/lib/scenarioLibrary";
import {
  applyProviderSku,
  parseProviderCatalog,
} from "../src/lib/providerCatalog";
import {
  applyTopologyProposal,
  proposeTopologyChanges,
} from "../src/lib/topologySynthesis";

describe("decision workbench tools", () => {
  it("ships five valid, distinct scenario missions", () => {
    expect(SCENARIO_LIBRARY).toHaveLength(5);
    expect(new Set(SCENARIO_LIBRARY.map((entry) => entry.id)).size).toBe(5);
    for (const preset of SCENARIO_LIBRARY) {
      expect(scenarioSchema.safeParse(preset.scenario).success).toBe(true);
      expect(architectureSchema.safeParse(preset.architecture).success).toBe(
        true,
      );
    }
  });

  it("proposes and applies explicit topology augmentations", () => {
    const architecture = structuredClone(DEFAULT_ARCHITECTURE);
    architecture.nodes = architecture.nodes.filter(
      (node) => node.kind !== "cache",
    );
    architecture.edges = architecture.edges.filter(
      (edge) =>
        !["cache"].includes(edge.source) && !["cache"].includes(edge.target),
    );
    const proposals = proposeTopologyChanges(DEFAULT_SCENARIO, architecture);
    const cacheProposal = proposals.find(
      (proposal) => proposal.kind === "add-cache",
    );

    expect(cacheProposal).toBeTruthy();
    const augmented = applyTopologyProposal(architecture, cacheProposal!);
    expect(augmented.nodes.some((node) => node.kind === "cache")).toBe(true);
    expect(architecture.nodes.some((node) => node.kind === "cache")).toBe(
      false,
    );
  });

  it("exports a privacy-safe run report", () => {
    const scenario = structuredClone(DEFAULT_SCENARIO);
    scenario.mode = "interview";
    scenario.interview = {
      candidateBrief: "Design the service.",
      interviewerBrief: "Private rubric.",
      timeboxMinutes: 45,
      allowCandidateRequirements: true,
      revealPolicy: "never",
    };
    scenario.requirements[0] = {
      ...scenario.requirements[0]!,
      visibility: "hidden",
      owner: "interviewer",
      label: "SECRET-RUBRIC",
    };
    const result = simulate(scenario, DEFAULT_ARCHITECTURE);

    const markdown = buildEvidenceReport({
      scenario,
      architecture: DEFAULT_ARCHITECTURE,
      result,
      solverResult: null,
      role: "participant",
      format: "markdown",
    });

    expect(markdown).toContain("SystemForge run report");
    expect(markdown).not.toContain("SECRET-RUBRIC");
    expect(markdown).not.toContain("Private rubric");
  });

  it("imports a bounded provider catalog and applies an explicit SKU", () => {
    const catalog = parseProviderCatalog(
      JSON.stringify({
        schemaVersion: "1",
        provider: "Example Cloud",
        currency: "EUR",
        retrievedAt: "2026-08-08T00:00:00Z",
        services: [
          {
            sku: "compute-m",
            name: "Compute M",
            componentKinds: ["api"],
            region: "eu-central",
            monthlyEur: 72.5,
            cpuCores: 4,
            memoryGb: 16,
            egressPerGbEur: 0.02,
          },
        ],
      }),
    );
    const architecture = structuredClone(DEFAULT_ARCHITECTURE);
    const service = architecture.nodes.find((node) => node.kind === "api")!;
    const calibrated = applyProviderSku(
      architecture,
      service.id,
      catalog.services[0]!,
    );
    const changed = calibrated.nodes.find((node) => node.id === service.id)!;

    expect(changed.config.monthlyCostEur).toBe(72.5);
    expect(changed.config.behavior?.compute?.cpuCores).toBe(4);
    expect(changed.config.behavior?.topology?.region).toBe("eu-central");
    expect(service.config.monthlyCostEur).not.toBe(72.5);
    expect(architectureSchema.safeParse(calibrated).success).toBe(true);
  });
});
