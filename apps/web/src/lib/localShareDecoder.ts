import type { LocalSharePayload } from "./share";
import { MAX_ENCODED_SHARE_LENGTH } from "./shareLimits";

export const LOCAL_SHARE_DECODE_TIMEOUT_MS = 1_500;

export interface LocalShareDecodeRequest {
  type: "decode";
  requestId: string;
  value: string;
}

export interface LocalShareDecodeResponse {
  type: "decoded";
  requestId: string;
  payload: LocalSharePayload | null;
}

type ShareDecoderWorker = Pick<
  Worker,
  "postMessage" | "terminate" | "onmessage" | "onerror"
>;

type ShareDecoderWorkerFactory = () => ShareDecoderWorker;

const defaultWorkerFactory: ShareDecoderWorkerFactory = () =>
  new Worker(new URL("../workers/share.worker.ts", import.meta.url), {
    type: "module",
  });

export function decodeLocalShareInWorker(
  value: string,
  options: {
    timeoutMs?: number;
    workerFactory?: ShareDecoderWorkerFactory;
  } = {},
): Promise<LocalSharePayload | null> {
  if (!value || value.length > MAX_ENCODED_SHARE_LENGTH)
    return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let worker: ShareDecoderWorker;
    try {
      worker = (options.workerFactory ?? defaultWorkerFactory)();
    } catch {
      resolve(null);
      return;
    }
    const requestId = crypto.randomUUID();
    const finish = (payload: LocalSharePayload | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      worker.terminate();
      resolve(payload);
    };
    const timer = window.setTimeout(
      () => finish(null),
      Math.max(100, options.timeoutMs ?? LOCAL_SHARE_DECODE_TIMEOUT_MS),
    );
    worker.onmessage = (event: MessageEvent<LocalShareDecodeResponse>) => {
      if (event.data.type !== "decoded" || event.data.requestId !== requestId)
        return;
      finish(event.data.payload);
    };
    worker.onerror = () => finish(null);
    const request: LocalShareDecodeRequest = {
      type: "decode",
      requestId,
      value,
    };
    worker.postMessage(request);
  });
}
