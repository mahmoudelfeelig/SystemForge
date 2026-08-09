import { describe, expect, it } from "vitest";
import { compressToEncodedURIComponent } from "lz-string";
import { decompressUriComponentBounded } from "../src/lib/boundedLzString";
import { MAX_DECOMPRESSED_SHARE_LENGTH } from "../src/lib/share";

describe("bounded LZ-String migration decoder", () => {
  it("round-trips ordinary URI-safe LZ-String content", () => {
    const input = JSON.stringify({ title: "SystemForge", values: [1, 2, 3] });

    expect(
      decompressUriComponentBounded(
        compressToEncodedURIComponent(input),
        MAX_DECOMPRESSED_SHARE_LENGTH,
      ),
    ).toBe(input);
  });

  it("matches the encoder across deterministic varied strings", () => {
    let state = 0x51f15e;
    const alphabet = "abcXYZ0123 {}[],:-_/\\\n\té中λ";
    for (let sample = 0; sample < 64; sample += 1) {
      let input = "";
      const length = sample * 7;
      for (let index = 0; index < length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        input += alphabet[state % alphabet.length];
      }
      if (!input) input = "empty-case-sentinel";
      expect(
        decompressUriComponentBounded(
          compressToEncodedURIComponent(input),
          MAX_DECOMPRESSED_SHARE_LENGTH,
        ),
      ).toBe(input);
    }
  });

  it("rejects a compressed expansion before allocating its complete output", () => {
    const expanded = "A".repeat(MAX_DECOMPRESSED_SHARE_LENGTH + 1);
    const compressed = compressToEncodedURIComponent(expanded);

    expect(compressed.length).toBeLessThan(10_000);
    expect(
      decompressUriComponentBounded(compressed, MAX_DECOMPRESSED_SHARE_LENGTH),
    ).toBeNull();
  });

  it("rejects malformed alphabet and truncated streams", () => {
    expect(decompressUriComponentBounded("%%%", 1_000)).toBeNull();
    const compressed = compressToEncodedURIComponent("bounded payload");
    expect(
      decompressUriComponentBounded(compressed.slice(0, -1), 1_000),
    ).toBeNull();
  });
});
