import { parentPort, workerData } from "node:worker_threads";
import type { RunSubmission } from "@systemforge/contracts";
import { executeCanonical } from "./execute";

if (!parentPort)
  throw new Error("Canonical worker thread requires a parent port.");

try {
  const { submission, maximumResultBytes } = workerData as {
    submission: RunSubmission;
    maximumResultBytes: number;
  };
  parentPort.postMessage({
    ok: true,
    ...executeCanonical(submission, maximumResultBytes),
  });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error:
      error instanceof Error ? error.message : "Canonical simulation failed.",
  });
}
