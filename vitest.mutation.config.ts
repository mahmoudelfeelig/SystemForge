import { normalize } from "node:path";
import { defineConfig, mergeConfig, type Plugin } from "vitest/config";
import baseConfig from "./vitest.config";

interface MutationDefinition {
  file: string;
  original: string;
  replacement: string;
}

const mutations: Record<string, MutationDefinition> = {
  "simulate-traffic-share": {
    file: "packages/sim-core/src/simulate.ts",
    original:
      "const attemptedForward =\n          sourceForwardDemand * trafficShare + retryDemand;",
    replacement:
      "const attemptedForward =\n          sourceForwardDemand + retryDemand;",
  },
  "local-simulation-run-id-only": {
    file: "apps/web/src/lib/localSimulation.ts",
    original: `left.runId === right.runId &&
  left.scenarioRevision === right.scenarioRevision &&
  left.architectureRevision === right.architectureRevision &&
  left.scenarioId === right.scenarioId &&
  left.architectureId === right.architectureId;`,
    replacement: "left.runId === right.runId;",
  },
  "share-participant-sanitization": {
    file: "apps/web/src/lib/share.ts",
    original:
      'return role === "interviewer" ? scenario : candidateScenario(scenario);',
    replacement: "return scenario;",
  },
  "share-checksum-comparison": {
    file: "apps/web/src/lib/share.ts",
    original: "checksum(serialized) !== expectedChecksum",
    replacement: "false",
  },
};

const mutationId = process.env.SYSTEMFORGE_MUTATION_ID;

const mutationPlugin = (): Plugin => ({
  name: "systemforge-in-memory-mutation",
  enforce: "pre",
  transform(source, id) {
    if (!mutationId) return null;
    const mutation = mutations[mutationId];
    if (!mutation)
      throw new Error(
        `SYSTEMFORGE_MUTATION_TRANSFORM_DRIFT: unknown mutation ${mutationId}`,
      );
    const cleanId = normalize(id.split("?", 1)[0] ?? id);
    if (!cleanId.endsWith(normalize(mutation.file))) return null;
    const occurrences = source.split(mutation.original).length - 1;
    if (occurrences !== 1)
      throw new Error(
        `SYSTEMFORGE_MUTATION_TRANSFORM_DRIFT: ${mutationId} expected one transform anchor in ${mutation.file}, found ${occurrences}`,
      );
    console.log(`SYSTEMFORGE_MUTATION_APPLIED:${mutationId}`);
    return {
      code: source.replace(mutation.original, mutation.replacement),
      map: null,
    };
  },
  buildEnd() {
    if (!mutationId) return;
    const mutation = mutations[mutationId];
    if (!mutation)
      throw new Error(
        `SYSTEMFORGE_MUTATION_TRANSFORM_DRIFT: unknown mutation ${mutationId}`,
      );
  },
});

export default mergeConfig(
  baseConfig,
  defineConfig({ plugins: [mutationPlugin()] }),
);
