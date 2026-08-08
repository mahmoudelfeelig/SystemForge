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

export function executeCanonical(
  input: RunSubmission,
  maximumResultBytes = Number.POSITIVE_INFINITY,
): CanonicalResult {
  const submission = runSubmissionSchema.parse(input);
  if (submission.clientEngineVersion !== ENGINE_VERSION)
    throw new Error(
      `engine_version_mismatch:${submission.clientEngineVersion}:${ENGINE_VERSION}`,
    );
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
  const canonicalResult = { ...result, digest };
  const resultBytes = Buffer.byteLength(JSON.stringify(canonicalResult));
  if (resultBytes > maximumResultBytes)
    throw new Error(
      `canonical_result_too_large:${resultBytes}:${maximumResultBytes}`,
    );
  return { result: canonicalResult, digest };
}
