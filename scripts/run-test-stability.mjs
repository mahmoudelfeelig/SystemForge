import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const performanceTest = "packages/sim-core/tests/simulate.performance.test.ts";

const passes = [
  {
    name: "serial shuffled",
    arguments: [
      "--sequence.shuffle",
      "--sequence.seed=819521",
      "--maxWorkers=1",
      "--no-file-parallelism",
    ],
  },
  {
    name: "parallel shuffled",
    arguments: [
      "--sequence.shuffle",
      "--sequence.seed=20260809",
      "--maxWorkers=50%",
    ],
  },
];

for (const pass of passes) {
  console.log(`Starting ${pass.name} stability pass.`);
  const result = spawnSync(
    process.execPath,
    [
      vitest,
      "run",
      "--exclude",
      performanceTest,
      "--no-cache",
      "--retry=0",
      ...pass.arguments,
    ],
    { cwd: root, encoding: "utf8", stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(
      `${pass.name} stability pass failed with exit code ${result.status ?? "unknown"}.`,
    );
    process.exit(result.status ?? 1);
  }
  console.log(`${pass.name} stability pass passed.`);
}

console.log("Both fixed-seed stability passes passed without retries.");
