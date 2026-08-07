import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
        "apps/worker/src/execute.ts",
        "apps/web/src/lib/api.ts",
        "apps/web/src/lib/share.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 65,
      },
    },
  },
});
