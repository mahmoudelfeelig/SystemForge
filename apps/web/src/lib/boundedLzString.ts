const URI_SAFE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$";

const URI_SAFE_VALUES = new Map(
  [...URI_SAFE_ALPHABET].map((character, index) => [character, index]),
);

class BitReader {
  private value: number;
  private position = 32;
  private index = 1;

  constructor(private readonly input: string) {
    this.value = URI_SAFE_VALUES.get(input[0] ?? "") ?? -1;
  }

  read(bitCount: number): number | null {
    if (this.value < 0) return null;
    let bits = 0;
    let power = 1;
    const maximum = 2 ** bitCount;
    while (power !== maximum) {
      const bit = this.value & this.position;
      this.position >>= 1;
      if (this.position === 0) {
        this.position = 32;
        if (this.index >= this.input.length) return null;
        this.value = URI_SAFE_VALUES.get(this.input[this.index++] ?? "") ?? -1;
        if (this.value < 0) return null;
      }
      if (bit > 0) bits += power;
      power <<= 1;
    }
    return bits;
  }
}

/**
 * Decodes the URI-safe LZ-String representation while bounding both emitted
 * output and retained dictionary text. This preserves sf2 migration without
 * allocating attacker-selected decompressed strings before checking a limit.
 */
export function decompressUriComponentBounded(
  input: string,
  maximumOutputLength: number,
): string | null {
  if (!input || maximumOutputLength < 1) return null;
  const normalized = input.replaceAll(" ", "+");
  const reader = new BitReader(normalized);
  const dictionary: string[] = ["", "", ""];
  let dictionaryTextLength = 0;
  let enlargeIn = 4;
  let dictionarySize = 4;
  let bitCount = 3;
  const initialType = reader.read(2);
  if (initialType === null) return null;
  if (initialType === 2) return "";
  if (initialType !== 0 && initialType !== 1) return null;
  const initialCharacterCode = reader.read(initialType === 0 ? 8 : 16);
  if (initialCharacterCode === null) return null;
  let previous = String.fromCharCode(initialCharacterCode);
  dictionary[3] = previous;
  dictionaryTextLength += previous.length;
  const output = [previous];
  let outputLength = previous.length;
  if (outputLength > maximumOutputLength) return null;

  while (true) {
    const rawCode = reader.read(bitCount);
    if (rawCode === null) return null;
    let code = rawCode;
    if (code === 0 || code === 1) {
      const characterCode = reader.read(code === 0 ? 8 : 16);
      if (characterCode === null) return null;
      const character = String.fromCharCode(characterCode);
      dictionary[dictionarySize] = character;
      dictionaryTextLength += character.length;
      code = dictionarySize;
      dictionarySize += 1;
      enlargeIn -= 1;
    } else if (code === 2) {
      return output.join("");
    }

    if (enlargeIn === 0) {
      enlargeIn = 2 ** bitCount;
      bitCount += 1;
    }

    let entry = dictionary[code];
    if (entry === undefined) {
      if (code !== dictionarySize) return null;
      entry = previous + previous.charAt(0);
    }
    if (entry.length > maximumOutputLength - outputLength) return null;
    output.push(entry);
    outputLength += entry.length;

    const dictionaryEntry = previous + entry.charAt(0);
    if (dictionaryEntry.length > maximumOutputLength * 2 - dictionaryTextLength)
      return null;
    dictionary[dictionarySize] = dictionaryEntry;
    dictionaryTextLength += dictionaryEntry.length;
    dictionarySize += 1;
    enlargeIn -= 1;
    previous = entry;

    if (enlargeIn === 0) {
      enlargeIn = 2 ** bitCount;
      bitCount += 1;
    }
  }
}
