import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 15_000,
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: [
        "packages/contracts/src/index.ts",
        "packages/sim-core/src/**/*.ts",
        "apps/api/src/app.ts",
        "apps/api/src/memoryStore.ts",
        "apps/api/src/runSolverInThread.ts",
        "apps/worker/src/execute.ts",
        "apps/web/src/lib/api.ts",
        "apps/web/src/lib/localSolver.ts",
        "apps/web/src/lib/share.ts",
        "apps/web/src/lib/solverGateway.ts",
      ],
      thresholds: {
        lines: 93,
        functions: 93,
        statements: 92,
        branches: 84,
      },
    },
  },
});
