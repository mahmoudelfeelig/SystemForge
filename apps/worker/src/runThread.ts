import { Worker } from "node:worker_threads";
import type { RunSubmission, SimulationResult } from "@systemforge/contracts";

export interface ThreadResult {
  result: SimulationResult;
  digest: string;
}

export function runInThread(
  submission: RunSubmission,
  timeoutMilliseconds: number,
  maximumResultBytes: number,
): Promise<ThreadResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./canonicalThread.js", import.meta.url),
      { workerData: { submission, maximumResultBytes } },
    );
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error("canonical_run_timeout"));
    }, timeoutMilliseconds);
    timeout.unref();
    worker.once(
      "message",
      (message: {
        ok: boolean;
        result?: SimulationResult;
        digest?: string;
        error?: string;
      }) => {
        clearTimeout(timeout);
        void worker.terminate();
        if (message.ok && message.result && message.digest)
          resolve({ result: message.result, digest: message.digest });
        else reject(new Error(message.error ?? "canonical_run_failed"));
      },
    );
    worker.once("error", (error) => {
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`canonical_worker_exit_${code}`));
      }
    });
  });
}
