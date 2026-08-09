/// <reference lib="webworker" />

import type {
  LocalShareDecodeRequest,
  LocalShareDecodeResponse,
} from "../lib/localShareDecoder";
import { decodeLocalShare } from "../lib/share";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<LocalShareDecodeRequest>) => {
  if (event.data.type !== "decode") return;
  const response: LocalShareDecodeResponse = {
    type: "decoded",
    requestId: event.data.requestId,
    payload: decodeLocalShare(event.data.value),
  };
  self.postMessage(response);
};

export {};
