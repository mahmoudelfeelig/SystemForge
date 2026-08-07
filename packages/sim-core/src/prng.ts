export class DeterministicRandom {
  readonly #initialSeed: number;
  #state: number;

  constructor(seed: number) {
    const normalized = seed >>> 0;
    this.#initialSeed = normalized || 0x9e3779b9;
    this.#state = this.#initialSeed;
  }

  get seed(): number {
    return this.#initialSeed;
  }

  next(): number {
    let state = this.#state;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    this.#state = state >>> 0;
    return this.#state / 0x1_0000_0000;
  }

  between(minimum: number, maximum: number): number {
    return minimum + (maximum - minimum) * this.next();
  }
}
