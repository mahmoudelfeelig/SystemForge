import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const mutationConfig = resolve(root, "vitest.mutation.config.ts");
const performanceTest = "packages/sim-core/tests/simulate.performance.test.ts";

const mutations = [
  {
    id: "simulate-traffic-share",
    file: "packages/sim-core/tests/topology-execution.test.ts",
    testName: "propagates outgoing traffic shares",
  },
  {
    id: "local-simulation-run-id-only",
    file: "apps/web/tests/local-simulation.test.ts",
    testName: "ignores worker messages for another run identity",
  },
  {
    id: "share-participant-sanitization",
    file: "apps/web/tests/share.generated.test.ts",
    testName: "keeps generated participant shares private",
  },
  {
    id: "share-checksum-comparison",
    file: "apps/web/tests/share.generated.test.ts",
    testName: "rejects generated checksum tampering",
  },
];

const targetedFiles = [...new Set(mutations.map(({ file }) => file))];
const temporaryDirectory = mkdtempSync(
  join(tmpdir(), "systemforge-mutations-"),
);

const runVitest = (arguments_, environment = {}) => {
  const reportPath = join(
    temporaryDirectory,
    `report-${Math.random().toString(36).slice(2)}.json`,
  );
  const result = spawnSync(
    process.execPath,
    [
      vitest,
      "run",
      ...arguments_,
      "--reporter=json",
      `--outputFile=${reportPath}`,
      "--no-color",
      "--retry=0",
      "--maxWorkers=1",
      "--no-file-parallelism",
      "--no-cache",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...environment },
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  let report = null;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    // A missing report is meaningful evidence for harness or compile failures.
  }
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    report,
  };
};

const failedAssertions = (report) =>
  report?.testResults
    ?.flatMap((suite) => suite.assertionResults ?? [])
    .filter((assertion) => assertion.status === "failed") ?? [];

try {
  const baseline = runVitest(["--exclude", performanceTest, ...targetedFiles]);
  if (baseline.status !== 0) {
    console.error("Mutation baseline failed; mutant results would be invalid.");
    console.error(baseline.output.trim());
    process.exitCode = 1;
  } else {
    console.log(
      `Mutation baseline passed (${baseline.report?.numPassedTests ?? "unknown"} assertions).`,
    );
    let failed = false;
    for (const mutation of mutations) {
      const result = runVitest(
        [
          "--config",
          mutationConfig,
          mutation.file,
          "--testNamePattern",
          mutation.testName,
        ],
        { SYSTEMFORGE_MUTATION_ID: mutation.id },
      );
      const appliedMarker = `SYSTEMFORGE_MUTATION_APPLIED:${mutation.id}`;
      const assertions = failedAssertions(result.report);
      let classification;
      if (result.output.includes("SYSTEMFORGE_MUTATION_TRANSFORM_DRIFT:"))
        classification = "transform drift";
      else if (!result.output.includes(appliedMarker))
        classification = "transform drift";
      else if (result.status === 0) classification = "survived";
      else if (assertions.length > 0) classification = "assertion kill";
      else classification = "compile/harness failure";

      if (classification === "assertion kill")
        console.log(
          `KILLED ${mutation.id}: ${assertions.length} expected assertion failure(s).`,
        );
      else {
        failed = true;
        console.error(`INVALID ${mutation.id}: ${classification}.`);
        console.error(result.output.trim());
      }
    }
    if (failed) process.exitCode = 1;
    else console.log(`All ${mutations.length} targeted mutants were killed.`);
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
