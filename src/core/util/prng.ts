/** sfc32 state: four u32 words. Plain data, so it can live inside a hashed, cloned game state. */
export interface PrngState {
  a: number;
  b: number;
  c: number;
  d: number;
}

/**
 * sfc32 (Chris Doty-Humphrey's Small Fast Counter), all u32 math via `>>> 0`.
 * Seeding: fixed constants in a/b/c, the seed in d, then 15 outputs discarded.
 */
export function createPrng(seed: number): PrngState {
  const state: PrngState = { a: 0x9e3779b9, b: 0x243f6a88, c: 0xb7e15162, d: seed >>> 0 };
  for (let i = 0; i < 15; i++) nextU32(state);
  return state;
}

/** Next u32 in [0, 2^32). Mutates `state`. */
export function nextU32(state: PrngState): number {
  const { a, b, c, d } = state;
  const t = (((a + b) >>> 0) + d) >>> 0;
  state.d = (d + 1) >>> 0;
  state.a = (b ^ (b >>> 9)) >>> 0;
  state.b = (c + (c << 3)) >>> 0;
  const rotated = ((c << 21) | (c >>> 11)) >>> 0;
  state.c = (rotated + t) >>> 0;
  return t;
}

/** Unbiased integer in [0, n) for 1 <= n <= 2^32 (rejection sampling). Mutates `state`. */
export function nextBelow(state: PrngState, n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 0x100000000) throw new RangeError(`bad n: ${String(n)}`);
  const limit = 0x100000000 - (0x100000000 % n);
  for (;;) {
    const v = nextU32(state);
    if (v < limit) return v % n;
  }
}
