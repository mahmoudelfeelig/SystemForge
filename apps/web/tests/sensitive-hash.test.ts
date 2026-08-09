// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  captureSensitiveHashParameters,
  clearSensitiveHashParameter,
  consumeSensitiveHashParameter,
  readSensitiveHashParameter,
} from "../src/lib/sensitiveHash";
import { MAX_RAW_SENSITIVE_HASH_LENGTH } from "../src/lib/shareLimits";

afterEach(() => {
  clearSensitiveHashParameter("share");
  clearSensitiveHashParameter("hostToken");
  window.history.replaceState({}, "", "/");
});

describe("sensitive URL hash handling", () => {
  it("captures secrets in memory and immediately removes them from the address", () => {
    window.history.replaceState(
      { retained: true },
      "",
      "/scenario/example?source=test#share=private-share&panel=run&hostToken=private-host",
    );

    captureSensitiveHashParameters();

    expect(window.location.pathname).toBe("/scenario/example");
    expect(window.location.search).toBe("?source=test");
    expect(window.location.hash).toBe("#panel=run");
    expect(window.history.state).toEqual({ retained: true });
    expect(readSensitiveHashParameter("hostToken")).toBe("private-host");
    expect(consumeSensitiveHashParameter("share")).toBe("private-share");
    expect(consumeSensitiveHashParameter("share")).toBeNull();
  });

  it("does not let an older clear erase a newly captured credential", () => {
    window.history.replaceState({}, "", "/scenario/one#hostToken=first");
    captureSensitiveHashParameters();
    window.history.replaceState({}, "", "/scenario/two#hostToken=second");
    captureSensitiveHashParameters();

    clearSensitiveHashParameter("hostToken", "first");

    expect(readSensitiveHashParameter("hostToken")).toBe("second");
  });

  it("lets canonical routes discard a conflicting local share", () => {
    window.history.replaceState(
      {},
      "",
      "/scenario/example#hostToken=canonical-host&share=conflicting-local-share",
    );
    captureSensitiveHashParameters();

    clearSensitiveHashParameter("share");

    expect(consumeSensitiveHashParameter("share")).toBeNull();
    expect(consumeSensitiveHashParameter("hostToken")).toBe("canonical-host");
  });

  it("scrubs an oversized fragment before URL parameter parsing and fails it closed", () => {
    window.history.replaceState(
      {},
      "",
      `/lab#share=${"x".repeat(MAX_RAW_SENSITIVE_HASH_LENGTH + 1)}`,
    );

    captureSensitiveHashParameters();

    expect(window.location.hash).toBe("");
    expect(consumeSensitiveHashParameter("share")).toBe("");
  });
});
