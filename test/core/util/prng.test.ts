import { describe, expect, it } from 'vitest';
import { createPrng, nextBelow, nextU32 } from '../../../src/core/util/prng.js';

/** Independent reference sfc32 (bryc's `| 0` formulation) to cross-check ours. */
function referenceSfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
}

describe('prng (sfc32)', () => {
  it('matches a reference sfc32 after the documented seeding', () => {
    const ref = referenceSfc32(0x9e3779b9, 0x243f6a88, 0xb7e15162, 42);
    for (let i = 0; i < 15; i++) ref();
    const state = createPrng(42);
    for (let i = 0; i < 100; i++) expect(nextU32(state)).toBe(ref());
  });

  it('produces a known sequence for seed 1', () => {
    const state = createPrng(1);
    const seq = Array.from({ length: 5 }, () => nextU32(state));
    expect(seq).toEqual(KNOWN_SEED_1);
  });

  it('only produces u32 integers and differs between seeds', () => {
    const a = createPrng(1);
    const b = createPrng(2);
    let same = 0;
    for (let i = 0; i < 1000; i++) {
      const x = nextU32(a);
      const y = nextU32(b);
      expect(Number.isInteger(x) && x >= 0 && x <= 0xffffffff).toBe(true);
      if (x === y) same++;
    }
    expect(same).toBeLessThan(5);
  });

  it('nextBelow stays in range and covers it', () => {
    const state = createPrng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const v = nextBelow(state, 11);
      expect(v >= 0 && v < 11 && Number.isInteger(v)).toBe(true);
      seen.add(v);
    }
    expect(seen.size).toBe(11);
  });
});

const KNOWN_SEED_1 = [473542192, 3964317691, 2295682031, 2113742504, 3256742822];
