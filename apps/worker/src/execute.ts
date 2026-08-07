import { createHash } from "node:crypto";
import {
  runSubmissionSchema,
  type RunSubmission,
  type SimulationResult,
} from "@systemforge/contracts";
import { ENGINE_VERSION, simulate } from "@systemforge/sim-core";

export interface CanonicalResult {
  result: SimulationResult;
  digest: string;
}

export function executeCanonical(input: RunSubmission): CanonicalResult {
  const submission = runSubmissionSchema.parse(input);
  const result = simulate(submission.scenario, submission.architecture);
  const manifest = {
    engineVersion: ENGINE_VERSION,
    scenarioSchemaVersion: submission.scenario.schemaVersion,
    architectureSchemaVersion: submission.architecture.schemaVersion,
    seed: submission.scenario.seed,
    result,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
  return { result: { ...result, digest }, digest };
}
