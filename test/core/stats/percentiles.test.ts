import { describe, expect, it } from 'vitest';
import { percentile } from '../../../src/core/stats/percentiles.js';

/** Nearest rank: the value at rank ⌈q × n⌉ (at least 1) of the sorted values. Never interpolates. */

describe('percentile (nearest rank)', () => {
  const ten = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5]; // 1..10, unsorted

  it('p50 and p95 of 1..10: ranks 5 and 10', () => {
    expect(percentile(ten, 0.5)).toBe(5);
    expect(percentile(ten, 0.95)).toBe(10);
  });

  it('p95 of 1..20 is rank 19, not an interpolated 19.05', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => 20 - i);
    expect(percentile(twenty, 0.95)).toBe(19);
    expect(percentile(twenty, 0.5)).toBe(10);
  });

  it('an even count takes the lower middle for p50 (no averaging)', () => {
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
  });

  it('edges: q = 0 is the minimum, q = 1 the maximum, one value is every percentile', () => {
    expect(percentile(ten, 0)).toBe(1);
    expect(percentile(ten, 1)).toBe(10);
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 1)).toBe(42);
  });

  it('a value just past a rank boundary moves to the next rank', () => {
    // 0.51 × 10 = 5.1 → rank 6.
    expect(percentile(ten, 0.51)).toBe(6);
  });

  it('null for no values', () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  it('does not reorder its input', () => {
    const v = [3, 1, 2];
    percentile(v, 0.5);
    expect(v).toEqual([3, 1, 2]);
  });

  it.each([-0.1, 1.1, Number.NaN])('refuses q = %d', (q) => {
    expect(() => percentile([1, 2], q)).toThrow(RangeError);
  });
});
