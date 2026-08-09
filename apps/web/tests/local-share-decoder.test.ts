// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ARCHITECTURE, DEFAULT_SCENARIO } from "@systemforge/sim-core";
import {
  decodeLocalShareInWorker,
  type LocalShareDecodeRequest,
  type LocalShareDecodeResponse,
} from "../src/lib/localShareDecoder";
import {
  encodeLocalShare,
  MAX_ENCODED_SHARE_LENGTH,
  type LocalSharePayload,
} from "../src/lib/share";

afterEach(() => vi.useRealTimers());

const payload: LocalSharePayload = {
  scenario: DEFAULT_SCENARIO,
  architecture: DEFAULT_ARCHITECTURE,
  role: "participant",
};

describe("local share decoder worker boundary", () => {
  it("decodes through a disposable worker and terminates it", async () => {
    const terminate = vi.fn();
    let posted: LocalShareDecodeRequest | undefined;
    const worker = {
      onmessage: null as
        ((event: MessageEvent<LocalShareDecodeResponse>) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage: (request: LocalShareDecodeRequest) => {
        posted = request;
        queueMicrotask(() =>
          worker.onmessage?.({
            data: {
              type: "decoded",
              requestId: request.requestId,
              payload,
            },
          } as MessageEvent<LocalShareDecodeResponse>),
        );
      },
      terminate,
    };

    await expect(
      decodeLocalShareInWorker(encodeLocalShare(payload), {
        workerFactory: () => worker,
      }),
    ).resolves.toEqual(payload);
    expect(posted).toMatchObject({ type: "decode" });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("rejects oversized input before allocating a worker", async () => {
    const workerFactory = vi.fn();

    await expect(
      decodeLocalShareInWorker("x".repeat(MAX_ENCODED_SHARE_LENGTH + 1), {
        workerFactory,
      }),
    ).resolves.toBeNull();
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it("terminates an unresponsive decoder at the bounded timeout", async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const worker = {
      onmessage: null,
      onerror: null,
      postMessage: vi.fn(),
      terminate,
    };
    const result = decodeLocalShareInWorker(encodeLocalShare(payload), {
      timeoutMs: 100,
      workerFactory: () => worker,
    });

    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toBeNull();
    expect(terminate).toHaveBeenCalledOnce();
  });
});
